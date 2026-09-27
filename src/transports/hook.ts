import { parseArgs } from "node:util";
import { z } from "zod";
import { MemchorError } from "../errors.js";
import { HOOK_HOSTS, hostDescriptor } from "../hosts.js";
import { recordHookFailure } from "../import/hook-failures.js";
import { recordHookRun } from "../import/hook-runs.js";
import { type Memory, openMemory } from "../memory.js";
import { unreadableSessionStart, unreadableSubagentStart } from "../retrieval/session-context.js";
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
  stop_hook_active: z.boolean().default(false),
});
const SessionStartPayload = z.looseObject({
  session_id: z.string().min(1).max(LIMITS.hostSessionIdChars),
  hook_event_name: z.literal("SessionStart"),
});
const SubagentStartPayload = z.looseObject({
  // The parent's session: a sub-agent runs inside it.
  session_id: z.string().min(1).max(LIMITS.hostSessionIdChars),
  hook_event_name: z.literal("SubagentStart"),
});
const UserPromptSubmitPayload = z.looseObject({
  prompt: z.string(),
  hook_event_name: z.literal("UserPromptSubmit"),
});
const PreToolUsePayload = z.looseObject({
  tool_name: z.string().min(1),
  tool_input: z.unknown(),
  // Only for noting the call's session: an unusable one is dropped, never a reason to refuse the payload.
  tool_use_id: z.string().min(1).max(LIMITS.hostSessionIdChars).optional().catch(undefined),
  session_id: z.string().min(1).max(LIMITS.hostSessionIdChars).optional().catch(undefined),
  hook_event_name: z.literal("PreToolUse"),
});

const QUIET: HookOutcome = { stdout: "", stderr: "" };

export function runHook(run: HookRun): HookOutcome {
  let host = "unknown";
  let event = "unknown";
  // How the run ended, for `memchor status`: the code of the failure it recorded, if any.
  let failureCode: string | null = null;
  // Failures before the memory module can decide anything (arguments, payload, a bug) are recorded here.
  const fail = (code: string, message: string, stdout = ""): HookOutcome => {
    failureCode = code;
    recordHookFailure(run.home, { host, event, cwd: run.cwd, code, message });
    return { stdout, stderr: `memchor hook ${event}: ${code}: ${message}\n` };
  };
  // What a start hook prints when it fails unexpectedly: that memory was not loaded, never that there is none.
  let unreadable: ((code: string) => string) | null = null;
  try {
    const { values, positionals } = parseArgs({ args: run.args, options: { host: { type: "string" } }, allowPositionals: true, strict: true });
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

    if (event === "stop") {
      const stop = payload(StopPayload);
      if (stop === null) return fail("invalid_input", "the hook payload is not a Stop payload with session_id and transcript_path");
      const ended = withMemory(run, host, (memory) => memory.endTurn({ transcriptPath: stop.transcript_path, stopHookActive: stop.stop_hook_active }));
      failureCode = ended.failure?.code ?? ended.nudgeFailure?.code ?? null;
      return { stdout: hooks.stop(ended), stderr: ended.failure === null ? "" : `memchor hook stop: ${ended.failure.code}: ${ended.failure.message}\n` };
    }
    if (event === "session-start") {
      unreadable = (code) => hooks.sessionStart(unreadableSessionStart(code));
      const start = payload(SessionStartPayload);
      if (start === null) return fail("invalid_input", "the hook payload is not a SessionStart payload with session_id");
      const rendered = withMemory(run, host, (memory) => memory.sessionStart({ hostSessionId: start.session_id }));
      failureCode = rendered?.failure ?? null;
      return rendered === null ? QUIET : { stdout: hooks.sessionStart(rendered), stderr: "" };
    }
    if (event === "subagent-start") {
      unreadable = (code) => hooks.subagentStart(unreadableSubagentStart(code));
      const start = payload(SubagentStartPayload);
      if (start === null) return fail("invalid_input", "the hook payload is not a SubagentStart payload with session_id");
      const rendered = withMemory(run, host, (memory) => memory.subagentStart({ hostSessionId: start.session_id }));
      failureCode = rendered?.failure ?? null;
      return rendered === null ? QUIET : { stdout: hooks.subagentStart(rendered), stderr: "" };
    }
    if (event === "user-prompt-submit") {
      const submitted = payload(UserPromptSubmitPayload);
      if (submitted === null) return fail("invalid_input", "the hook payload is not a UserPromptSubmit payload with prompt");
      const hint = withMemory(run, host, (memory) => memory.promptHint({ prompt: submitted.prompt }));
      return hint === null ? QUIET : { stdout: hooks.promptHint(hint), stderr: "" };
    }
    if (event === "pre-tool-use") {
      const call = payload(PreToolUsePayload);
      if (call === null) return fail("invalid_input", "the hook payload is not a PreToolUse payload with tool_name");
      const approval = withMemory(run, host, (memory) => memory.approveTool({
          tool: call.tool_name,
          input: call.tool_input,
          ...(call.tool_use_id === undefined || call.session_id === undefined ? {} : { call: { toolUseId: call.tool_use_id, hostSessionId: call.session_id } }),
        }));
      return approval === null ? QUIET : { stdout: hooks.allowTool(approval.notice), stderr: "" };
    }
    return fail("invalid_input", `unknown hook: ${run.args.join(" ")}`);
  } catch (error) {
    const code = error instanceof MemchorError ? error.code : "internal";
    const message = error instanceof Error ? error.message : String(error);
    return fail(code, message, unreadable === null ? "" : unreadable(code));
  } finally {
    recordHookRun(run.home, { host, event, cwd: run.cwd, outcome: failureCode === null ? "ok" : "failed", code: failureCode });
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
