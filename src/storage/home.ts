import { lstatSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Debrief's data home as a whole (`$DEBRIEF_HOME` or `~/.debrief`), for `debrief delete-data`.
 *
 * Deletion removes only the entries Debrief writes there, never the directory's other contents:
 * `DEBRIEF_HOME` is user-set, and a mistaken value (the home directory, a project) must not
 * cost the user their files. The directory itself goes only when nothing else is left in it, and
 * never when the home is a symbolic link: the data behind the link goes, the link and its
 * directory stay.
 */

/**
 * Everything Debrief writes at the top of its home: the per-repository databases, the global
 * database, the registry, the import choice and its lock, the hooks' run notes and logs, and the
 * temporary files their atomic writes leave for a moment.
 */
const OWNED = [
  /^workspaces$/,
  /^global\.sqlite(-wal|-shm|-journal)?$/,
  /^registry\.json(\.\d+\.[0-9a-f]+\.tmp)?$/,
  /^consent\.json(\.lock(\..+\.tmp)?)?$/,
  /^hook-runs$/,
  /^(hook-failures|tool-sessions)(\.1)?\.jsonl$/,
];

export interface HomeContents {
  path: string;
  /** Debrief's entries, by name; empty when there is nothing to delete. */
  owned: string[];
  /** Everything else in the directory, left alone. */
  foreign: string[];
  /** Bytes in Debrief's entries (symbolic links counted as themselves, never followed). */
  bytes: number;
  /** Repositories with stored memory. */
  workspaces: number;
}

export function describeHome(home: string): HomeContents {
  let names: string[];
  try {
    names = statSync(home).isDirectory() ? readdirSync(home).sort() : [];
  } catch {
    names = [];
  }
  const owned = names.filter((name) => OWNED.some((pattern) => pattern.test(name)));
  let workspaces = 0;
  try {
    workspaces = readdirSync(join(home, "workspaces"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  } catch {
    // No workspaces directory: no repository has memory yet.
  }
  return { path: home, owned, foreign: names.filter((name) => !owned.includes(name)), bytes: owned.reduce((sum, name) => sum + size(join(home, name)), 0), workspaces };
}

/**
 * Deletes Debrief's entries, then the directory if that left it empty. Returns what was kept, and
 * any of Debrief's entries that are there again afterwards: a session still running wrote them.
 */
export function deleteHome(home: string): { kept: string[]; rewritten: string[] } {
  for (const name of describeHome(home).owned) rmSync(join(home, name), { recursive: true, force: true });
  const after = describeHome(home);
  if (after.owned.length === 0 && after.foreign.length === 0 && lstatSync(home, { throwIfNoEntry: false })?.isDirectory() === true) {
    try {
      rmdirSync(home);
    } catch {
      // Written to since it was listed: reported below as it is now.
    }
  }
  const left = describeHome(home);
  return { kept: left.foreign, rewritten: left.owned };
}

function size(path: string): number {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return 0;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, name) => sum + size(join(path, name)), 0);
}
