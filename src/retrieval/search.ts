import { DebriefError } from "../errors.js";
import type { ExternalRef } from "../schemas.js";
import { type Db, prepared, requireTransaction } from "../storage/database.js";
import { RECALL_ELIGIBLE_SQL, type RecordRow, VISIBLE_SQL } from "./eligibility.js";

/**
 * Lexical search over the derived `chunks` / `chunks_fts` projection.
 *
 * The projection is a pure function of canonical `records` rows ({@link chunksFor}), so
 * {@link rebuildSearchIndex} can always regenerate it and ranking stays identical.
 * `chunks_fts` is an external-content FTS5 table over `chunks`; the two are only ever
 * written together inside the caller's write transaction.
 *
 * FTS5's unicode61 tokenizer already splits `rank_sequence` and `src/retrieval/search.ts`
 * into their words, but keeps `rankSequence` whole. Each chunk therefore also indexes the
 * words inside its camelCase and PascalCase identifiers ({@link identifierTerms}) in a
 * second column, `terms`, so "rank sequence" finds `rankSequence`. The words go in the same
 * row rather than extra rows, so the row count is unchanged and a chunk without such
 * identifiers indexes exactly what it did before. (bm25 counts a row's tokens across both
 * columns, so a chunk with identifiers is a little longer to it, and the average moves with it.)
 */

const CHUNK_BYTES = 1_000;
/** Candidates loaded per page; far above what any budget can pack, so budgets, not this, bound a page. */
export const PAGE_CANDIDATES = 200;
const MAX_QUERY_TERMS = 32;

interface IndexableRecord {
  id: string;
  title: string | null;
  body: string;
  externalRefs: readonly ExternalRef[];
}

type ChunkField = "title" | "body" | "refs";

/** Title, body (split at whitespace into ≤1000-byte chunks) and reference locators, in that order. */
function chunksFor(record: IndexableRecord): { field: ChunkField; text: string; terms: string }[] {
  const texts: { field: ChunkField; text: string }[] = [];
  if (record.title !== null) texts.push({ field: "title", text: record.title });
  for (const text of splitText(record.body, CHUNK_BYTES)) texts.push({ field: "body", text });
  const refs = refsText(record.externalRefs);
  if (refs !== "") texts.push({ field: "refs", text: refs });
  return texts.map((chunk) => ({ ...chunk, terms: identifierTerms(chunk.text) }));
}

const refsText = (refs: readonly ExternalRef[]): string => refs.map((ref) => [ref.locator, ref.path].filter(Boolean).join(" ")).join("\n");

/** Where a word starts inside a camelCase or PascalCase identifier (`rank|Sequence`, `HTTP|Server`). */
const CASE_BOUNDARY = /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;

/** The words of one token split at its case boundaries; a single element when it has none. */
export function splitIdentifier(token: string): string[] {
  return token.split(CASE_BOUNDARY);
}

/**
 * The words inside the camelCase / PascalCase identifiers of `text`, space-separated
 * (`rankSequence(HTTPServer)` → "rank Sequence HTTP Server"); "" when there are none.
 * Tokens are cut where unicode61 cuts them, so snake_case and paths need nothing here.
 */
export function identifierTerms(text: string): string {
  const words: string[] = [];
  for (const token of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const parts = splitIdentifier(token);
    if (parts.length > 1) words.push(...parts);
  }
  return words.join(" ");
}

/** Adds a record's chunks to the projection. Call inside the transaction that inserts the record. */
export function indexRecord(db: Db, record: IndexableRecord): void {
  requireTransaction(db, "indexRecord");
  const insertChunk = prepared(db, "INSERT INTO chunks (record_id, ordinal, field, text, terms) VALUES (?, ?, ?, ?, ?)");
  const insertFts = prepared(db, "INSERT INTO chunks_fts (rowid, text, terms) VALUES (?, ?, ?)");
  chunksFor(record).forEach((chunk, ordinal) => {
    const { lastInsertRowid } = insertChunk.run(record.id, ordinal, chunk.field, chunk.text, chunk.terms);
    insertFts.run(lastInsertRowid, chunk.text, chunk.terms);
  });
}

/**
 * Discards and regenerates the whole projection from canonical records.
 * Call inside a write transaction; canonical tables are only read.
 */
