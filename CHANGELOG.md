# Changelog

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
