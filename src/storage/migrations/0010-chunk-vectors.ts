import type BetterSqlite3 from "better-sqlite3";
import { textHash } from "../../retrieval/vectors.js";

/**
 * Schema version 10: meaning search (issue #51, ADR 0001).
 *
 * `chunk_vectors` is a derived projection, like `chunks`: one int8 vector per (model, chunk text).
 * A vector is a pure function of a chunk's text and the model, so it is keyed by those and not by
 * the chunk: `rebuildSearchIndex` (which renumbers chunks) keeps every vector, identical chunks
 * (copies of one host event) share one, and another model's vectors are another key, never mixed
 * with this one's. `chunks.text_hash` (the SHA-256 of `chunks.text`, filled here for existing
 * chunks) joins the two. Vectors no chunk names any more are deleted with the chunks that named
 * them (forget, a private session).
 *
 * `vector_fill` is the lease that lets one MCP server per workspace embed missing chunks in the
 * background: the holder's process id and its last heartbeat. Another server takes it over once
 * the holder's process is gone or its heartbeat is old.
 *
 * Nothing is embedded here: the background fill embeds existing memory the same way as new memory.
 */
const sql = /* sql */ `
ALTER TABLE chunks ADD COLUMN text_hash TEXT NOT NULL DEFAULT '';
CREATE INDEX chunks_text_hash ON chunks (text_hash);

CREATE TABLE chunk_vectors (
  model     TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  scale     REAL NOT NULL,
  vec       BLOB NOT NULL,
  PRIMARY KEY (model, text_hash)
) STRICT;

CREATE TABLE vector_fill (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  holder       TEXT NOT NULL,
  pid          INTEGER NOT NULL,
  heartbeat_at TEXT NOT NULL
) STRICT;
`;

export function migrate(db: BetterSqlite3.Database): void {
  db.exec(sql);
  db.function("debrief_text_hash", { deterministic: true }, (text: unknown) => textHash(String(text)));
  db.exec("UPDATE chunks SET text_hash = debrief_text_hash(text)");
}
