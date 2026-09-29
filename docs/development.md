# Development

Requires Node `>=24` (`.node-version` pins 25.9.0) and Git.

```sh
npm ci
npm run build       # tsc → dist/, then one bundled CLI: dist/debrief.mjs (the package bin)
npm run typecheck
npm run lint
npm test            # builds dist/, then runs all suites against real SQLite, Git and server processes
```

`npm publish` rebuilds `dist/` first (`prepublishOnly`), so a publish never ships a stale bundle.

## Source map

```text
src/
├── cli.ts                 # `debrief …`: parses arguments, prints; no policy
├── transports/
│   ├── mcp.ts             # `debrief mcp`: MCP tools → the memory module
│   ├── hook.ts            # `debrief hook <event>`: host hook payloads → the memory module
│   └── status.ts          # lays out `debrief status`
├── memory.ts              # the memory module: every policy decision starts here
├── schemas.ts             # zod input schemas (also the MCP tools' JSON Schemas) and limits
├── protocol.ts            # the agent protocol sent as MCP instructions and at session start
├── hosts.ts               # one descriptor per host: adapters, hooks, plugin facts, tool names
├── host-plugins.ts        # reads the host's own install records (file reads only)
├── host-health.ts         # the MCP handshake `debrief status` runs
├── bootstrap/             # cwd → workspace → workstream → session
├── import/                # consent, transcript adapters (claude, codex), reconcile, privacy
├── integrity/             # checkpoints, lifecycle and taints, provenance, preferences, private sessions
├── judge/                 # opt-in Jev: the seam (consent, pinned model, one request), its ledger, "changed, but still true"
├── retrieval/             # eligibility, search, freshness, context packs, index lines, timelines, digest, session-start text
└── storage/               # SQLite, records, migrations, home-level logs, delete-data
```

[architecture.md](architecture.md) explains each part.

## Test seams

Tests use no mocks. Each one drives a real boundary:

| Seam | What runs | Helpers |
|---|---|---|
| ① the built CLI | `node dist/debrief.mjs …` as a child process (MCP server, hooks, commands) | `tests/mcp/harness.ts` (`CLI`, `spawnServer`) |
| ② the real host | Claude Code `2.1.283` (and `codex-cli 0.148.0-alpha.21`) against a localhost stub of the model API | `tests/mcp/claude.ts`, `tests/mcp/codex.ts`, `tests/hooks/plugin-install.ts` |
| ③ the memory module | `openMemory(…)` in-process, against real SQLite and Git | `tests/helpers.ts` |

```text
tests/
├── memory/      # ③ the module's contracts: scope, recall, budgets, lifecycle, session start
├── storage/     # the SQLite runtime gate (version, FTS5)
├── migrations/  # ③ upgrades from every earlier schema version
├── import/      # ③ transcript adapters and import, on hand-written fixtures
├── mcp/         # ① the server and CLI; ② Claude Code and Codex connections
├── hooks/       # ② Claude Code's hooks, the plugin, sub-agents
├── handoff/     # ①② Claude → Codex → Claude
├── jev/         # ①③ opt-in Jev judgments against a localhost stub of TypeSafe's API; real-API scenarios with a key
└── release/     # the package, and the Claude-only acceptance scenario through the installed plugin
```

The driven host tests run only against the pinned builds and are skipped, with the reason on stderr, when the binary is missing or reports another version:

- **Claude Code `2.1.283`**: the first `claude` on `PATH`, else `~/.local/bin/claude`; override with `DEBRIEF_TEST_CLAUDE_BIN`. `HOME` and `CLAUDE_CONFIG_DIR` are temporary directories. On macOS each `claude` also runs under `sandbox-exec` with a profile that denies `~/.claude.json`, `~/.claude`, Claude's cache, `~/.debrief`, and every connection except to localhost.
- **`codex-cli 0.148.0-alpha.21`**: bundled at `/Applications/ChatGPT.app/Contents/Resources/codex`; override with `DEBRIEF_TEST_CODEX_BIN`. It runs in a temporary `CODEX_HOME`.

Every Debrief process a driven test starts loads `tests/mcp/no-network.mjs`, which refuses and logs any socket, DNS lookup or fetch; the tests assert the logs are empty. `DEBRIEF_NETWORK_ALLOW` (`host:port`, comma-separated) lets exactly those endpoints through: the Jev tests allow only their stub, so an empty log proves nothing else was contacted.

**Jev tests** (`tests/jev/`). TypeSafe's API is a localhost HTTP stub (`tests/jev/stub.ts`) that logs every request and answers as a test tells it (a verdict, a 429, a delay); Debrief is pointed at it with `DEBRIEF_JEV_ENDPOINT` and a placeholder `TYPESAFE_API_KEY`. `tests/jev/real-api.test.ts` asks the real API (four calls, about 2,500 input tokens, well under a cent) and runs only with a key: `TYPESAFE_API_KEY` in the environment, else in the repository's git-ignored `.env` (this checkout's, then the main checkout's). Without one it is skipped with the reason on stderr. Its verdicts are written to `tests/mcp/__artifacts__/jev/verdicts.json`.

