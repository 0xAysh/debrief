import { existsSync } from "node:fs";
import { locateWorkspace, registeredWorkspaces } from "../bootstrap/workspace-resolution.js";
import { DebriefError } from "../errors.js";
import { openWorkspaceDatabase, unappliedLedgerEntries } from "../integrity/lifecycle.js";
import { type Db, openReadOnly } from "../storage/database.js";
import { collect, hasTable, merge, type ReportWorkspace } from "./collect.js";
import { day, renderReport } from "./render.js";
import { review } from "./review.js";

/**
 * `debrief report [--since 7d] [--all] [--review]`: whether Debrief helped, from this machine's
 * data alone (#69). The report reads without migrating; it writes only when the lifecycle ledger
 * holds a forget or private mark the database lacks (a restored older copy), which it applies
 * first so an erased query is never shown. `--review` writes ratings, so it opens the database
 * for use (migrated and up to date).
 */

export interface ReportOptions {
  cwd: string;
  home: string;
  since: string;
  all: boolean;
  review: boolean;
  stdin: NodeJS.ReadableStream;
  write: (text: string) => void;
}

const CALL_LOG_VERSION = 8;

/** `7d`, `24h` or a date (`2026-09-22`): the start of the window, or null when unreadable. */
export function parseSince(since: string, now: Date): Date | null {
  const relative = /^(\d{1,4})([dh])$/.exec(since);
  if (relative !== null) return new Date(now.getTime() - Number(relative[1]) * (relative[2] === "d" ? 86_400_000 : 3_600_000));
  if (!/^\d{4}-\d{2}-\d{2}/.test(since)) return null;
  const date = new Date(since);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function runReport(options: ReportOptions): Promise<number> {
  const now = new Date();
  const from = parseSince(options.since, now);
  if (from === null) throw new DebriefError("invalid_input", `--since must look like 7d, 24h or 2026-09-22 (got ${options.since}).`);
  const since = from.toISOString();
  const workspaces = options.all ? registeredWorkspaces(options.home) : [current(options.cwd, options.home)];
  const window = `${day(from)} → ${day(now)}`;

  const opened: { workspace: ReportWorkspace; db: Db }[] = [];
  try {
    for (const workspace of workspaces) {
      const db = options.review ? openForReview(workspace.dbPath) : openForReport(workspace.dbPath);
      if (db !== null) opened.push({ workspace, db });
    }
    if (opened.length === 0) {
      options.write(options.all ? "No Debrief data yet.\n" : `No Debrief data for ${workspaces[0]?.label ?? "this repository"} yet.\n`);
      return 0;
    }
    if (options.review) return await review(opened.map(({ workspace, db }) => ({ label: workspace.label, db })), since, window, options.stdin, options.write);
    const data = merge(opened.map(({ workspace, db }) => collect(db, workspace, since, options.home)));
    data.labels = workspaces.map((workspace) => workspace.label);
    options.write(renderReport(data, { from, to: now, since: options.since }));
    return 0;
  } finally {
    for (const { db } of opened) db.close();
  }
}

function current(cwd: string, home: string): ReportWorkspace {
  const location = locateWorkspace(cwd, home);
  return { label: location.label, repositoryKeys: [location.repositoryKey, ...location.formerRepositoryKeys], dbPath: location.dbPath };
}

/** Read only, unless a restored copy lacks a ledger change; null without a call log (no database, or one older than #69). */
function openForReport(path: string): Db | null {
  if (!existsSync(path)) return null;
  const db = openReadOnly(path);
  if (db === null) return null;
  if ((db.pragma("user_version", { simple: true }) as number) < CALL_LOG_VERSION || !hasTable(db, "call_log")) {
    db.close();
    return null;
  }
  if (unappliedLedgerEntries(db).length === 0) return db;
  db.close();
  return openWorkspaceDatabase(path);
}

function openForReview(path: string): Db | null {
  if (!existsSync(path)) return null;
  return openWorkspaceDatabase(path);
}
