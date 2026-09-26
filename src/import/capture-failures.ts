import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../bootstrap/workspace-resolution.js";

/**
 * Hook captures that failed, kept so a failure is never silent: a hook must exit quietly so it
 * never breaks the host, and this log is where the failure goes instead (status and the next
 * session start report it). It lives in `$MEMCHOR_HOME`, not in a workspace database, because
 * the failure may be that no database could be opened. When even the home is unusable, the
 * hook's stderr is all that is left.
 */

export interface CaptureFailure {
  at: string;
  host: string;
  /** The hook that failed, e.g. `stop`. */
  event: string;
  /** An error code, or `not_a_transcript` when the host named a path Memchor does not import. */
  code: string;
  message: string;
}

const FILE = "capture-failures.jsonl";
/** Past this the log is cut to its newest half; failures are rare, so this is many of them. */
const MAX_BYTES = 64 * 1024;

/** Appends one failure. Never throws: it runs on the path that is already failing. */
export function recordCaptureFailure(home: string, failure: Omit<CaptureFailure, "at">): boolean {
  try {
    mkdirSync(home, { recursive: true });
    const path = join(home, FILE);
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...failure })}\n`);
    if (statSync(path).size > MAX_BYTES) {
      const text = readFileSync(path, "utf8");
      const keep = text.slice(text.indexOf("\n", text.length - MAX_BYTES / 2) + 1);
      writeFileAtomic(path, keep);
    }
    return true;
  } catch {
    return false;
  }
}

/** The newest failures, oldest first; an unreadable or missing log is no failures. */
export function recentCaptureFailures(home: string, limit = 5): CaptureFailure[] {
  let text: string;
  try {
    text = readFileSync(join(home, FILE), "utf8");
  } catch {
    return [];
  }
  const failures: CaptureFailure[] = [];
  for (const line of text.split("\n")) {
    try {
      const parsed = JSON.parse(line) as Partial<CaptureFailure>;
      if (typeof parsed.at === "string" && typeof parsed.host === "string" && typeof parsed.event === "string" && typeof parsed.code === "string" && typeof parsed.message === "string") {
        failures.push({ at: parsed.at, host: parsed.host, event: parsed.event, code: parsed.code, message: parsed.message });
      }
    } catch {
      // A torn or foreign line is skipped, never fatal.
    }
  }
  return failures.slice(-limit);
}