export function rebuildSearchIndex(db: Db): { records: number; chunks: number } {
  requireTransaction(db, "rebuildSearchIndex");
  db.exec("INSERT INTO chunks_fts (chunks_fts) VALUES ('delete-all'); DELETE FROM chunks;");
  const rows = db.prepare("SELECT id, title, body, external_refs FROM records ORDER BY seq").all() as {
    id: string;
    title: string | null;
    body: string;
    external_refs: string;
  }[];
  for (const row of rows) {
    indexRecord(db, { id: row.id, title: row.title, body: row.body, externalRefs: JSON.parse(row.external_refs) as ExternalRef[] });
  }
  db.exec("INSERT INTO chunks_fts (chunks_fts) VALUES ('integrity-check')");
  const chunks = (db.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n;
  return { records: rows.length, chunks };
}

/**
 * Turns free text into a safe FTS5 expression: every term is double-quoted (so FTS
 * operators, column filters and syntax errors cannot be injected) and terms are OR-ed,
 * letting bm25 rank records that match more and rarer terms first. An identifier also
 * searches for its words (`rankSequence` → "ranksequence" OR "rank" OR "sequence"), which the
 * `terms` column matches in records that only use the identifier.
 */
export function toFtsQuery(query: string): string {
  // Lowercased before tokenizing, as the words themselves always were (lowercasing can add a
  // combining mark that splits a token); an identifier's words follow it.
  const terms = [
    ...new Set(
      (query.match(/[\p{L}\p{N}]+/gu) ?? []).flatMap((token) => {
        const parts = splitIdentifier(token);
        return [token, ...(parts.length > 1 ? parts : [])].flatMap((word) => word.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
      }),
    ),
  ].slice(0, MAX_QUERY_TERMS);
  if (terms.length === 0) {
    throw new DebriefError("invalid_input", "The query contains no searchable words.", { details: { query } });
  }
  return terms.map((term) => `"${term}"`).join(" OR ");
}

export interface Candidate extends RecordRow {
  /** Best-matching body chunk for the query, else the body itself. */
  excerpt_source: string;
}

/**
 * Upper bound on a recall sequence. Page 1 freezes at most this many ranked records;
 * anything beyond is reported as omitted (`candidate_limit`), never silently dropped.
 */
export const SEQUENCE_CAP = 500;

/**
 * What a phrase is matched against: a record's title, body and reference locators (its
 * `refs` chunk, not the JSON, whose keys would match every phrase like "kind"), lowercased.
 * SQLite's lower() folds only ASCII; phrases go through it too, so both sides fold alike.
 */
const VERBATIM_TEXT_SQL = `lower(coalesce(r.title, '') || char(10) || r.body || char(10) ||
  coalesce((SELECT c.text FROM chunks c WHERE c.record_id = r.id AND c.field = 'refs'), ''))`;

/** {@link VERBATIM_TEXT_SQL} in JavaScript: which of `phrases` a record contains, folding case as SQLite does. */
export function phrasesContained(record: Pick<RecordRow, "title" | "body" | "external_refs">, phrases: readonly string[]): string[] {
  const refs = refsText(JSON.parse(record.external_refs) as ExternalRef[]);
  const text = asciiLower(`${record.title ?? ""}\n${record.body}\n${refs}`);
  return phrases.filter((phrase) => text.includes(asciiLower(phrase)));
}

const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** julianday() compares instants whatever the timestamp's form (host transcripts differ in precision). */
const IN_WINDOW_SQL = `(($from IS NULL OR julianday(r.created_at) >= julianday($from)) AND ($to IS NULL OR julianday(r.created_at) < julianday($to)))`;

export interface RankRequest {
  workstreamId: string;
  /** Already converted with {@link toFtsQuery}; null lists recent records instead. */
  match: string | null;
  kinds: readonly string[] | null;
  /** Quoted phrases and identifiers from the query (see `parseQuery`); none leaves bm25 order alone. */
  phrases?: readonly string[];
  /** The `created_at` range the query names (ISO bounds, either open); null names none. */
  window?: { from: string | null; to: string | null } | null;
  /** The query asks how things stand now: the newest relevant record leads. */
  current?: boolean;
}

/**
 * How close to the best match a record must be for a named time to lift it: bm25 at least
 * this fraction of the best record's. Time reorders the relevant records; it never lifts a
 * record that matched a single common word above the answer.
 */
const RELEVANT_FRACTION = 0.5;
/**
 * How close two records must be to count as about equally relevant: bm25 at least this fraction
 * of the better one's. Anything that reorders by something other than relevance does so only
 * this close: "now" puts the newest of the records close to the best first, and trust reorders
 * inside bands this close to their leader (see {@link rankSequence}). With a looser band a newer
 * record on a neighbouring topic displaced the answer (#58: LongMemEval_S knowledge-update R@1
 * fell from 97.2 to 90.3 at 0.5; 0.9 matched plain bm25).
 */
const CLOSE_FRACTION = 0.9;

/** Why a record ranked where it did beyond bm25, as bits (a continuation carries them compactly). */
export const RANKED_BY = { phrase: 1, window: 2, newest: 4, trust: 8 } as const;

/**
 * The frozen order of a recall sequence: record `seq`s in a total, deterministic order
 * (capped at {@link SEQUENCE_CAP}), plus how many eligible records match in all.
 * Scope and eligibility are part of the WHERE clause, so they apply before ORDER BY /
 * LIMIT: ineligible rows can neither outrank nor displace eligible ones. (bm25's corpus
 * statistics do include ineligible rows; that can change scores, never eligibility.)
 *
 * Order with a query: bm25 of the best-matching chunk, then newest first, then seq.
 * Order without a query: newest first, then seq.
 *
 * What the query asks for beyond its words (`parseQuery`) comes before that order, in tiers:
 * 1. records containing more of its phrases verbatim (case-insensitively, in the title, body
 *    or reference locators);
 * 2. relevant records (see {@link RELEVANT_FRACTION}) created inside its time window;
 * 3. when it asks about now, records close to the best (see {@link CLOSE_FRACTION}) newest first.
 *
 * `rankedBy` holds the {@link RANKED_BY} bits of each sequenced record a tier lifted.
 *
 * `bands` groups the records that are about equally relevant, for trust (`orderByTrust`) to
 * reorder, one band id per sequenced record: walking each tier's records in bm25 order, a band
 * ends where a record's bm25 is no longer {@link CLOSE_FRACTION} of its first record's. So trust
 * decides among records that answer about as well, all the way down the list, and never lifts a
 * weaker match over a clearly better one. Records the "now" tier ordered newest first, and every
 * record of a recall without a query (a recent list), are bands of their own: nothing reorders them.
 */
export function rankSequence(db: Db, request: RankRequest): RankedSequence {
  const phrases = request.phrases ?? [];
  const window = request.window ?? null;
  const current = request.current ?? false;
  const params = {
    workstreamId: request.workstreamId,
    kinds: request.kinds === null ? null : JSON.stringify(request.kinds),
    match: request.match,
    cap: SEQUENCE_CAP,
    ...(phrases.length === 0 ? {} : { phrases: JSON.stringify(phrases) }),
    ...(window === null ? {} : { from: window.from, to: window.to }),
  };
  const filters = `${RECALL_ELIGIBLE_SQL} AND ($kinds IS NULL OR r.kind IN (SELECT value FROM json_each($kinds)))`;
  const ranked =
    request.match === null
      ? `SELECT r.seq AS seq, r.created_at AS created_at, 0 AS rank FROM records r WHERE ${filters}`
      : // MATERIALIZED keeps bm25() evaluated in its full-text query rather than flattened into the aggregate.
        `WITH chunk_hits AS MATERIALIZED (
           SELECT c.record_id, bm25(chunks_fts) AS rank
           FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
           WHERE chunks_fts MATCH $match
         ),
         hits AS (SELECT record_id, min(rank) AS rank FROM chunk_hits GROUP BY record_id)
         SELECT r.seq AS seq, r.created_at AS created_at, h.rank AS rank
         FROM hits h JOIN records r ON r.id = h.record_id WHERE ${filters}`;
  const { total } = db.prepare(`SELECT count(*) AS total FROM (${ranked})`).get(params) as { total: number };
  // A query asking nothing beyond its words runs the plain statement, so it ranks exactly as it always did.
  if (phrases.length === 0 && window === null && !current) {
    const rows = db.prepare(`SELECT seq, rank FROM (${ranked}) ORDER BY rank, created_at DESC, seq DESC LIMIT $cap`).all(params) as { seq: number; rank: number }[];
    const bands = relevanceBands(rows.map((row) => ({ rank: row.rank, tier: request.match === null ? null : "" })));
    return { seqs: rows.map((row) => row.seq), total, rankedBy: new Map(), bands };
  }
  const rows = db
    .prepare(
      `SELECT seq, rank, verbatim, verbatim > 0 AS phrase, relevant AND in_window AS windowed, close AND ${current ? 1 : 0} AS newest FROM (
         SELECT q.seq, q.rank, q.created_at,
           ${phrases.length === 0 ? "0" : `(SELECT count(*) FROM json_each($phrases) p WHERE instr(${VERBATIM_TEXT_SQL}, lower(p.value)) > 0)`} AS verbatim,
           ${window === null ? "0" : IN_WINDOW_SQL} AS in_window,
           -- bm25 is negative, lower is better: within RELEVANT_FRACTION of the best is at most that fraction of it.
           q.rank <= ${RELEVANT_FRACTION} * min(q.rank) OVER () AS relevant,
           q.rank <= ${CLOSE_FRACTION} * min(q.rank) OVER () AS close
         FROM (${ranked}) q JOIN records r ON r.seq = q.seq
       )
       ORDER BY verbatim DESC, windowed DESC, newest DESC, CASE WHEN newest THEN created_at END DESC, rank, created_at DESC, seq DESC
       LIMIT $cap`,
    )
    .all(params) as { seq: number; rank: number; verbatim: number; phrase: number; windowed: number; newest: number }[];
  const rankedBy = new Map<number, number>();
  for (const row of rows) {
    const bits = (row.phrase ? RANKED_BY.phrase : 0) | (row.windowed ? RANKED_BY.window : 0) | (row.newest ? RANKED_BY.newest : 0);
    if (bits !== 0) rankedBy.set(row.seq, bits);
  }
  const tiers = rows.map((row) => ({ rank: row.rank, tier: request.match === null || row.newest ? null : `${row.verbatim}/${row.windowed}` }));
  return { seqs: rows.map((row) => row.seq), total, rankedBy, bands: relevanceBands(tiers) };
}

export interface RankedSequence {
  seqs: number[];
  total: number;
  rankedBy: Map<number, number>;
  /** The band of each record in `seqs` (see {@link rankSequence}); band ids ascend along the sequence. */
  bands: number[];
}

/**
 * Greedy relevance bands over records in rank order: a band starts at a new tier, or where a
 * record's bm25 falls short of {@link CLOSE_FRACTION} of the band's first (best) record's. bm25
 * is negative and lower is better, so "at least that fraction" is `rank <= fraction * leader`, as
 * in the "now" tier. A record with a null tier is a band of its own.
 */
function relevanceBands(rows: readonly { rank: number; tier: string | null }[]): number[] {
  let band = -1;
  let leader = 0;
  let tier: string | null = null;
  return rows.map((row) => {
    if (band === -1 || row.tier === null || row.tier !== tier || row.rank > CLOSE_FRACTION * leader) {
      band++;
      leader = row.rank;
      tier = row.tier;
    }
    return band;
  });
}

/**
 * Loads the given records in the given order, re-applying scope and eligibility (a
 * record that became ineligible since page 1 is dropped, never shown). With a query,
 * `excerpt_source` is the best-matching body chunk.
 */
export function loadCandidates(db: Db, request: { workstreamId: string; match: string | null; seqs: readonly number[] }): Candidate[] {
  if (request.seqs.length === 0) return [];
  const params = { workstreamId: request.workstreamId, seqs: JSON.stringify(request.seqs), match: request.match };
  const wanted = `wanted AS (SELECT CAST(value AS INTEGER) AS seq, key AS pos FROM json_each($seqs))`;
  if (request.match === null) {
    return db
      .prepare(`WITH ${wanted} SELECT r.*, r.body AS excerpt_source FROM wanted w JOIN records r ON r.seq = w.seq WHERE ${VISIBLE_SQL} ORDER BY w.pos`)
      .all(params) as Candidate[];
  }
  return db
    .prepare(
      `WITH ${wanted},
       ids AS (SELECT r.id FROM wanted w JOIN records r ON r.seq = w.seq),
       hits AS MATERIALIZED (
         SELECT c.record_id, c.text, c.ordinal, bm25(chunks_fts) AS rank
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH $match AND c.field = 'body' AND c.record_id IN (SELECT id FROM ids)
       ),
       best AS (SELECT record_id, text, row_number() OVER (PARTITION BY record_id ORDER BY rank, ordinal) AS n FROM hits)
       SELECT r.*, coalesce(b.text, r.body) AS excerpt_source
       FROM wanted w JOIN records r ON r.seq = w.seq LEFT JOIN best b ON b.record_id = r.id AND b.n = 1
       WHERE ${VISIBLE_SQL} ORDER BY w.pos`,
    )
    .all(params) as Candidate[];
}

/**
 * The records with the given seqs, in the given order, as stored. Unlike {@link loadCandidates} it
 * re-applies no eligibility: it is for records {@link rankSequence} returned in this same
 * transaction. The seq list drives the lookup (primary key), so hundreds of seqs cost no scan of
 * the workstream, which is what joining them against eligibility's scope index did.
 */
export function loadRanked(db: Db, seqs: readonly number[]): RecordRow[] {
  if (seqs.length === 0) return [];
  return db
    .prepare(`SELECT r.* FROM json_each(?) w CROSS JOIN records r ON r.seq = CAST(w.value AS INTEGER) ORDER BY w.key`)
    .all(JSON.stringify(seqs)) as RecordRow[];
}

function splitText(text: string, maxBytes: number): string[] {
  const parts = text.split(/(\s+)/u);
  const chunks: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.trim() !== "") chunks.push(current.trim());
    current = "";
  };
  for (const part of parts) {
    if (Buffer.byteLength(current + part, "utf8") <= maxBytes) {
      current += part;
      continue;
    }
    flush();
    // A single token longer than a chunk is split at code-point boundaries.
    let rest = part;
    while (Buffer.byteLength(rest, "utf8") > maxBytes) {
      const head = clipToBytes(rest, maxBytes);
      chunks.push(head);
      rest = rest.slice(head.length);
    }
    current = rest;
  }
  flush();
  return chunks;
}

/** Longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`, never splitting a code point. */
export function clipToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}
