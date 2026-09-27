import { type Db, prepared } from "../storage/database.js";
import { VISIBLE_SQL } from "./eligibility.js";

/**
 * What the last session did after the head checkpoint (or at all, when there is none), built
 * without a model from its imported transcript events. Session start shows it so a crashed or
 * killed session is not lost, and a stale checkpoint never looks like the whole story.
 */

export interface SessionDigest {
  host: string;
  /** When its last imported event happened. */
  endedAt: string;
  /** The last user prompts, oldest first. */
  prompts: string[];
  lastReply: string | null;
  /** Files its tool calls named, most recent first (paths only). */
  files: string[];
  /** Its last shell commands, oldest first, and whether each failed. */
  commands: { command: string; failed: boolean }[];
  /** Later-than-`since` sessions not shown (only the newest one is digested). */
  otherSessions: number;
  /** Every record the digest drew on, so a pack does not repeat them. */
  recordIds: string[];
}

const PROMPTS = 3;
const COMMANDS = 5;
const FILES = 10;
/** Enough rows to find the newest session's last turns without loading a whole history. */
const ROWS = 400;

interface Row {
  id: string;
  session_id: string | null;
  host: string;
  title: string | null;
  body: string;
  attribution: string;
  external_refs: string;
  created_at: string;
}

export function sessionDigest(db: Db, workstreamId: string, since: string | null): SessionDigest | null {
  const rows = prepared(
    db,
    `SELECT r.id, r.session_id, r.host, r.title, r.body, r.attribution, r.external_refs, r.created_at FROM records r
     WHERE ${VISIBLE_SQL} AND r.source_id IS NOT NULL AND r.kind = 'evidence' AND ($since IS NULL OR r.created_at > $since)
     ORDER BY r.created_at DESC, r.seq DESC LIMIT ${ROWS}`,
  ).all({ workstreamId, since }) as Row[];
  const newest = rows[0];
  if (newest === undefined) return null;
  const sessions = new Set(rows.map((row) => row.session_id));
  const own = rows.filter((row) => row.session_id === newest.session_id);

  const prompts = own.filter((row) => row.attribution === "user_direction").slice(0, PROMPTS).reverse();
  const reply = own.find((row) => row.attribution === "agent_inference") ?? null;
  const results = own.filter((row) => row.attribution === "direct_observation");
  const commands = results
    .map((row) => ({ row, command: commandOf(row.title) }))
    .filter((c): c is { row: Row; command: string } => c.command !== null)
    .slice(0, COMMANDS)
    .reverse();
  const files = [...new Set(results.flatMap((row) => codePaths(row.external_refs)))].slice(0, FILES);

  return {
    host: newest.host,
    endedAt: newest.created_at,
    prompts: prompts.map((row) => row.body),
    lastReply: reply?.body ?? null,
    files,
    commands: commands.map(({ row, command }) => ({ command, failed: (row.title ?? "").includes(" (error): ") })),
    otherSessions: sessions.size - 1,
    recordIds: [...prompts, ...(reply === null ? [] : [reply]), ...commands.map((c) => c.row)].map((row) => row.id),
  };
}

/** A tool result's title is `<tool>[ (error)]: <call summary>`; shell calls summarize as `$ <command>`. */
function commandOf(title: string | null): string | null {
  const summary = title?.slice(title.indexOf(": ") + 2) ?? "";
  return summary.startsWith("$ ") ? summary.slice(2) : null;
}

function codePaths(refs: string): string[] {
  try {
    return (JSON.parse(refs) as { kind?: string; path?: string }[]).filter((ref) => ref.kind === "code" && typeof ref.path === "string").map((ref) => ref.path as string);
  } catch {
    return [];
  }
}
