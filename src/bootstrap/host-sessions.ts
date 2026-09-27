import { hostDescriptor } from "../hosts.js";
import { LIMITS } from "../schemas.js";
import { homeLog } from "../storage/home-log.js";

/**
 * Which host session an MCP server serves, from what each host gives it (src/hosts.ts).
 *
 * Codex names the session in every call's `_meta`. Claude Code starts one MCP server per process
 * and names the session only in its environment, which goes stale after `/clear` starts a new
 * session in the same process. Its PreToolUse hook sees the current `session_id` and the
 * `tool_use_id`, and the MCP call carries the same id in `_meta`: the hook notes the pair here and
 * the server looks it up. The notes live in `$DEBRIEF_HOME` because the hook runs before any
 * workspace is resolved and must stay cheap.
 */

/** A host's id for one tool call and the session making it. */
export interface ToolCall {
  toolUseId: string;
  hostSessionId: string;
}

/** Many calls' worth: the server looks a call up moments after its hook noted it. */
const NOTES = homeLog("tool-sessions", 64 * 1024);

/** Notes which session made a call. Never throws: a hook must not fail over this. */
export function noteToolCall(home: string, host: string, call: ToolCall): void {
  NOTES.append(home, { host, ...call });
}

/**
 * The session a `tools/call` names: the session id in its `_meta`, else the session the host's
 * hook noted for the call id in its `_meta`. Undefined when it names none (the server then keeps
 * the session it has).
 */
export function sessionOfCall(host: string | undefined, meta: Record<string, unknown> | undefined, home: string): string | undefined {
  const descriptor = hostDescriptor(host);
  if (host === undefined || descriptor === null) return undefined;
  const named = descriptor.sessionMetaKey === null ? undefined : validId(meta?.[descriptor.sessionMetaKey]);
  if (named !== undefined) return named;
  const toolUseId = descriptor.toolUseMetaKey === null ? undefined : validId(meta?.[descriptor.toolUseMetaKey]);
  return toolUseId === undefined ? undefined : notedSession(home, host, toolUseId);
}

/** The session the host named when it started the server (its environment); only a server's first session comes from here. */
export function sessionOfServer(host: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const key = hostDescriptor(host)?.sessionEnv ?? null;
  return key === null ? undefined : validId(env[key]);
}

function notedSession(home: string, host: string, toolUseId: string): string | undefined {
  for (const line of NOTES.lines(home).reverse()) {
    if (!line.includes(toolUseId)) continue;
    try {
      const note = JSON.parse(line) as Partial<ToolCall & { host: string }>;
      if (note.host === host && note.toolUseId === toolUseId) return validId(note.hostSessionId);
    } catch {
      // A torn line: skip it.
    }
  }
  return undefined;
}

/** An id longer than a host session id may be is ignored rather than cut: a prefix is a different identity. */
function validId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return id !== "" && id.length <= LIMITS.hostSessionIdChars ? id : undefined;
}
