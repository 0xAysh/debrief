# Hosts: manual connection and caveats

The one-command path is the Claude Code plugin (see the [README](../README.md#install)). This page keeps the verified manual steps, for a host without a Debrief plugin (Codex) or a setup that registers Debrief by hand, and the host behaviour behind them.

| Host | Connect with | Session-start context, turn capture, sub-agents | Transcript import | Tested with |
|---|---|---|---|---|
| Claude Code | the plugin: `/plugin install debrief@debrief` | ✔ (hooks) | ✔ | 2.1.283 |
| Claude Code, by hand | `claude mcp add` ([below](#connect-claude-code-by-hand-verified-with-claude-code-21283)) | ✘ MCP tools only | ✔ at bootstrap | 2.1.283 |
| Codex | `codex mcp add` ([below](#connect-codex-verified-with-codex-cli-01480-alpha21)) | ✘ MCP tools only; hooks later ([#45](https://github.com/0xAysh/debrief/issues/45)) | ✔ legacy rollouts (paginated: [#27](https://github.com/0xAysh/debrief/issues/27)) | `codex-cli 0.148.0-alpha.21` |
| Pi | not yet | – | – | – |

```text
Claude Code ──plugin──▶ .mcp.json ─────▶ debrief mcp --host claude-code
                     └▶ hooks.json ────▶ debrief hook <event> --host claude-code
Codex ───codex mcp add─────────────────▶ debrief mcp --host codex
         all of them run debrief (on PATH, or node …/dist/debrief.mjs) ──▶ $DEBRIEF_HOME
```

## Claude Code plugin

- **The runtime is the `debrief` command on `PATH`.** The plugin (`plugin/` in this repository) contains configuration only: `.mcp.json` starts `debrief mcp --host claude-code`, and `hooks/hooks.json` runs `debrief hook <event> --host claude-code` for SessionStart, SubagentStart, UserPromptSubmit, PreToolUse (matcher `mcp__(plugin_debrief_)?debrief__.*`) and Stop. Debrief needs `better-sqlite3`, a native binding, so a plugin checkout cannot carry a working runtime. A pinned `npx -y debrief@<version>` was measured and rejected: it adds 0.55–0.94 s to every hook, even against a localhost registry (#32).
- **Without `debrief` on `PATH`**, session start shows `◪ debrief · not running: the debrief command is not on PATH (npm install -g debrief-cli)` and every other hook exits 0 silently. The installed script needs `node` on that `PATH` too (`#!/usr/bin/env node`). If Claude Code is started from an IDE or with another `PATH` (nvm, for instance), check with `debrief status` from the same environment.
- **Tool names.** Claude Code names the plugin's tools `mcp__plugin_debrief_debrief__memory_*`. The PreToolUse matcher, `debriefTool` in `src/hosts.ts` (auto-approval) and the transcript importer (Debrief's own output is never re-imported) all accept both that name and the user-scope `mcp__debrief__memory_*`.
- **The import question** is asked at first use: session start tells the agent to put it to the user. `debrief import --set all|current_project|none` answers it from a terminal.
- **Verified** against Claude Code 2.1.283 by `tests/hooks/claude-plugin.test.ts`: `claude plugin marketplace add <checkout>` and `claude plugin install debrief@debrief` in a temporary `CLAUDE_CONFIG_DIR` with no prompts; the `debrief` command from `npm pack`, installed offline into a temporary prefix; a first session with the context, the import question and a read-only call running without a prompt; the question not asked again; `debrief status` before the first session, when healthy, with a hook no longer registered, and with no `debrief` on `PATH`.
- **Hook overhead** (`npm run measure:hooks`): each hook is a new Node process. The CLI ships as one bundled file (`dist/debrief.mjs`), which cut each hook's CPU time by about 45 ms and its in-process time by about 27 ms (p50) against the unbundled `dist/cli.js`. Numbers taken on a busy machine are not evidence; the script prints the load average and swap next to them.

## Connect Codex (verified with codex-cli 0.148.0-alpha.21)

Tested against `codex-cli 0.148.0-alpha.21` (the build bundled with the ChatGPT desktop app, `/Applications/ChatGPT.app/Contents/Resources/codex`) by `tests/mcp/codex-connection.test.ts`. Use absolute paths: Codex starts the server in the thread's working directory (your repository), so a relative program or script path would be resolved there.

```sh
# From a checkout (after npm run build); this exact form was run against 0.148.0-alpha.21:
codex mcp add debrief -- "$(command -v node)" /abs/path/to/debrief/dist/debrief.mjs mcp --host codex
# With debrief installed on PATH, the same with its absolute path:
codex mcp add debrief -- "$(command -v debrief)" mcp --host codex

codex mcp list            # debrief … enabled
codex mcp get debrief     # command, args, env (masked), timeouts
```

- **Keep `--host codex`.** Codex identifies itself as `codex-mcp-client` in the MCP handshake, so without the flag Debrief would not know it serves Codex (no transcript import, no thread binding).
- **Environment is not inherited.** Codex starts MCP servers with a cleared environment (only `HOME`, `PATH`, `USER`, `SHELL`, `LANG`, `TERM`, `TMPDIR`, … pass through). If you use a non-default `CODEX_HOME` or `DEBRIEF_HOME`, pass them explicitly, or Debrief reads `~/.codex` and stores in `~/.debrief`:

  ```sh
  codex mcp add debrief --env CODEX_HOME="$CODEX_HOME" --env DEBRIEF_HOME="$DEBRIEF_HOME" -- "$(command -v debrief)" mcp --host codex
  ```

  Running `codex mcp add debrief …` again replaces the whole entry, including any `--env` given before.
- **Never set `cwd`** for this server. Without it, Codex starts one Debrief per thread in that thread's working directory, which is how Debrief finds the repository and worktree. A fixed `cwd` would put every thread in one scope.
- **Timeouts.** Codex's documentation and code disagree on the defaults (docs: 10 s startup, 60 s per tool; 0.148 code: 30 s and 300 s), and `codex mcp add` has no flag for them. Set them explicitly in `$CODEX_HOME/config.toml`, in the `[mcp_servers.debrief]` table (above its `.env` sub-table):

  ```toml
  [mcp_servers.debrief]
  command = "/abs/path/to/debrief"
  args = ["mcp", "--host", "codex"]
  startup_timeout_sec = 20
  tool_timeout_sec = 60
  ```

  Debrief answers the handshake before touching storage, and `memory_bootstrap` bounds its transcript import to 3 s, continuing in the background.
- Every tool call from Codex carries the thread id (`_meta.threadId`); Debrief binds it to the session, so the thread's own rollout, once imported, joins the same workstream.

Codex rollouts written by 0.125.0-alpha.3 – 0.142.x and by 0.148.0-alpha.21 (legacy history mode) are imported; see [Transcript import](architecture.md#transcript-import) for the table and known gaps.

## Connect Claude Code by hand (verified with Claude Code 2.1.283)

Tested against Claude Code `2.1.283` (native install; first verified on 2.1.281) by `tests/mcp/claude-connection.test.ts`, with `HOME` and `CLAUDE_CONFIG_DIR` in temporary directories. This registers the MCP server only: session-start context, turn capture and the rest of the hooks come with the plugin.

```sh
# With debrief installed on PATH (npm install -g); run by hand against 2.1.281 with debrief installed into a temporary prefix:
claude mcp add debrief -s user -- debrief mcp --host claude-code
# From a checkout (after npm run build); the test registers this form, plus a test-only no-network preload:
claude mcp add debrief -s user -- "$(command -v node)" /abs/path/to/debrief/dist/debrief.mjs mcp --host claude-code

claude mcp list            # debrief: … - ✔ Connected
claude mcp get debrief     # Scope: User config …, Status: ✔ Connected, command, args, env
```

- **Use user scope (`-s user`).** Debrief serves every repository and finds the repository from its working directory. Claude Code starts a user-scope stdio server in the directory the session runs in: the test sees Debrief log `MCP server ready (cwd <repo>)`, and in a `claude -p` session its `memory_bootstrap` resolves that repository and branch. User and local scope are both stored in `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when that is set). The default, `-s local`, registers Debrief for the current directory only. Avoid `-s project`: it writes `.mcp.json` into the repository, with your local paths, and Debrief otherwise writes nothing there.
- **`--host claude-code` is explicit, not required.** Claude Code 2.1.283 identifies itself as `claude-code` in the MCP handshake, which Debrief would accept. The flag keeps the host from depending on it.
- **Environment is inherited.** Unlike Codex, Claude Code passes its own environment to the servers it starts (adding `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID`, …), so a `DEBRIEF_HOME` or `CLAUDE_CONFIG_DIR` set when you launch `claude` reaches Debrief. To pin one however Claude is launched, add `-e` after the server name (`-e` takes several values, so a name placed after it is read as another pair):

  ```sh
  claude mcp add debrief -s user -e DEBRIEF_HOME="$DEBRIEF_HOME" -- "$(command -v debrief)" mcp --host claude-code
  ```

  A bare `debrief` is looked up on the `PATH` Claude runs with, and the installed script needs `node` on that `PATH` (`#!/usr/bin/env node`). If Claude is started from an IDE or with another `PATH` (nvm, for instance), use the node/dist form with absolute paths.
- **`claude mcp list` really connects.** `list` and `get` start each server, complete the handshake and stop it. A server that cannot start shows `✘ Failed to connect`, and both commands still exit 0, so read the status. The check creates no Debrief database: Debrief answers the handshake before touching storage. Server stderr lands in Claude Code's MCP logs (`~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-debrief/` on macOS).
- **Startup timeout.** Claude Code waits 30 s for a stdio server by default (its log: `Starting connection with timeout of 30000ms`). Start it with `MCP_TIMEOUT=<ms>` to change that (verified with `20000`). `memory_bootstrap` bounds its transcript import to 3 s and continues in the background.
- **Instructions fit Claude Code's 2048-character limit.** Claude Code keeps only the first 2048 characters of a server's MCP `instructions`. Debrief's are kept under that limit, with detail in the tool descriptions; `tests/mcp/protocol.test.ts` enforces the length and checks every rule is still present.
