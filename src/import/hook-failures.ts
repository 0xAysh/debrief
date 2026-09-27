import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Host hooks that failed, kept so a failure is never silent: a hook must exit quietly so it
 * never breaks the host, and this log is where the failure goes instead (status and the next
 * session start report it). It lives in `$MEMCHOR_HOME`, not in a workspace database, because
 * the failure may be that no database could be opened. When even the home is unusable, the
 * hook's stderr is all that is left.
 *
 * Concurrent hooks append without a lock: each append is one small write, and a full log is
 * rotated by an atomic rename, so no line is lost to a trim racing another hook.
 */

export interface HookFailure {
  at: string;
  host: string;
  /** The hook that failed, e.g. `stop` or `session-start`. */
  event: string;
  /** Where the host ran the hook, so a repository's session start reports only its own failures. */
  cwd: string;
  /** An error code, or `not_a_transcript` when the host named a path Memchor does not import. */
  code: string;
  message: string;
}

const FILE = "hook-failures.jsonl";
const ROTATED = "hook-failures.1.jsonl";
/** Past this the log becomes the rotated one (replacing the previous); failures are rare, so this is many of them. */
const MAX_BYTES = 32 * 1024;

/** Appends one failure. Never throws: it runs on the path that is already failing. */
export function recordHookFailure(home: string, failure: Omit<HookFailure, "at">): boolean {
  try {
    mkdirSync(home, { recursive: true });
    const path = join(home, FILE);
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...failure })}\n`);
    if (statSync(path).size > MAX_BYTES) renameSync(path, join(home, ROTATED));
    return true;
  } catch {
    return false;
  }
}

/** The newest failures (only those run inside `within`, when given), oldest first; an unreadable or missing log is no failures. */
export function recentHookFailures(home: string, options: { limit?: number; within?: string } = {}): HookFailure[] {
  const { limit = 5, within } = options;
  const failures: HookFailure[] = [];
  for (const name of [ROTATED, FILE]) {
    let text: string;
    try {
      text = readFileSync(join(home, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      try {
        const parsed = JSON.parse(line) as Partial<HookFailure>;
        if (typeof parsed.at === "string" && typeof parsed.host === "string" && typeof parsed.event === "string" && typeof parsed.cwd === "string" && typeof parsed.code === "string" && typeof parsed.message === "string") {
          failures.push({ at: parsed.at, host: parsed.host, event: parsed.event, cwd: parsed.cwd, code: parsed.code, message: parsed.message });
        }
      } catch {
        // A torn or foreign line is skipped, never fatal.
      }
    }
  }
  const inside = within === undefined ? failures : failures.filter((f) => f.cwd === within || f.cwd.startsWith(within + sep));
  return inside.slice(-limit);
}