| Test | Drives |
|---|---|
| `tests/release/acceptance-claude.test.ts` | the packed plugin, installed as a user would: a session killed mid-turn, the next one knowing where things stand, a sub-agent, a later recall, a private session, compaction and resume |
| `tests/hooks/claude-plugin.test.ts` | `npm pack` installed offline into a temporary prefix, the plugin from this repository's marketplace, `debrief status` in each state |
| `tests/hooks/debrief-hooks-claude.test.ts` | every Debrief hook in the real Claude Code |
| `tests/hooks/claude-subagents.test.ts` | what Claude Code does around a sub-agent (pinned host behaviour) |
| `tests/mcp/claude-connection.test.ts` | `claude mcp add/list/get` and a `claude -p` session calling Debrief's tools |
| `tests/mcp/codex-connection.test.ts`, `tests/handoff/handoff-real-codex.test.ts` | `codex mcp add/list/get` and `codex app-server` |

## Real transcripts stay local

Real transcripts hold account ids, file contents and credentials, so they never leave your machine. Every committed fixture under `tests/import/fixtures/` is hand-written, and other tests never read real history: `vitest.config.ts` points `CLAUDE_CONFIG_DIR` and `CODEX_HOME` at empty directories.

```sh
# Snapshot your real Claude Code, Codex and Pi transcripts into the git-ignored .real-transcripts/
npm run snapshot:transcripts    # then `npm test` also runs tests/import/real-history.test.ts against it
DEBRIEF_REAL_CLAUDE_DIR=~/.claude npx vitest run tests/import/real-history.test.ts   # or read a config dir in place
DEBRIEF_REAL_CODEX_HOME=~/.codex npx vitest run tests/import/real-history.test.ts   # (Codex: only sessions/ and archived_sessions/ are read)
```

The snapshot script refuses to run unless git confirms `.real-transcripts/` is ignored. It copies only `*.jsonl` histories, never settings, Codex's `auth.json`/`config.toml`/SQLite state or Pi's `auth.json`.

## Evidence scripts

```sh
npm run benchmark:import     # sanitized synthetic workload: small + large import timing and peak RSS, as JSON
npm run measure:hooks        # hook overhead as Claude Code pays it (p50/p95 wall, in-process and CPU), with the machine's load
npx vitest run tests/handoff # the Claude → Codex → Claude packs and the identity/freshness matrix → tests/mcp/__artifacts__/handoff/
```

- `benchmark:import` generates JSONL in a temporary directory and imports it with no network or model call. It reports transcript, turn, event and record counts, elapsed milliseconds, RSS delta and peak, and database bytes. The values are evidence for the machine that ran it, not pass/fail thresholds. Sizes: `-- --small-transcripts N --small-turns N --large-transcripts N --large-turns N`.
- `measure:hooks` accepts `-- --runs N --compare dist/cli.js` to time another entry beside the bundle. Numbers taken on a busy machine are not evidence: check the load it prints.

## Commands

```sh
debrief status                                      # is Debrief installed and working here? (exit 1 on a problem)
debrief import [--set all|current_project|none]     # put the transcript question, or record the answer and import to completion
debrief delete-data [--yes]                         # delete all stored memory, after typing delete (--yes: without asking)
debrief jev [enable [--yes] | disable] [--here]     # opt-in Jev judgments: state and cost; consent screen and key check; off (--here: this repository)
debrief mcp [--host claude-code|codex|pi|unknown]   # MCP server over stdio (the host starts this)
debrief hook <event> --host claude-code             # a host hook (the plugin registers these; payload on stdin)
debrief diag status                                 # runtime (SQLite/FTS5), storage, scope, counts (read-only)
debrief diag records [--query <text>] [--kind <k>]  # what agents can currently recall here
debrief diag reindex                                # rebuild the search index from canonical records
debrief diag integrity                              # SQLite, foreign-key and FTS integrity checks (read-only)
debrief diag demo [--temp-home]                     # run the tracer flow here and print the pack
                                                    # (writes demo records: set DEBRIEF_HOME or pass --temp-home)
debrief diag consent [--set all|current_project|none] [--host claude-code|codex]
                                                    # show or change a host's transcript-import decision (default claude-code)
debrief diag import [--host claude-code|codex]      # import approved transcripts to completion; print progress and timing
```

- **Scope** always comes from the current directory's Git worktree. No command or tool accepts a workspace id or path.
- **Transcripts** are read from `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`), and from `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions` (default `~/.codex`); nothing else in `CODEX_HOME` is read. The import decision is stored per host in `$DEBRIEF_HOME/consent.json`.
- **MCP tools:** `memory_bootstrap`, `memory_recall`, `memory_read`, `memory_record`, `memory_checkpoint`, `memory_manage`, `memory_status`. The server's MCP `instructions` carry the agent protocol (`src/protocol.ts`): bootstrap first, verify live state, survey with a compact recall and read only what matters, record with honest attribution, cite evidence, correct or retract wrong memory with `memory_manage` when the user says so, propose a preference only for lasting language, and checkpoint with `expectedRevision` before finishing.

## Releasing

1. Update `CHANGELOG.md` and the version in `package.json`, `plugin/.claude-plugin/plugin.json` and `src/transports/mcp.ts`. `tests/release/package.test.ts` fails when they disagree, and it pins the tarball's file list and the README's support matrix.
2. Merge to `main`, then `npm publish` from a clean checkout of it (npm requires two-factor authentication).
3. Tag `vX.Y.Z` on the published commit and create the GitHub release from the changelog entry.
