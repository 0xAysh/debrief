# Debrief

Working memory for Claude Code that stays on your machine. When a session ends, even when it is killed mid-turn, the next one starts already knowing where things stand: the goal, what was tried, what was decided, what comes next. Sub-agents start with the checkpoint and recent memory too, and what they find is remembered.

How it differs from hosted memory plugins:

- **Local, no network.** Memory is SQLite files in your home directory. Debrief makes no network calls: its driven tests run every Debrief process under a guard that logs and refuses any connection, and those logs stay empty.
- **Cited.** Every memory records where it came from (a transcript passage, a command's output, the agent's own inference, your direction), so the agent can tell what it observed from what it guessed.
- **Flags stale memory.** A memory that points at code which has changed since is marked stale, and the agent is told to read the file again before relying on it.

Debrief stores knowledge *about* the work, never the code or documents themselves. The repository stays the source of truth.

## Install

```sh
npm install -g debrief-cli
```

Then, in Claude Code:

```text
/plugin marketplace add 0xAysh/debrief
/plugin install debrief@debrief
```

This registers Debrief's MCP server and its hooks, with nothing else to edit. Start a new session.

## The first session: importing past sessions

The first session asks, once, whether Debrief may seed memory from Claude Code's local transcripts of past sessions:

- `all`: every project's transcripts;
- `current_project`: only this repository's;
- `none`: none. Debrief remembers from now on only.

Answer in the chat, or from a terminal with `debrief import --set all|current_project|none`. Imported passages are bounded, attributed and cited back to their transcript. Hidden reasoning, binaries, recognised secrets, the contents of sensitive files (`.env`, keys, credentials) and Debrief's own output are left out.

## Where your data is

`~/.debrief` (or `$DEBRIEF_HOME`), with one SQLite database per repository. Nothing is written into the repository. Scope always follows the Git worktree you are in: memory from one repository never shows up in another.

## What the `◪ debrief` notices mean

Claude Code shows them to you; they are never sent to the model.

| Notice | Meaning |
|---|---|
| `checkpoint r3 loaded · 2 preferences · 8 items` | Session start: what the agent was given before your first prompt. |
| `no memory yet` | Nothing stored for this repository yet. |
| `last session ended without a checkpoint (claude-code)` | The last session stopped, or crashed, before saving where it stood. Its last turns were read from its transcript and given to the agent. |
| `turns after r3 included` | Work happened after the last checkpoint. Those turns were given to the agent too. |
| `transcript import needs your answer` | The import question above is still open. |
| `workstream to confirm` | Debrief cannot tell which line of work this session continues, so the agent will ask you. |
| `saved turn (12 events)` | The turn that just ended was saved. |
| `recalling: retry budget` | The agent searched memory. |
| `⚠ turn not saved (…)` or `⚠ 2 hook failures (…)` | Something failed. Run `debrief diag status`. The session itself carries on: a failing hook never interrupts it. |
| `not running: the debrief command is not on PATH` | The plugin is installed but the command is not: `npm install -g debrief-cli`. |

When several turns of work go by with no checkpoint, Debrief asks the agent once, at the end of a turn, to save one.

## Is it working?

```sh
debrief status
```

It checks the plugin, the MCP handshake, when each hook last ran, the last capture and the import choice, and exits 1 when anything is wrong. It is the first thing to run when something seems off.

## Keeping things out of memory

- Wrap text in `<private>…</private>` in a prompt, and it is never stored.
- Tell the agent **"don't remember this session"**. Debrief forgets what the session stored, never imports its transcript, and refuses its later writes. Claude Code's own transcript files still hold the conversation: that is Claude Code's data, not Debrief's.
- To fix a wrong memory, say so ("that's wrong", "that changed"); the agent corrects or retracts it.

## Uninstall, and deleting your data

Uninstalling and deleting data are separate steps, so removing Debrief never deletes memory by accident.

```text
/plugin uninstall debrief@debrief     # in Claude Code
```

```sh
npm uninstall -g debrief-cli
```

Your memory stays in `~/.debrief` until you delete it:

```sh
debrief delete-data
```

It shows the path, size and number of repositories, and deletes only after you type `delete` (`--yes` skips the question, and is required when there is no terminal). Close Claude Code sessions first, since a running session keeps writing. It removes only the files Debrief created: anything else in `$DEBRIEF_HOME` is left alone. Run it before `npm uninstall`.

## Known limits

- Claude Code only. Codex can be connected by hand ([docs/hosts.md](docs/hosts.md)); its hooks, and Pi, are not packaged yet.
- Claude Code writes its transcript about 0.1 s after each step. A session killed inside that window loses that last step.
- Memory is what agents observed and concluded, not ground truth. Freshness warnings cover code that has changed; issues, PRs and other external state are not checked.

## Supported versions

| | Supported | Tested with |
|---|---|---|
| Node.js | `>=24` | 25.9.0 |
| better-sqlite3 | `13.0.3` (installed with the package) | 13.0.3 |
| Claude Code | `2.1.283` | 2.1.283 |

Tested on macOS (arm64). Other platforms and other Claude Code versions are untested: `debrief status` is the first check there.

---

## Development

Requires Node `>=24` (`.node-version` pins 25.9.0) and Git.

