import { sep } from "node:path";
import { homeLog } from "../storage/home-log.js";

/**
 * Host hooks that failed, kept so a failure is never silent: a hook must exit quietly so it
 * never breaks the host, and this log is where the failure goes instead (status and the next
 * session start report it). It lives in `$DEBRIEF_HOME`, not in a workspace database, because
 * the failure may be that no database could be opened. When even the home is unusable, the
 * hook's stderr is all that is left.
 */

export interface HookFailure {
  at: string;
  host: string;
  /** The hook that failed, e.g. `stop` or `session-start`. */
  event: string;
  /** Where the host ran the hook, so a repository's session start reports only its own failures. */
  cwd: string;
  /** An error code, or `not_a_transcript` when the host named a path Debrief does not import. */
  code: string;
  message: string;
}

/** Past this the log is rotated (replacing the previous); failures are rare, so this is many of them. */
const LOG = homeLog("hook-failures", 32 * 1024);

/** Appends one failure. Never throws: it runs on the path that is already failing. */
export function recordHookFailure(home: string, failure: Omit<HookFailure, "at">): boolean {
  return LOG.append(home, { at: new Date().toISOString(), ...failure });
}

/** How many of the newest failures are reported. */
const RECENT = 5;

/** The newest failures (only those run inside `within`, when given), oldest first; an unreadable or missing log is no failures. */
export function recentHookFailures(home: string, options: { within?: string } = {}): HookFailure[] {
  const { within } = options;
  const failures: HookFailure[] = [];
  for (const line of LOG.lines(home)) {
    try {
      const parsed = JSON.parse(line) as Partial<HookFailure>;
      if (typeof parsed.at === "string" && typeof parsed.host === "string" && typeof parsed.event === "string" && typeof parsed.cwd === "string" && typeof parsed.code === "string" && typeof parsed.message === "string") {
        failures.push({ at: parsed.at, host: parsed.host, event: parsed.event, cwd: parsed.cwd, code: parsed.code, message: parsed.message });
      }
    } catch {
      // A torn or foreign line is skipped, never fatal.
    }
  }
  const inside = within === undefined ? failures : failures.filter((f) => f.cwd === within || f.cwd.startsWith(within + sep));
  return inside.slice(-RECENT);
}
