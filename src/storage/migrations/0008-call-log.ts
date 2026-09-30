/**
 * Schema version 8: the call log (issue #69), one row per call Debrief served: each memory tool
 * call and each hook run but PreToolUse. It is what `debrief report` reads to say whether memory
 * was used, what it returned and what it cost.
 *
 * A row holds ids and labels, never a record's body: what a recall asked (`query`), the records
 * it returned in order (`returned`: id, kind, freshness, position), sizes, omissions and timings.
 * Forgetting a record blanks the query of the rows that returned or wrote it, and a private
 * session blanks its rows' query, parameters and returned ids (`erased` says which). Nothing
 * refers to this table: a row never keeps anything else alive.
 */
export const sql = /* sql */ `
CREATE TABLE call_log (
  id              INTEGER PRIMARY KEY,
  at              TEXT NOT NULL,
  host            TEXT NOT NULL,
  session_id      TEXT,
  host_session_id TEXT,
  tool_use_id     TEXT,
  source          TEXT NOT NULL CHECK (source IN ('tool', 'hook')),
  name            TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  query           TEXT,
  params          TEXT NOT NULL DEFAULT '{}',
  returned        TEXT NOT NULL DEFAULT '[]',
  bytes           INTEGER NOT NULL,
  tokens          INTEGER NOT NULL,
  omitted         TEXT NOT NULL DEFAULT '{}',
  empty           INTEGER CHECK (empty IN (0, 1)),
  continued       INTEGER NOT NULL DEFAULT 0 CHECK (continued IN (0, 1)),
  continues       INTEGER NOT NULL DEFAULT 0 CHECK (continues IN (0, 1)),
  ms              REAL NOT NULL,
  stages          TEXT NOT NULL DEFAULT '{}',
  erased          TEXT CHECK (erased IN ('forgotten', 'private'))
) STRICT;

CREATE INDEX call_log_at ON call_log (at);
CREATE INDEX call_log_host_session ON call_log (host, host_session_id);
CREATE INDEX call_log_session ON call_log (session_id);
`;
