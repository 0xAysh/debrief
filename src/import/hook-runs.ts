import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * When each host hook last ran, where, and how it ended, so `memchor status` can tell a hook that
 * works from one that fails or never fires. One small file per host and event in
 * `$MEMCHOR_HOME/hook-runs/`, replaced on every run: a hook pays one write, status one read per
 * hook, and nothing grows. Like the failure log it lives in the home, because the run may have
 * failed to open any database.
 */

export interface HookRun {
  host: string;
  /** The hook, e.g. `stop` or `session-start`. */
  event: string;
  at: string;
  cwd: string;
  /** ok: the hook did its work (or skipped it by rule) · failed: see `code` and the failure log. */
  outcome: "ok" | "failed";
  code: string | null;
}

const DIR = "hook-runs";

/** Notes this run, replacing the previous one. Never throws: it runs on every hook, failing or not. */
export function recordHookRun(home: string, run: Omit<HookRun, "at">): void {
  if (!/^[a-z0-9-]+$/.test(run.host) || !/^[a-z0-9-]+$/.test(run.event)) return;
  try {
    const dir = join(home, DIR);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${run.host}.${run.event}.json`);
    // Written aside and renamed, so a reader never sees half a file.
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ at: new Date().toISOString(), ...run }));
    renameSync(temp, path);
  } catch {
    // Unwritable home: the run goes unnoted, and the hook carries on.
  }
}

/** Each hook's last run, by host then event; a missing or unreadable entry is a hook that has not run. */
export function lastHookRuns(home: string): HookRun[] {
  let names: string[];
  try {
    names = readdirSync(join(home, DIR)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const runs: HookRun[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(home, DIR, name), "utf8")) as Partial<HookRun>;
      if (typeof parsed.host === "string" && typeof parsed.event === "string" && typeof parsed.at === "string" && typeof parsed.cwd === "string" && (parsed.outcome === "ok" || parsed.outcome === "failed")) {
        runs.push({ host: parsed.host, event: parsed.event, at: parsed.at, cwd: parsed.cwd, outcome: parsed.outcome, code: typeof parsed.code === "string" ? parsed.code : null });
      }
    } catch {
      // A foreign or unreadable file is skipped, never fatal.
    }
  }
  return runs;
}
