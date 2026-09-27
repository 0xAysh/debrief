import { parseArgs } from "node:util";
import { z } from "zod";
import { hostDescriptor } from "../hosts.js";
import { recordCaptureFailure } from "../import/capture-failures.js";
import { type Memory, openMemory } from "../memory.js";
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
  source: z.string().optional(),
  hook_event_name: z.literal("SessionStart"),
});

const QUIET: HookOutcome = { stdout: "", stderr: "" };

export function runHook(run: HookRun): HookOutcome {
  let host = "unknown";
  let event = "unknown";
  const fail = (code: string, message: string): HookOutcome => {
    recordCaptureFailure(run.home, { host, event, code, message });
    return { stdout: "", stderr: `memchor hook ${event}: ${code}: ${message}\n` };
  };
  try {
    const { values, positionals } = parseArgs({ args: run.args, options: { host: { type: "string" }, import: { type: "boolean" } }, allowPositionals: true, strict: true });
    event = positionals[0] ?? "unknown";
    host = values.host ?? "unknown";
    const descriptor = hostDescriptor(values.host);
    if (descriptor?.transcripts == null) return fail("invalid_input", `--host must name a host whose transcripts Memchor imports (got ${values.host ?? "none"})`);
    if (positionals.length !== 1) return fail("invalid_input", `unknown hook: ${run.args.join(" ")}`);
    const payload = (schema: z.ZodType): unknown => {
      try {
        return schema.parse(JSON.parse(run.stdin));
      } catch {
        return null;
      }
    };

    if (event === "stop" && values.import === true) {
      const stop = payload(StopPayload) as z.infer<typeof StopPayload> | null;
      if (stop === null) return fail("invalid_input", "the hook payload is not a Stop payload with session_id and transcript_path");
      return withMemory(run, host, (memory) => {
        const captured = memory.captureTurn({ transcriptPath: stop.transcript_path });
        if (captured.state === "failed") return fail(captured.problem?.code ?? "internal", captured.problem?.message ?? "capture failed");
        if (captured.reason === "not_a_transcript") return fail("not_a_transcript", `${stop.transcript_path} is not a transcript Memchor imports for ${host}`);
        return QUIET;
      });
    }
    if (event === "session-start" && values.import !== true) {
      if (descriptor.hooks === null) return fail("invalid_input", `session-start output for ${host} is not supported yet`);
      const output = descriptor.hooks;
      const start = payload(SessionStartPayload) as z.infer<typeof SessionStartPayload> | null;
      if (start === null) return fail("invalid_input", "the hook payload is not a SessionStart payload with session_id");
      return withMemory(run, host, (memory) => ({ stdout: output.sessionStart(memory.sessionStart({ hostSessionId: start.session_id, ...(start.source === undefined ? {} : { source: start.source }) })), stderr: "" }));
    }
    return fail("invalid_input", `unknown hook: ${run.args.join(" ")}`);
  } catch (error) {
    return fail(error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "internal", error instanceof Error ? error.message : String(error));
  }
}

function withMemory(run: HookRun, host: string, use: (memory: Memory) => HookOutcome): HookOutcome {
  const memory = openMemory({ cwd: run.cwd, host, home: run.home });
  try {
    return use(memory);
  } finally {
    memory.close();
  }
}