```sh
npm ci
npm run build       # tsc → dist/, then one bundled CLI: dist/debrief.mjs (the package bin)
npm run typecheck
npm run lint
npm test            # builds dist/, then runs all suites against real SQLite, Git and server processes

# Deterministic sanitized workload: small + large import timing and peak-RSS JSON evidence
npm run benchmark:import

# Local-only: snapshot your real Claude Code, Codex and Pi transcripts into the git-ignored .real-transcripts/
npm run snapshot:transcripts    # then `npm test` also runs tests/import/real-history.test.ts against it
DEBRIEF_REAL_CLAUDE_DIR=~/.claude npx vitest run tests/import/real-history.test.ts   # or read a config dir in place
DEBRIEF_REAL_CODEX_HOME=~/.codex npx vitest run tests/import/real-history.test.ts   # (Codex: only sessions/ and archived_sessions/ are read)

# Hook overhead as Claude Code pays it (p50/p95 wall, in-process and CPU per hook), with the machine's load
npm run measure:hooks            # -- --runs N --compare dist/cli.js to set another entry beside the bundle

# Handoff evidence: the Claude → Codex → Claude packs and the identity/freshness matrix, written to tests/mcp/__artifacts__/handoff/
npx vitest run tests/handoff
```

`npm run benchmark:import` generates sanitized JSONL in a temporary directory, imports it without network/model calls, and reports stable `small`/`large` scenario fields: transcript, turn, event and record counts; elapsed milliseconds; RSS delta and process peak RSS; and database bytes. Values are evidence for the machine running the command, not flaky pass/fail thresholds. Scenario sizes can be overridden with `-- --small-transcripts N --small-turns N --large-transcripts N --large-turns N`.

Real transcripts hold account ids, file contents and credentials, so they never leave your machine. `.real-transcripts/` is git-ignored, and the snapshot script refuses to run unless git confirms that. It intentionally copies Claude, Codex and Pi `*.jsonl` histories as local product-development fixtures, never settings, Codex's `auth.json`/`config.toml`/SQLite state or Pi's `auth.json`; current product import support remains independently adapter-gated. Every committed fixture under `tests/import/fixtures/` is hand-written. Other tests never read real history: `vitest.config.ts` points `CLAUDE_CONFIG_DIR` and `CODEX_HOME` at empty directories.

`tests/mcp/codex-connection.test.ts` (and the Codex step of `tests/handoff/handoff-real-codex.test.ts`) drives the real Codex CLI (`codex mcp add/list/get`, `codex app-server`) in a temporary `CODEX_HOME`. It runs only against the pinned build, `codex-cli 0.148.0-alpha.21` (bundled at `/Applications/ChatGPT.app/Contents/Resources/codex`; override with `DEBRIEF_TEST_CODEX_BIN`), and is skipped, with the reason on stderr, when that binary is missing or reports another version.

`tests/hooks/claude-plugin.test.ts` installs this repository's plugin into the real Claude Code from its marketplace, with the `debrief` command from `npm pack` installed offline (from npm's cache) into a temporary prefix, and drives sessions against a localhost stub.

`tests/mcp/claude-connection.test.ts` drives the real Claude Code CLI: `claude mcp add/list/get`, and a `claude -p` session against a localhost stub of the Messages API that makes it call `memory_bootstrap` and `memory_status`. `HOME` and `CLAUDE_CONFIG_DIR` are temporary directories. On macOS each `claude` process also runs under `sandbox-exec` with a profile that denies `~/.claude.json`, `~/.claude`, Claude's cache, `~/.debrief` and every connection except to localhost. It runs only against the pinned build, Claude Code `2.1.283` (the first `claude` on `PATH`, else `~/.local/bin/claude`; override with `DEBRIEF_TEST_CLAUDE_BIN`), and is skipped, with the reason on stderr, when that binary is missing or reports another version.

## Commands

```sh
debrief status                                      # is Debrief installed and working here? (exit 1 on a problem)
debrief import [--set all|current_project|none]     # put the transcript question, or record the answer and import to completion
debrief delete-data [--yes]                         # delete all stored memory, after typing delete (--yes: without asking)
debrief mcp [--host claude-code|codex|pi|unknown]   # MCP server over stdio (the host starts this)
debrief diag status                                 # runtime (SQLite/FTS5), storage, scope, counts (read-only)
debrief diag records [--query <text>] [--kind <k>]  # what agents can currently recall here
debrief diag reindex                                # rebuild the search index from canonical records
debrief diag integrity                              # SQLite, foreign-key and FTS integrity checks (read-only)
debrief diag demo [--temp-home]                     # run the tracer flow here and print the pack
                                                    # (writes demo records: set DEBRIEF_HOME or pass --temp-home)
# developer diagnostics:
debrief diag consent [--set all|current_project|none] [--host claude-code|codex]
                                                    # show or change a host's transcript-import decision (default claude-code)
debrief diag import [--host claude-code|codex]      # import approved transcripts to completion; print progress and timing
```

Claude Code transcripts are read from `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`). Codex rollouts are read from `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions` (default `~/.codex`); nothing else in `CODEX_HOME` is read. The import decision is stored per host in `$DEBRIEF_HOME/consent.json`.

Scope always comes from the current directory's Git worktree. No command or tool accepts a workspace id or path.

MCP tools: `memory_bootstrap`, `memory_recall`, `memory_read`, `memory_record`, `memory_checkpoint`, `memory_manage`, `memory_status`. The server's MCP `instructions` carry the agent protocol: bootstrap first, verify live state, record with honest attribution, cite evidence, correct or retract wrong memory with `memory_manage` when the user says so, propose a preference only for lasting language (Debrief asks the user to confirm it and where it applies), and checkpoint with `expectedRevision` before finishing.

See [docs/architecture.md](docs/architecture.md) for the interface, schema, invariants and error codes.
