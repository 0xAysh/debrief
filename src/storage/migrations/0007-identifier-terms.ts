import type BetterSqlite3 from "better-sqlite3";
import { rebuildSearchIndex } from "../../retrieval/search.js";

/**
 * Schema version 7: the search projection indexes the words inside code identifiers (issue #52).
 *
 * `chunks.terms` holds the words of a chunk's camelCase / PascalCase identifiers
 * (`rankSequence` → "rank Sequence"), and `chunks_fts` indexes it as a second column, so a
 * query for "rank sequence" finds a record that only says `rankSequence`.
 *
 * The words come from JavaScript (see `identifierTerms` in src/retrieval/search.ts), so this
 * step changes the schema in SQL and then regenerates the projection with the same code
 * `debrief diag reindex` runs. Canonical records are only read: no re-import, and the result is
 * exactly what a reindex produces. The projection is derived, so following later changes to
 * that code is the point, not a hazard.
 */
const sql = /* sql */ `
ALTER TABLE chunks ADD COLUMN terms TEXT NOT NULL DEFAULT '';

DROP TABLE chunks_fts;
CREATE VIRTUAL TABLE chunks_fts USING fts5 (
  text,
  terms,
  content = 'chunks',
  content_rowid = 'id',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
`;

export function migrate(db: BetterSqlite3.Database): void {
  db.exec(sql);
  // `chunks.text_hash` comes with schema version 10, which fills it for these chunks.
  rebuildSearchIndex(db, { textHashes: false });
}
