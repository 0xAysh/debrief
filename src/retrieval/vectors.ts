import { createHash } from "node:crypto";
import { type Db, prepared, requireTransaction } from "../storage/database.js";
import { ELIGIBLE_STATE_SQL } from "./eligibility.js";

/**
 * The vector projection (schema version 10, ADR 0001): one int8 vector per (model, chunk text),
 * derived from `chunks` the way `chunks_fts` is, and kept by the background fill (see
 * `LocalMemory.fillVectors`). A vector is a pure function of a chunk's text and the model, so it
 * outlives chunk ids (`rebuildSearchIndex`), identical chunks share one, and a vector of another
 * model is never read: every query names the model.
 *
 * Which chunks get one: those of records that could be recalled (active, untainted, not a
 * checkpoint), in every workstream. A forgotten record has no chunks left, and a private session's
 * records are forgotten, so neither is ever embedded. A record that is retracted, superseded or
 * tainted is skipped; one restored later is embedded then.
 */

/** Records whose chunks are embedded: what recall could return in some workstream. */
export const FILLABLE_SQL = `(${ELIGIBLE_STATE_SQL} AND r.kind <> 'checkpoint')`;

/** What `chunks.text_hash` holds: the SHA-256 of the chunk's text. */
export function textHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface MissingChunk {
  textHash: string;
  text: string;
  /** The record's seq: where a pass's cursor moves to. */
  seq: number;
}

/**
 * Where a fill pass looks for chunks without a vector, newest record first. `fresh` covers chunks
 * written since the pass began (`chunks.id > top`); `scope` the current workstream's records and
 * workspace-level ones; `rest` every other workstream's. A pass works through them in that order
 * with a cursor per region, so it reads each chunk about once however long the backfill.
 */
export type FillRegion = "fresh" | "scope" | "rest";

const REGION_SQL: Record<FillRegion, string> = {
  fresh: "c.id > $top",
  scope: "c.id > $from AND c.id <= $top AND r.seq <= $below AND (r.workstream_id = $workstreamId OR r.workstream_id IS NULL)",
  rest: "c.id > $from AND c.id <= $top AND r.seq <= $below AND r.workstream_id IS NOT NULL AND r.workstream_id IS NOT $workstreamId",
};

/** Up to `limit` distinct chunk texts of one region with no vector of `model` yet, newest record first. */
export function missingChunks(
  db: Db,
  request: { model: string; region: FillRegion; workstreamId: string | null; from: number; top: number; below: number; limit: number },
): MissingChunk[] {
  const rows = prepared(
    db,
    `SELECT c.text_hash AS textHash, c.text AS text, r.seq AS seq FROM records r JOIN chunks c ON c.record_id = r.id
     WHERE ${REGION_SQL[request.region]} AND ${FILLABLE_SQL}
       AND NOT EXISTS (SELECT 1 FROM chunk_vectors v WHERE v.model = $model AND v.text_hash = c.text_hash)
     ORDER BY r.seq DESC, c.ordinal LIMIT $limit`,
  ).all({ model: request.model, workstreamId: request.workstreamId, from: request.from, top: request.top, below: request.below, limit: request.limit * 4 }) as MissingChunk[];
  const seen = new Set<string>();
  return rows.filter((row) => !seen.has(row.textHash) && seen.add(row.textHash)).slice(0, request.limit);
}

/** The newest chunk id; a pass covers the chunks up to it, and chunks after it are fresh. */
export function newestChunkId(db: Db): number {
  return (prepared(db, "SELECT coalesce(max(id), 0) AS id FROM chunks").get() as { id: number }).id;
}

/**
 * Stores vectors, each only while a chunk with that text still belongs to a record that gets one:
 * a record forgotten (or retracted) while its text was being embedded gets no vector. Returns how
 * many were stored. Call inside a write transaction.
 */
export function storeVectors(db: Db, model: string, vectors: readonly { textHash: string; values: Int8Array; scale: number }[]): number {
  requireTransaction(db, "storeVectors");
  const insert = prepared(
    db,
    `INSERT OR IGNORE INTO chunk_vectors (model, text_hash, scale, vec)
     SELECT $model, $textHash, $scale, $vec WHERE EXISTS (
       SELECT 1 FROM chunks c JOIN records r ON r.id = c.record_id WHERE c.text_hash = $textHash AND ${FILLABLE_SQL})`,
  );
  let stored = 0;
  for (const vector of vectors) {
    stored += insert.run({ model, textHash: vector.textHash, scale: vector.scale, vec: Buffer.from(vector.values.buffer, vector.values.byteOffset, vector.values.byteLength) }).changes;
  }
  return stored;
}

/**
 * Deletes the vectors (of any model) of these texts that no chunk names any more. A vector can be
 * turned back into a rough paraphrase of its text, so it goes with the text; a vector another chunk
 * still uses stays. Call inside the transaction that deleted the chunks.
 */
export function dropOrphanVectors(db: Db, hashes: readonly string[]): number {
  requireTransaction(db, "dropOrphanVectors");
  if (hashes.length === 0) return 0;
  return prepared(
    db,
    `DELETE FROM chunk_vectors WHERE text_hash IN (SELECT value FROM json_each(?))
       AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.text_hash = chunk_vectors.text_hash)`,
  ).run(JSON.stringify([...new Set(hashes)])).changes;
}

/** Chunks that get a vector, and how many of them have one of `model` (identical chunks count once each). */
export function vectorCoverage(db: Db, model: string): { chunks: number; embedded: number } {
  return prepared(
    db,
    `SELECT count(*) AS chunks, count(v.text_hash) AS embedded FROM records r JOIN chunks c ON c.record_id = r.id
     LEFT JOIN chunk_vectors v ON v.model = ? AND v.text_hash = c.text_hash WHERE ${FILLABLE_SQL}`,
  ).get(model) as { chunks: number; embedded: number };
}

// ── The fill lease: one server per workspace embeds at a time ──

/** A lease whose holder has not been heard from for this long is taken over, even if its process lives. */
const LEASE_STALE_MS = 60_000;

export interface FillHolder {
  token: string;
  pid: number;
}

/**
 * Takes or renews the fill lease for `holder`. Free, already its own, held by a process that is
 * gone (`process.kill(pid, 0)`), or not renewed for {@link LEASE_STALE_MS}: it is taken. Otherwise
 * another server is filling, and this returns false. Call inside a write transaction.
 */
export function claimFill(db: Db, holder: FillHolder, now: Date): boolean {
  requireTransaction(db, "claimFill");
  const current = prepared(db, "SELECT holder, pid, heartbeat_at AS heartbeatAt FROM vector_fill WHERE id = 1").get() as
    | { holder: string; pid: number; heartbeatAt: string }
    | undefined;
  const free =
    current === undefined || current.holder === holder.token || !processAlive(current.pid) || now.getTime() - Date.parse(current.heartbeatAt) > LEASE_STALE_MS;
  if (!free) return false;
  prepared(db, "INSERT INTO vector_fill (id, holder, pid, heartbeat_at) VALUES (1, $token, $pid, $at) ON CONFLICT (id) DO UPDATE SET holder = $token, pid = $pid, heartbeat_at = $at").run({
    token: holder.token,
    pid: holder.pid,
    at: now.toISOString(),
  });
  return true;
}

/** Gives the lease up, if `holder` has it. Call inside a write transaction. */
export function releaseFill(db: Db, holder: FillHolder): void {
  requireTransaction(db, "releaseFill");
  prepared(db, "DELETE FROM vector_fill WHERE id = 1 AND holder = ?").run(holder.token);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, under another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
