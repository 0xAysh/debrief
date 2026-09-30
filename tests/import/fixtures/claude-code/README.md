# Claude Code transcript fixtures

Hand-written JSONL in the shape Claude Code writes to
`$CLAUDE_CONFIG_DIR/projects/<project>/<session-id>.jsonl`. Every line keeps the real key set
of its entry type for that version (observed on local transcripts, 2026-09); all content,
ids, paths and hashes are synthetic.

Nothing here is copied or derived from a real transcript, and none ever should be:
transcripts hold account ids, file contents and credentials. To check the importer
against real local history, snapshot it into the git-ignored `.real-transcripts/`
(`npm run snapshot:transcripts`); `tests/import/real-history.test.ts` then runs against it
locally. It never reaches the remote.

Placeholders, substituted by `tests/import/fixtures.ts`:

| Placeholder | Replaced with |
|---|---|
| `{{CWD}}` | the test's Git worktree (absolute path) |
| `{{SESSION}}` | the transcript's session id |

| Directory | Claude Code version | Covers |
|---|---|---|
| `2.1.281/basic.jsonl` | 2.1.281 (installed when written) | user/assistant text, thinking, Bash/Read/image tool results, a Debrief echo, injected context, attachments, metadata lines, a secret in tool output |
| `2.1.281/branches.jsonl` | 2.1.281 | a rewind fork (two children of one parent) and an inline sidechain |
| `2.1.281/compaction.jsonl` | 2.1.281 | `compact_boundary` + `isCompactSummary` summary, `away_summary` |
| `2.1.281/malformed.jsonl` | 2.1.281 | an unparseable line mid-file, an unknown entry type, a partial trailing line |
| `2.1.281/large-and-sensitive.jsonl` | 2.1.281 | an oversized message and tool output (`{{LARGE_MESSAGE}}`, `{{LARGE_OUTPUT}}`, generated at render time), a `.env` read, credentials in assistant text |
| `2.1.281/shell-reads.jsonl` | 2.1.281 | `Bash` commands that only print files (`cat`, `sed -n` with `echo` separators, `2>/dev/null \| head`) and ones that do not (a `cat >` heredoc write, a read chained with `grep`) |
| `2.1.281/redis-claim.jsonl` | 2.1.281 | a user claim later corrected (#21), an assistant reply, and a compaction summary written after it |
| `2.1.284/task-notification.jsonl` | 2.1.284 (key set observed on `claude -p` sessions against the test stub) | a background sub-agent's launch receipt and its `<task-notification>` prompt, whose `origin` gains `producer: "session-task"`, plus the `turnPosition` key 2.1.284 adds to prompts |
| `2.1.183/basic.jsonl` | 2.1.183 (oldest observed) | the pre-2.1.200 key set (no `origin`, `slug`, `session_id` …) |
| `unknown-version.jsonl` | 3.0.0 (not in the compatibility table) | a supported prefix followed by an unsupported version |

File-read sessions (#54) are built in code rather than kept as files, since each test needs its own file text: `claudeSession`, `claudeReadStep`, `claudeBashStep` and `codexSession` in `tests/import/fixtures.ts` write 2.1.283 (Codex 0.142.5) entries in the observed key sets, with a `Read` window and `Bash` output metadata in `toolUseResult` as Claude Code records them.
