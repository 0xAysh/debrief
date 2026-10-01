import type { ImportedSource } from "../integrity/provenance.js";
import type { Freshness } from "../schemas.js";
import { type Db, prepared } from "../storage/database.js";
import { RECALL_ELIGIBLE_SQL, type RecordRow } from "./eligibility.js";
import { asIndexLine, INDEX_EXCERPT_BYTES } from "./label.js";
import { clipToBytes } from "./search.js";

/**
 * A read's timeline (`memory_read` with `around`): the records of the read record's conversation
 * just before and after it, as index lines: the question that led to a decision, the test run
 * after an attempt.
 *
 * The conversation is the record's Debrief session, bridged to its transcript
 * ({@link conversationSessions}): what an agent records live and what the importer later reads
 * from that host session's transcript land in different Debrief sessions (the live one, and the
 * import's `ses_<digest(host, transcript)>`), and `transcript_sessions` links them wherever the
 * transcript carries Debrief output naming the live session. Sessions join only through such a
 * transcript, never by sharing a host session id alone: a resumed session's live Debrief sessions
 * are one conversation once its transcript, naming each, is imported.
 *
 * Neighbours are exactly what recall could return here ({@link RECALL_ELIGIBLE_SQL}: this
 * workstream or workspace-level, current, untainted, no checkpoints), so a timeline never shows
 * a record a recall would hide: a session bridged in from another workstream contributes only its
 * workspace-level records, and a private session's records (forgotten when it was marked) never
 * appear. Ineligible records are skipped, not counted, so `around` neighbours are found whenever
 * that many eligible ones exist.
 *
 * Time order is the event's own time (`created_at`, compared as instants, as recall's date
 * windows do), then `seq`: an imported record carries its transcript time, and a sub-agent's
 * transcript is imported after its parent's, so insert order is not the order things happened.
 */
export interface Timeline {
  /** Oldest first, ending just before the read record. */
  before: string[];
  /** Oldest first, starting just after it. */
  after: string[];
  /** Neighbours found on each side whose lines did not fit the budget (the farthest go first). */
  omitted: { before: number; after: number };
}

const AT = `julianday(r.created_at)`;
const THEN = `julianday($createdAt)`;
const BEFORE_SQL = `(${AT} < ${THEN} OR (${AT} = ${THEN} AND r.seq < $seq))`;
const AFTER_SQL = `(${AT} > ${THEN} OR (${AT} = ${THEN} AND r.seq > $seq))`;

/**
 * The Debrief sessions of `sessionId`'s conversation: itself, and for every transcript linked to
 * it (its Debrief output names the session, or it was imported into the session), that
 * transcript's import session and every live session it names. The same set whichever of them a
 * record comes from: a host session that ran Debrief in two processes (`claude --resume` appends to
 * the same transcript but starts a new MCP server, so a new live Debrief session) is one
 * conversation. A sub-agent's transcript is imported into its parent's session, so a link through
 * it reaches that same import session. A private transcript is never crossed, and no private
 * session is bridged in (by its own mark, or by another session of its host session, as
 * `sessionIsPrivate` rules), although its records were forgotten when it was marked.
 */
function conversationSessions(db: Db, sessionId: string): string[] {
  const bridged = prepared(
    db,
    `WITH transcripts AS (
       SELECT host, transcript_id FROM transcript_sessions WHERE session_id = $sessionId
       UNION SELECT host, transcript_id FROM import_cursors WHERE session_id = $sessionId
     ), open AS (
       SELECT * FROM transcripts t WHERE NOT EXISTS (SELECT 1 FROM private_transcripts p WHERE p.host = t.host AND p.transcript_id = t.transcript_id)
     ), linked AS (
       SELECT c.session_id AS id FROM open t JOIN import_cursors c ON c.host = t.host AND c.transcript_id = t.transcript_id
       UNION SELECT l.session_id AS id FROM open t JOIN transcript_sessions l ON l.host = t.host AND l.transcript_id = t.transcript_id
     )
     SELECT s.id FROM linked JOIN sessions s ON s.id = linked.id
     WHERE s.id <> $sessionId AND NOT EXISTS (
       SELECT 1 FROM sessions p WHERE p.private = 1 AND (p.id = s.id OR (s.host_session_id IS NOT NULL AND p.host = s.host AND p.host_session_id = s.host_session_id)))
     ORDER BY s.id`,
  ).all({ sessionId }) as { id: string }[];
  return [sessionId, ...bridged.map((row) => row.id)];
}

/** Up to `around` eligible records of `row`'s conversation on each side, nearest first. A record without a session has none. */
export function sessionNeighbours(db: Db, workstreamId: string, row: RecordRow, around: number): { before: RecordRow[]; after: RecordRow[] } {
  if (row.session_id === null) return { before: [], after: [] };
  const sessions = JSON.stringify(conversationSessions(db, row.session_id));
  const side = (position: string, order: "ASC" | "DESC"): RecordRow[] =>
    prepared(
      db,
      `SELECT r.* FROM records r
       WHERE r.session_id IN (SELECT value FROM json_each($sessions)) AND ${RECALL_ELIGIBLE_SQL} AND ${position}
       ORDER BY ${AT} ${order}, r.seq ${order} LIMIT $around`,
    ).all({ sessions, workstreamId, createdAt: row.created_at, seq: row.seq, around }) as RecordRow[];
  return { before: side(BEFORE_SQL, "DESC"), after: side(AFTER_SQL, "ASC") };
}

/** A neighbour as a compact recall shows it with no query: the same fields, freshness checked now. */
export function timelineLine(row: RecordRow, freshness: Freshness, source: ImportedSource | null): string {
  const line = asIndexLine({
    recordId: row.id,
    source: row.body,
    maxExcerptBytes: INDEX_EXCERPT_BYTES,
    build: () => ({ recordId: row.id, createdAt: row.created_at, host: row.host, freshness, kind: row.kind, attribution: row.attribution, title: row.title, source }),
  });
  const excerpt = clipToBytes(line.source, line.maxExcerptBytes);
  return line.build(excerpt, excerpt.length < line.source.length);
}

/**
 * Fits the lines (each side nearest first) into `maxBytes`, counted as their UTF-8 length like the
 * body they share the budget with. Lines are taken nearest first, alternating sides; a side stops
 * at its first line that does not fit, so each side stays contiguous with the read record, and
 * the rest of that side is counted as omitted.
 */
export function fitTimeline(lines: { before: readonly string[]; after: readonly string[] }, maxBytes: number): { timeline: Timeline; usedBytes: number } {
  const kept = { before: [] as string[], after: [] as string[] };
  const open = { before: true, after: true };
  let usedBytes = 0;
  for (let i = 0; i < Math.max(lines.before.length, lines.after.length); i++) {
    for (const side of ["before", "after"] as const) {
      const line = lines[side][i];
      if (line === undefined || !open[side]) continue;
      const bytes = Buffer.byteLength(line, "utf8");
      if (usedBytes + bytes > maxBytes) {
        open[side] = false;
        continue;
      }
      kept[side].push(line);
      usedBytes += bytes;
    }
  }
  return {
    timeline: {
      before: kept.before.reverse(),
      after: kept.after,
      omitted: { before: lines.before.length - kept.before.length, after: lines.after.length - kept.after.length },
    },
    usedBytes,
  };
}
