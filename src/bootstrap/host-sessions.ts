import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Which host session made a tool call, for hosts whose MCP server cannot tell by itself. Claude
 * Code starts one MCP server per process and names the session only in its environment, which
 * goes stale after `/clear` starts a new session in the same process. Its PreToolUse hook sees
 * the current `session_id` and the `tool_use_id`, and the MCP call carries the same id in
 * `_meta`; the hook notes the pair here and the MCP server looks it up.
 *
 * It lives in `$MEMCHOR_HOME`, like the hook-failure log, because the hook runs before any
 * workspace is resolved and must stay cheap. Hooks append without a lock (one small write each)
 * and a full log is rotated by an atomic rename; a lookup reads both files.
 */

const FILE = "tool-sessions.jsonl";
const ROTATED = "tool-sessions.1.jsonl";
/** Many calls' worth; the MCP server looks a call up moments after its hook noted it. */
const MAX_BYTES = 64 * 1024;

interface Entry {
  host: string;
  toolUseId: string;
  hostSessionId: string;
}

/** Notes which session made a call. Never throws: a hook must not fail over this. */
export function noteToolCallSession(home: string, entry: Entry): void {
  try {
    mkdirSync(home, { recursive: true });
    const path = join(home, FILE);
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    if (statSync(path).size > MAX_BYTES) renameSync(path, join(home, ROTATED));
  } catch {
    // Without the note, the MCP server keeps the session it had.
  }
}

/** The session that made a call, or undefined when no hook noted it. */
export function toolCallSession(home: string, host: string, toolUseId: string): string | undefined {
  for (const name of [FILE, ROTATED]) {
    let text: string;
    try {
      text = readFileSync(join(home, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").reverse()) {
      if (!line.includes(toolUseId)) continue;
      try {
        const entry = JSON.parse(line) as Partial<Entry>;
        if (entry.host === host && entry.toolUseId === toolUseId && typeof entry.hostSessionId === "string") return entry.hostSessionId;
      } catch {
        // A torn line: skip it.
      }
    }
  }
  return undefined;
}
