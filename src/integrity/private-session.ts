import { type Db, prepared, requireTransaction } from "../storage/database.js";
import type { PrivateSessionEntry } from "./ledger.js";

/**
 * Private sessions ("don't remember this session"): the markers and lookups. Marking itself,
 * which also forgets what the session left behind, is `forgetSession` in lifecycle.ts.
 *
 * A session is private when its own row says so, or when another session of the same host
 * session is private (a resumed Codex thread, or `claude --resume`, starts a new Debrief session
 * with the same host session id). "This session" is that whole host session
 * ({@link sameHostSession}): marking one of its Debrief sessions forgets and marks all of them.
 * Its transcripts are found two ways: the host session id is the transcript id, or the
 * transcript's Debrief output names one of its sessions (`transcript_sessions`, recorded at
 * import; a Claude Code session may have sent no session id). A private transcript is never
 * imported again.
 */

/**
 * The session a Debrief result was returned to: `scope.sessionId`, which in every result follows
 * `scope.headRevision`. Pack items and checkpoints also carry a `sessionId` (the session that
 * wrote the record), but never after `headRevision`, so a recall of another session's records
 * never links this transcript to that session. Matched as text, so output Codex truncated still counts.
 */
const SCOPE_SESSION = /"headRevision":\d+,"sessionId":"(ses_[0-9a-f]{32})"/g;

export interface SessionIdentity {
  sessionId: string;
  host: string;
  hostSessionId: string | undefined;
}

export function sessionIsPrivate(db: Db, session: SessionIdentity): boolean {
  return (
    prepared(db, "SELECT 1 FROM sessions WHERE private = 1 AND (id = $id OR ($hostSessionId IS NOT NULL AND host = $host AND host_session_id = $hostSessionId)) LIMIT 1").get({
      id: session.sessionId,
      host: session.host,
      hostSessionId: session.hostSessionId ?? null,
    }) !== undefined
  );
}

/**
 * The Debrief sessions of `session`'s host session, oldest first: itself, and every session of the
 * same host with the same host session id (its earlier and later resumptions, and the import
 * session of its transcript). Exactly the sessions whose mark makes it private in `sessionIsPrivate`.
 */
export function sameHostSession(db: Db, session: SessionIdentity): string[] {
  const rows = prepared(
    db,
    `SELECT id FROM sessions WHERE id = $id OR ($hostSessionId IS NOT NULL AND host = $host AND host_session_id = $hostSessionId)
     ORDER BY started_at, id`,
  ).all({ id: session.sessionId, host: session.host, hostSessionId: session.hostSessionId ?? null }) as { id: string }[];
  const ids = rows.map((row) => row.id);
  // A session this database has no row for is still itself.
  return ids.includes(session.sessionId) ? ids : [...ids, session.sessionId];
}

export function isPrivateTranscript(db: Db, host: string, transcriptId: string): boolean {
  return prepared(db, "SELECT 1 FROM private_transcripts WHERE host = ? AND transcript_id = ?").get(host, transcriptId) !== undefined;
}

/**
 * Records which Debrief sessions a transcript's Debrief output names, and says whether any of
 * them is private (the importer then drops the transcript). Call inside the import batch.
 */
export function linkTranscriptSessions(db: Db, host: string, transcriptId: string, debriefOutput: string): { privateSessionId: string | null } {
  requireTransaction(db, "linkTranscriptSessions");
  const named = [...new Set([...debriefOutput.matchAll(SCOPE_SESSION)].map((match) => match[1] ?? ""))];
  let found: string | null = null;
  const known = prepared(db, "SELECT private FROM sessions WHERE id = ?");
  const link = prepared(db, "INSERT OR IGNORE INTO transcript_sessions (host, transcript_id, session_id) VALUES (?, ?, ?)");
  for (const sessionId of named) {
    const row = known.get(sessionId) as { private: number } | undefined;
    if (row === undefined) continue;
    link.run(host, transcriptId, sessionId);
    if (row.private === 1) found = sessionId;
  }
  return { privateSessionId: found };
}

/**
 * The transcripts that belong to a host session: its host session id, every transcript whose
 * Debrief output named one of its Debrief `sessions`, and the imported transcripts of their
 * sub-agents (the importer gives those the parent's session). Sub-agent transcripts not imported
 * yet are covered by their parent's marker.
 */
export function transcriptsOf(db: Db, session: { host: string; hostSessionId: string | undefined; sessions: readonly string[] }): { host: string; transcriptId: string }[] {
  const linked = prepared(db, "SELECT host, transcript_id AS transcriptId FROM transcript_sessions WHERE session_id IN (SELECT value FROM json_each(?))").all(
    JSON.stringify(session.sessions),
  ) as { host: string; transcriptId: string }[];
  const own = session.hostSessionId === undefined ? [] : [{ host: session.host, transcriptId: session.hostSessionId }];
  // Found through the import session's host session id, which is the parent's: it holds even when the parent's own transcript was never imported.
  const sameSession = prepared(
    db,
    `SELECT c.host, c.transcript_id AS transcriptId FROM import_cursors c JOIN sessions s ON s.id = c.session_id
     WHERE s.host = ? AND s.host_session_id = ?`,
  );
  const sessions = [...own, ...linked].flatMap((t) => [t, ...(sameSession.all(t.host, t.transcriptId) as { host: string; transcriptId: string }[])]);
  return [...new Map(sessions.map((t) => [`${t.host}\u0000${t.transcriptId}`, t])).values()];
}

/** The Debrief sessions an entry marks: every session of its host session (older entries name only `sessionId`). */
function markedSessions(entry: PrivateSessionEntry): string[] {
  return [...new Set([entry.sessionId, ...(entry.sessions ?? [])])];
}

/**
 * Marks the sessions and their transcripts private (live, or replayed from the ledger into a
 * restored copy, which may hold only the earlier sessions of the host session: those keep it private).
 */
export function applyPrivateSession(db: Db, entry: PrivateSessionEntry): void {
  requireTransaction(db, "applyPrivateSession");
  const markSession = prepared(db, "UPDATE sessions SET private = 1 WHERE id = ?");
  for (const sessionId of markedSessions(entry)) markSession.run(sessionId);
  const mark = prepared(db, "INSERT OR IGNORE INTO private_transcripts (host, transcript_id, session_id, created_at) VALUES (?, ?, ?, ?)");
  for (const transcript of entry.transcripts) mark.run(transcript.host, transcript.transcriptId, entry.sessionId, entry.at);
}

/** Whether a ledger entry's markers are all present (a restored older copy lacks them). */
export function privateSessionApplied(db: Db, entry: PrivateSessionEntry): boolean {
  const session = prepared(db, "SELECT private FROM sessions WHERE id = ?");
  for (const sessionId of markedSessions(entry)) {
    const row = session.get(sessionId) as { private: number } | undefined;
    if (row !== undefined && row.private !== 1) return false;
  }
  return entry.transcripts.every((transcript) => isPrivateTranscript(db, transcript.host, transcript.transcriptId));
}
