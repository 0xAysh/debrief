# Changelog

## Unreleased

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

### Freshness

- **Cited lines.** A memory that cites specific lines stays `current` while those lines' text is still in the file: after an edit elsewhere in the file (`changed_elsewhere`), or when lines above moved it (`lines_moved`, with `linesNow` saying where it is now). An edit to the cited lines themselves makes it `stale` (`lines_changed`). Only a fingerprint of the cited text is stored, never the text. References without lines, and memory recorded before this version, keep the whole-file rule.
- **Inverted line ranges are refused.** `lines: [5, 3]` is `invalid_input`.

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
