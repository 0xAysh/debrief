import { parseArgs } from "node:util";
import { z } from "zod";
import { MemchorError } from "../errors.js";
import { HOOK_HOSTS, type HookOutput, hostDescriptor } from "../hosts.js";
import { recordHookFailure } from "../import/hook-failures.js";
import { type Memory, openMemory } from "../memory.js";
import { unreadableSessionStart } from "../retrieval/session-context.js";
import { LIMITS } from "../schemas.js";

/**
 * `memchor hook <event>`: what a host runs at its lifecycle events. A shallow transport, like
 * the MCP server: it parses the host's payload, calls the memory module, and prints what the
 * host should see. Scope, consent and import rules stay in the module.
 *
 * A hook must never break the host. Whatever happens it exits 0 quickly, prints nothing the
 * host would misread, and puts any failure where it is not lost: the capture-failure log
 * (reported by status and the next session start), or stderr when even that is unusable.
 */

export interface HookRun {
  args: string[];
  stdin: string;
  cwd: string;
  home: string;
}

export interface HookOutcome {
  stdout: string;
  stderr: string;
}

/** The fields Memchor reads from each hook payload; hosts send more, and newer builds add fields. */
const StopPayload = z.looseObject({
  session_id: z.string().min(1),
  transcript_path: z.string().min(1),
  hook_event_name: z.literal("Stop"),
});
const SessionStartPayload = z.looseObject({
  session_id: z.string().min(1).max(LIMITS.hostSessionIdChars),
  hook_event_name: z.literal("SessionStart"),
});
const UserPromptSubmitPayload = z.looseObject({
  prompt: z.string(),
  hook_event_name: z.literal("UserPromptSubmit"),
});

const QUIET: HookOutcome = { stdout: "", stderr: "" };

export function runHook(run: HookRun): HookOutcome {
  let host = "unknown";
  let event = "unknown";
  // Failures before the memory module can decide anything (arguments, payload, a bug) are recorded here.
  const fail = (code: string, message: string, stdout = ""): HookOutcome => {
    recordHookFailure(run.home, { host, event, cwd: run.cwd, code, message });
    return { stdout, stderr: `memchor hook ${event}: ${code}: ${message}\n` };
  };
  let output: HookOutput | null = null;
  try {
    const { values, positionals } = parseArgs({ args: run.args, options: { host: { type: "string" }, import: { type: "boolean" } }, allowPositionals: true, strict: true });
    event = positionals[0] ?? "unknown";
    host = values.host ?? "unknown";
    const hooks = hostDescriptor(values.host)?.hooks ?? null;
    if (hooks === null) return fail("invalid_input", `--host must be one of ${HOOK_HOSTS.join(", ")} (got ${values.host ?? "none"})`);
    if (positionals.length !== 1) return fail("invalid_input", `unknown hook: ${run.args.join(" ")}`);
    const payload = <T>(schema: z.ZodType<T>): T | null => {
      try {
        return schema.parse(JSON.parse(run.stdin));
      } catch {
        return null;
      }
    };

    if (event === "stop" && values.import === true) {
      const stop = payload(StopPayload);
      if (stop === null) return fail("invalid_input", "the hook payload is not a Stop payload with session_id and transcript_path");
      const captured = withMemory(run, host, (memory) => memory.captureTurn({ transcriptPath: stop.transcript_path }));
      return captured.failure === null ? QUIET : { stdout: "", stderr: `memchor hook stop: ${captured.failure.code}: ${captured.failure.message}\n` };
    }
    if (event === "session-start" && values.import !== true) {
      output = hooks;
      const start = payload(SessionStartPayload);
      if (start === null) return fail("invalid_input", "the hook payload is not a SessionStart payload with session_id");
      const rendered = withMemory(run, host, (memory) => memory.sessionStart({ hostSessionId: start.session_id }));
      return rendered === null ? QUIET : { stdout: hooks.sessionStart(rendered), stderr: "" };
    }
    if (event === "user-prompt-submit" && values.import !== true) {
      const submitted = payload(UserPromptSubmitPayload);
      if (submitted === null) return fail("invalid_input", "the hook payload is not a UserPromptSubmit payload with prompt");
      const hint = withMemory(run, host, (memory) => memory.promptHint({ prompt: submitted.prompt }));
      return hint === null ? QUIET : { stdout: hooks.promptHint(hint), stderr: "" };
    }
    return fail("invalid_input", `unknown hook: ${run.args.join(" ")}`);
  } catch (error) {
    const code = error instanceof MemchorError ? error.code : "internal";
    const message = error instanceof Error ? error.message : String(error);
    // A session start that failed still tells the model memory was not loaded, never that there is none.
    return fail(code, message, output === null ? "" : output.sessionStart(unreadableSessionStart(code)));
  }
}

function withMemory<T>(run: HookRun, host: string, use: (memory: Memory) => T): T {
  const memory = openMemory({ cwd: run.cwd, host, home: run.home });
  try {
    return use(memory);
  } finally {
    memory.close();
  }
}
