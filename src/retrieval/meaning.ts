import type { Vector } from "../embedding/embedder.js";
import type { Db } from "../storage/database.js";
import { RECALL_ELIGIBLE_SQL } from "./eligibility.js";

/**
 * Meaning search on page 1 of a recall with a query (ADR 0001): every eligible record is scored by
 * its best chunk's cosine similarity to the query, and that order is fused with the keyword order
 * by reciprocal rank fusion. Later pages load the frozen result like any other.
 */

/** RRF's constant: the literature default, fixed before looking at any result (ADR 0001). */
export const RRF_K = 60;
/**
 * Records only meaning found that a sequence admits: the vector order's best this many. Every
 * eligible record is somewhere in the vector order, so without a bound each recall would carry
 * all of memory; keyword matches take their vector rank from the whole order. No cosine floor
 * told a real answer from noise (ADR 0001), so the bound is a count: 10 kept every answer the
 * measurements found only by meaning and left most questions with no answer free of noise.
 */
export const MEANING_ONLY = 10;

export interface MeaningScan {
  /** Eligible records with a vector, best match first (seq descending on ties). */
  order: number[];
  /** Chunks of the eligible records, and how many of them have a vector of this model. */
  chunks: number;
  embedded: number;
}

/**
 * Scores the records this recall may return (the same scope, eligibility and kinds as the keyword
 * side, applied before the scan) by the best cosine of their chunks' vectors to `query`. A brute
 * scan of int8 vectors, as the ADR measured it: about 12 ms per 10k chunks.
 */
export function scanByMeaning(db: Db, request: { workstreamId: string; kinds: readonly string[] | null; model: string; query: Vector }): MeaningScan {
  const query = Float32Array.from(request.query.values, (value) => value * request.query.scale);
  const rows = db
    .prepare(
      `SELECT r.seq AS seq, v.scale AS scale, v.vec AS vec FROM records r JOIN chunks c ON c.record_id = r.id
       LEFT JOIN chunk_vectors v ON v.model = $model AND v.text_hash = c.text_hash
       WHERE ${RECALL_ELIGIBLE_SQL} AND ($kinds IS NULL OR r.kind IN (SELECT value FROM json_each($kinds)))`,
    )
    .iterate({ workstreamId: request.workstreamId, model: request.model, kinds: request.kinds === null ? null : JSON.stringify(request.kinds) }) as Iterable<{
    seq: number;
    scale: number | null;
    vec: Buffer | null;
  }>;
  const best = new Map<number, number>();
  let chunks = 0;
  let embedded = 0;
  for (const row of rows) {
    chunks++;
    if (row.vec === null || row.scale === null) continue;
    embedded++;
    const vec = new Int8Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength);
    let dot = 0;
    for (let i = 0; i < vec.length; i++) dot += (vec[i] ?? 0) * (query[i] ?? 0);
    const score = dot * row.scale;
    if (score > (best.get(row.seq) ?? -Infinity)) best.set(row.seq, score);
  }
  const order = [...best].sort(([seqA, a], [seqB, b]) => b - a || seqB - seqA).map(([seq]) => seq);
  return { order, chunks, embedded };
}

/**
 * Fuses page 1's keyword order with the vector order. The first `head` records (those the query's
 * phrases, time window or "now" lifted) keep their places. The rest of the keyword order and the
 * vector order (without the head) are fused by RRF: each record scores 1/(k + rank) in each list it
 * is in. A record not in the keyword order is admitted only from the vector order's best
 * {@link MEANING_ONLY}. A keyword match with no vector yet (the fill has not reached it) is not
 * judged by meaning: it takes its keyword rank in both lists, so a new record keeps its keyword
 * place while the fill catches up, and with no vectors at all the order is exactly the keyword order.
 * Ties keep the keyword order, then the vector order.
 *
 * `meaning` holds the records meaning placed: found only by it, or ranked above their keyword place.
 */
export function fuseByMeaning(keyword: readonly number[], head: number, vector: readonly number[]): { seqs: number[]; meaning: Set<number> } {
  const lifted = keyword.slice(0, head);
  const rest = keyword.slice(head);
  const headSet = new Set(lifted);
  const keywordRank = new Map(rest.map((seq, i) => [seq, i]));
  const vectorRank = new Map(vector.filter((seq) => !headSet.has(seq)).map((seq, i) => [seq, i]));
  const candidates = [...rest, ...[...vectorRank].filter(([seq, rank]) => !keywordRank.has(seq) && rank < MEANING_ONLY).map(([seq]) => seq)];
  const score = (seq: number): number => {
    const k = keywordRank.get(seq);
    const v = vectorRank.get(seq) ?? k;
    return (k === undefined ? 0 : 1 / (RRF_K + k + 1)) + (v === undefined ? 0 : 1 / (RRF_K + v + 1));
  };
  const scores = new Map(candidates.map((seq) => [seq, score(seq)]));
  const fused = [...candidates].sort(
    (a, b) =>
      (scores.get(b) ?? 0) - (scores.get(a) ?? 0) ||
      (keywordRank.get(a) ?? Infinity) - (keywordRank.get(b) ?? Infinity) ||
      (vectorRank.get(a) ?? Infinity) - (vectorRank.get(b) ?? Infinity),
  );
  // Only a record meaning could judge (it has a vector) is said to be placed by it.
  const meaning = new Set(fused.filter((seq, i) => vectorRank.has(seq) && (keywordRank.get(seq) ?? Infinity) > i));
  return { seqs: [...lifted, ...fused], meaning };
}
