# Memchor

Local working memory for coding agents. An agent host (Claude Code, Codex, …) starts `memchor mcp` inside a Git repository. Agents can then record attributed evidence and decisions, publish versioned checkpoints, and later recall a small, cited context pack, including from a different agent or a fresh session.

Memchor stores knowledge *about* the work: goals, status, decisions, failed attempts, preferences, next steps, and pointers to code and documents. It never stores the artifacts themselves. The live repository stays the source of truth.

- Stored locally in one SQLite database per repository, under `~/.memchor` (or `$MEMCHOR_HOME`). Nothing is written into the repository.
- No daemon, no network, no embeddings. Several host processes share the database through SQLite WAL.
- On first use with Claude Code or Codex, Memchor offers to seed memory from that host's local transcripts (`all projects`, `current project only`, or `none`). Imported passages are bounded, attributed and cited back to their transcript; hidden reasoning, binaries, recognised secrets, file contents and Memchor's own output are left out.

## Install for Claude Code

```sh
npm install -g memchor          # the command the plugin runs (until it is on npm: npm ci && npm run build && npm install -g "$(npm pack --silent)")
```

Then, in Claude Code:

```text
/plugin marketplace add 0xAysh/memchor
/plugin install memchor@memchor
```

That registers the MCP server and every hook; nothing else to edit. The first session asks whether to import past transcripts (`memchor import --set all|current_project|none` answers from a terminal). Check it any time:

```sh
memchor status     # plugin, MCP handshake, each hook's last run, last capture, import choice; exit 1 on a problem
```

Codex is not packaged yet (its hooks are deferred with the cross-agent work); connect it by hand. [docs/hosts.md](docs/hosts.md) has the verified manual steps for Codex and Claude Code and each host's caveats.

## Development

Requires Node `>=24` (`.node-version` pins 25.9.0) and Git.

```sh
npm ci
npm run build       # tsc → dist/, then one bundled CLI: dist/memchor.mjs (the package bin)
npm run typecheck
npm run lint
npm test            # builds dist/, then runs all suites against real SQLite, Git and server processes

# Deterministic sanitized workload: small + large import timing and peak-RSS JSON evidence
npm run benchmark:import

# Local-only: snapshot your real Claude Code, Codex and Pi transcripts into the git-ignored .real-transcripts/
npm run snapshot:transcripts    # then `npm test` also runs tests/import/real-history.test.ts against it
MEMCHOR_REAL_CLAUDE_DIR=~/.claude npx vitest run tests/import/real-history.test.ts   # or read a config dir in place
MEMCHOR_REAL_CODEX_HOME=~/.codex npx vitest run tests/import/real-history.test.ts   # (Codex: only sessions/ and archived_sessions/ are read)

# Hook overhead as Claude Code pays it (p50/p95 wall, in-process and CPU per hook), with the machine's load
npm run measure:hooks            # -- --runs N --compare dist/cli.js to set another entry beside the bundle

# Handoff evidence: the Claude → Codex → Claude packs and the identity/freshness matrix, written to tests/mcp/__artifacts__/handoff/
npx vitest run tests/handoff
```

`npm run benchmark:import` generates sanitized JSONL in a temporary directory, imports it without network/model calls, and reports stable `small`/`large` scenario fields: transcript, turn, event and record counts; elapsed milliseconds; RSS delta and process peak RSS; and database bytes. Values are evidence for the machine running the command, not flaky pass/fail thresholds. Scenario sizes can be overridden with `-- --small-transcripts N --small-turns N --large-transcripts N --large-turns N`.

Real transcripts hold account ids, file contents and credentials, so they never leave your machine. `.real-transcripts/` is git-ignored, and the snapshot script refuses to run unless git confirms that. It intentionally copies Claude, Codex and Pi `*.jsonl` histories as local product-development fixtures, never settings, Codex's `auth.json`/`config.toml`/SQLite state or Pi's `auth.json`; current product import support remains independently adapter-gated. Every committed fixture under `tests/import/fixtures/` is hand-written. Other tests never read real history: `vitest.config.ts` points `CLAUDE_CONFIG_DIR` and `CODEX_HOME` at empty directories.

`tests/mcp/codex-connection.test.ts` (and the Codex step of `tests/handoff/handoff-real-codex.test.ts`) drives the real Codex CLI (`codex mcp add/list/get`, `codex app-server`) in a temporary `CODEX_HOME`. It runs only against the pinned build, `codex-cli 0.148.0-alpha.21` (bundled at `/Applications/ChatGPT.app/Contents/Resources/codex`; override with `MEMCHOR_TEST_CODEX_BIN`), and is skipped, with the reason on stderr, when that binary is missing or reports another version.

`tests/hooks/claude-plugin.test.ts` installs this repository's plugin into the real Claude Code from its marketplace, with the `memchor` command from `npm pack` installed offline (from npm's cache) into a temporary prefix, and drives sessions against a localhost stub.

`tests/mcp/claude-connection.test.ts` drives the real Claude Code CLI: `claude mcp add/list/get`, and a `claude -p` session against a localhost stub of the Messages API that makes it call `memory_bootstrap` and `memory_status`. `HOME` and `CLAUDE_CONFIG_DIR` are temporary directories. On macOS each `claude` process also runs under `sandbox-exec` with a profile that denies `~/.claude.json`, `~/.claude`, Claude's cache, `~/.memchor` and every connection except to localhost. It runs only against the pinned build, Claude Code `2.1.283` (the first `claude` on `PATH`, else `~/.local/bin/claude`; override with `MEMCHOR_TEST_CLAUDE_BIN`), and is skipped, with the reason on stderr, when that binary is missing or reports another version.

## Commands

```sh
memchor status                                      # is Memchor installed and working here? (exit 1 on a problem)
memchor import [--set all|current_project|none]     # put the transcript question, or record the answer and import to completion
memchor mcp [--host claude-code|codex|pi|unknown]   # MCP server over stdio (the host starts this)
memchor diag status                                 # runtime (SQLite/FTS5), storage, scope, counts (read-only)
memchor diag records [--query <text>] [--kind <k>]  # what agents can currently recall here
memchor diag reindex                                # rebuild the search index from canonical records
memchor diag integrity                              # SQLite, foreign-key and FTS integrity checks (read-only)
memchor diag demo [--temp-home]                     # run the tracer flow here and print the pack
                                                    # (writes demo records: set MEMCHOR_HOME or pass --temp-home)
# developer diagnostics:
memchor diag consent [--set all|current_project|none] [--host claude-code|codex]
                                                    # show or change a host's transcript-import decision (default claude-code)
memchor diag import [--host claude-code|codex]      # import approved transcripts to completion; print progress and timing
```

Claude Code transcripts are read from `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`). Codex rollouts are read from `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions` (default `~/.codex`); nothing else in `CODEX_HOME` is read. The import decision is stored per host in `$MEMCHOR_HOME/consent.json`.

Scope always comes from the current directory's Git worktree. No command or tool accepts a workspace id or path.

MCP tools: `memory_bootstrap`, `memory_recall`, `memory_read`, `memory_record`, `memory_checkpoint`, `memory_manage`, `memory_status`. The server's MCP `instructions` carry the agent protocol: bootstrap first, verify live state, record with honest attribution, cite evidence, correct or retract wrong memory with `memory_manage` when the user says so, propose a preference only for lasting language (Memchor asks the user to confirm it and where it applies), and checkpoint with `expectedRevision` before finishing.

See [docs/architecture.md](docs/architecture.md) for the interface, schema, invariants and error codes.
