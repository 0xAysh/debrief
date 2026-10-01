# Changelog

## Unreleased

### Meaning search

- **Recall finds memory by meaning, not only by shared words** (#51, [ADR 0001](docs/adr/0001-meaning-search.md)). "monetary precision rounding" finds "amounts are integer minor units; never floats", "socket resets" finds the `ECONNRESET` evidence. Page 1 of a recall with a query fuses the keyword order with the order by similarity of each record's best chunk (reciprocal rank fusion, k = 60); records a quoted phrase, identifier, time or "now" lifted keep their places first, and the fused order is frozen into the continuation, so later pages ask the model nothing. A record meaning found, or ranked above its keyword place, says `why: meaning`. Eligibility applies before the vector scan, as it does before ranking: retracted, superseded, forgotten, private and other-workstream records can neither be returned nor take a place. Recall without a query is unchanged.
- **The model ships in the package**: snowflake-arctic-embed-xs (int8, 384 dimensions, Apache-2.0) and ONNX Runtime's WebAssembly build, fetched at build time at a pinned revision and checked against pinned SHA-256s. Nothing is downloaded at run time and Debrief still opens no connection. The package grows by about 20 MB (38 MB unpacked); there is no install script and no new native code.
- **Only the MCP server runs it**, in a separate process started on the first recall with a query or the first chunk to embed, and stopped after two idle minutes, which gives all of its memory back. Hooks never load it. `DEBRIEF_MEANING_SEARCH=off` turns meaning search off.
- **Vectors are filled in the background**, a bounded step at a time between calls, newest first and the current workstream first: new memory, existing memory and imported history alike. One server per repository fills at a time; another takes over if it dies. A kill loses no stored vector and embeds nothing twice. Until every chunk has a vector, a recall says `meaning search covers N% of memory`; if the model cannot load, it says `meaning search unavailable: …` and ranks by keywords exactly as before.
- **Vectors are stored as int8 in the workspace database** (schema version 10): `chunk_vectors`, keyed by model and the hash of the chunk's text, so a reindex keeps them, identical chunks share one, and another model's vectors are never read. Forgetting a record, or a private session, deletes its vectors from the file unless another live chunk has the same text; `delete-data` removes them with the database.
- **`debrief status` and `memory_status`** show the model, whether it is loaded, and how much of this repository's memory has vectors; a model that fails to load makes `debrief status` exit 1.

### Session start

- **Session start carries what applies to every task, and points at the work.** It used to carry the checkpoint, the last session's turns and recent memory items: about 1.5k tokens every session, describing the last line of work, which may not be the one you start. Now it carries the protocol, your preferences, questions waiting for you, and one line naming the checkpoint (revision, age, goal) and whether the last session ended without one. The agent calls `memory_bootstrap` when it continues that work, and the protocol tells it to `memory_recall` at the start of each new task. The start's size no longer grows with memory. Sub-agents start as before.
- **`memory_bootstrap` returns `lastSession`**: the last session's turns that no checkpoint covers (its last prompts, reply, commands and files), read from its transcript, so a crashed session is not lost. Null when a checkpoint covers every turn. It never reports the calling session's own turns back to it.
- The session-start notice no longer counts items: `checkpoint r3 · 2 preferences`. `turns after r3 included` is now `turns after r3 not checkpointed`.

### Call log

- **Every call Debrief serves is logged, for `debrief report`.** One row per memory tool call and per session-start, sub-agent-start and Stop hook run, in the workspace database (schema version 8): what a recall asked, the records it returned in order with their kind and freshness label, the bytes and estimated tokens the host got, omissions and continuations, time per recall stage (rank, load, freshness, pack) and the host's tool-use id, which names the call in Claude Code's transcript. The start hooks log exactly the records their context shows. Rows keep ids and labels, never a record's text. Forgetting a record blanks the queries that returned it; a private session blanks its rows. Logging never changes a call's result or a hook's output, never opens a database of its own (so a prompt pays nothing for it), and a failure to log is reported by `debrief status`.

### Private sessions

- **"Don't remember this session" covers a resumed conversation.** Resuming a Codex thread, or `claude --resume`, starts a new Debrief session with the same host session id. Marking it private used to forget only what the current Debrief session stored and what was imported from the transcript, while the sessions before the resume kept their records in recall, `memory_read` and timelines. Now every Debrief session of the conversation is forgotten and marked: what they wrote, the global preferences they confirmed and the questions they raised. The result's `earlierSessions` counts them and the notice asks the agent to tell the user they were included. A restored older copy of the database is marked again, even one taken before the resume. Another conversation, or another host's session with the same id, is untouched. A conversation already marked by 0.1.0 is repaired by saying "don't remember this session" in it again.
- **Debrief's own calls are forgotten too.** The importer keeps each tool call's arguments as a short summary, including the agent's calls to Debrief: a recall's query, the body it recorded. A private session, and forgetting a record, used to leave those behind, because only calls whose result became a record were cleaned. Now a private session forgets every call's arguments in its transcripts, and forgetting a record forgets the arguments of the Debrief calls whose output named it (the call that wrote it, the recalls that returned it). A restored older copy of the database is cleaned again. A session already marked by 0.1.0 is cleaned by marking it again.

### Recall ranking

- **Code identifiers.** A query for "rank sequence" finds memory that only says `rankSequence` or `RankSequence`, and a query for `rankSequence` still puts the record with that exact identifier first. Paths and file names (`freshness.ts`, `retrieval/freshness`) rank the memory that cites them first. Existing databases are reindexed once when this version first opens them (schema version 7); nothing is re-imported.
- **Exact phrases.** A quoted phrase in the query ranks memory containing it verbatim first.
- **Time.** "yesterday", "last week", "in August", "before 2026-09-01", "since …" and "last 3 days" rank memory from that time first. Other matches still follow. "What do we use now for …" puts the newest relevant memory first.
- **Trust.** Among memories that answer a query about equally well, the one that can be trusted more comes first: current above unknown above stale, a test run Debrief captured above one the agent only reported, what was observed or said by the user above the agent's inference, and a claim several independent sources make above one made once (copies never count). Relevance still leads: a stale memory that answers the question better, or is the only answer, still comes back, labelled. Recall without a query (the recent list, session start) is not reordered, and later pages keep the first page's order.
- **Why.** A recalled item says, in a short `why`, when one of these rules placed it (`trusted: current, captured`). Queries without identifiers, quotes or time words, among memories trust cannot tell apart, rank as before.

### Faster recall

- Independent roots are looked up by record instead of by scanning every record in scope, and a freshness check runs `git status` only for references that can use it (never for imported ones). Together they more than pay for trust ranking: a first page with it is faster than one without it was.

### Compact recall

- **`memory_recall` with `mode: "compact"`** returns one line per hit (id, date, kind, attribution, host, freshness and a short excerpt), several times as many hits per budget as a full pack. The agent surveys the index, then reads the few records that matter with `memory_read`. Full packs stay the default.
- **`memory_read` with `around: N`** (1–10) also returns up to N records on each side of the one read, from the same conversation, as index lines in time order: the question that led to a decision, the test run after an attempt. A record the agent wrote live sits among the imported turns of the same host session when its transcript carries Debrief's output. Only records a recall here could return appear, never another session's, another workstream's or a private session's. The lines share the read's budget with the body, nearest first; what does not fit is counted. Without `around` a read is unchanged.

### Freshness

- **Cited lines.** A memory that cites specific lines stays `current` while those lines' text is still in the file: after an edit elsewhere in the file (`changed_elsewhere`), or when lines above moved it (`lines_moved`, with `linesNow` saying where it is now). An edit to the cited lines themselves makes it `stale` (`lines_changed`). Only a fingerprint of the cited text is stored, never the text. References without lines, and memory recorded before this version, keep the whole-file rule.
- **Inverted line ranges are refused.** `lines: [5, 3]` is `invalid_input`.
- **Imported file reads.** A file an imported session read is no longer always `unknown`: when the transcript holds exactly what the agent read (Claude Code's `Read`; `cat`, `sed -n`, `head` and `nl -ba` through Claude Code's or Codex's shell), the read is `current` while the file still holds that text and `stale` once it does not. A whole-file read follows the whole file; a partial one only the lines read. Only a fingerprint is stored, never the text. Truncated, persisted or image output, several files at once, and ranges under 3 non-blank lines stay `unknown`, as do edits and the agent's own words. Sessions imported before this version keep `unknown`; nothing is re-imported.

## [0.1.0](https://github.com/0xAysh/debrief/releases/tag/v0.1.0) - 2026-09-27

The first release: Debrief for Claude Code.

### What it does

- **Sessions start knowing where things stand.** The session-start hook gives the agent the last checkpoint, confirmed preferences and recent memory before your first prompt, with no tool call. When the last session ended without a checkpoint (it was closed, or killed mid-turn), its last turns are read from its transcript and given to the agent too.
- **Every turn is saved** at the end of the turn (the Stop hook). After several turns of work with no checkpoint, the agent is asked once to save one.
- **Sub-agents** start with the checkpoint and recent memory, and what their commands find is remembered as theirs.
- **Cited, attributed memory** through seven MCP tools (`memory_bootstrap`, `memory_recall`, `memory_read`, `memory_record`, `memory_checkpoint`, `memory_manage`, `memory_status`). Memory pointing at code that has changed since is flagged stale.
- **Import of past sessions**, only as you choose: `all`, `current_project` or `none`, asked once.
- **Privacy:** `<private>…</private>` text is never stored, and "don't remember this session" forgets the session and never imports its transcript. Recognised secrets and the contents of sensitive files are left out of imports.
- **Commands:** `debrief status` (is it working?), `debrief import`, `debrief delete-data` (typed confirmation; removes only Debrief's own files), `debrief diag …`.

### Supported versions

Node.js `>=24` (tested with 25.9.0), better-sqlite3 13.0.3, Claude Code 2.1.283, on macOS (arm64). Other versions and platforms are untested.

### Known limits

- Claude Code only. Codex connects by hand; its hooks, Pi, and cloud agents or sandboxes are not supported.
- A session killed within about 0.1 s of a step loses that step: Claude Code had not written it to its transcript yet.
- Upgrades between published versions, backup and restore, and package provenance come later.
