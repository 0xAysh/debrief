/**
 * Schema version 9: the user's ratings of searches (`debrief report --review`, issue #69). One
 * row per rated `call_log` row: good, partial or missed, and optionally what was missing, in the
 * user's words. A note is user input about a search, so it goes wherever the search's query goes:
 * forgetting a record the search returned, or marking its session private, blanks the note.
 */
export const sql = /* sql */ `
CREATE TABLE call_reviews (
  call_id  INTEGER PRIMARY KEY REFERENCES call_log (id) ON DELETE CASCADE,
  rating   TEXT NOT NULL CHECK (rating IN ('good', 'partial', 'missed')),
  note     TEXT,
  rated_at TEXT NOT NULL
) STRICT;
`;
