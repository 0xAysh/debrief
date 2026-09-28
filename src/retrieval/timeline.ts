import type { ImportedSource } from "../integrity/provenance.js";
import type { Freshness } from "../schemas.js";
import { type Db, prepared } from "../storage/database.js";
import { RECALL_ELIGIBLE_SQL, type RecordRow } from "./eligibility.js";
import { asIndexLine, INDEX_EXCERPT_BYTES } from "./label.js";
import { clipToBytes } from "./search.js";

/**
 * A read's timeline (`memory_read` with `around`): the records of the read record's own Debrief
 * session just before and after it, as index lines: the question that led to a decision, the
 * test run after an attempt.
 *
 * Neighbours are exactly what recall could return here ({@link RECALL_ELIGIBLE_SQL}: this
 * workstream or workspace-level, current, untainted, no checkpoints), so a timeline never shows
 * a record a recall would hide, and a private session's records (forgotten when it was marked)
 * never appear. The session is the Debrief session, never the host's: a resumed Codex thread is
 * a new Debrief session with the same thread id, and it has its own timeline. Ineligible records
 * are skipped, not counted, so `around` neighbours are found whenever that many eligible ones exist.
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

/** Up to `around` eligible records of `row`'s session on each side, nearest first. A record without a session has none. */
export function sessionNeighbours(db: Db, workstreamId: string, row: RecordRow, around: number): { before: RecordRow[]; after: RecordRow[] } {
  if (row.session_id === null) return { before: [], after: [] };
  const side = (position: string, order: "ASC" | "DESC"): RecordRow[] =>
    prepared(
      db,
      `SELECT r.* FROM records r
       WHERE r.session_id = $sessionId AND ${RECALL_ELIGIBLE_SQL} AND ${position}
       ORDER BY ${AT} ${order}, r.seq ${order} LIMIT $around`,
    ).all({ sessionId: row.session_id, workstreamId, createdAt: row.created_at, seq: row.seq, around }) as RecordRow[];
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
