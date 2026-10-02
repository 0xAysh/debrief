# Using Debrief

Install steps are in the [README](../README.md#try-it). This page covers what you see and what you can do once it is running.

## The first session: importing past sessions

The first session asks once whether Debrief may seed memory from Claude Code's local transcripts of past sessions:

| Answer | Imports |
|---|---|
| `all` | every project's transcripts, each into its own repository's memory |
| `current_project` | only this repository's |
| `none` | nothing: Debrief remembers from now on |

Answer in the chat, or from a terminal with `debrief import --set all|current_project|none`. Imported passages are bounded, attributed and cited back to their transcript. Hidden reasoning, binaries, recognised secrets, the contents of sensitive files (`.env`, keys, credentials) and Debrief's own output are left out.

## What the `◪ debrief` notices mean

Claude Code shows them to you. They are never sent to the model.

| Notice | Meaning |
|---|---|
| `checkpoint r3 · 2 preferences` | Session start: the agent was given your preferences and told that checkpoint r3 exists. It fetches the checkpoint with `memory_bootstrap` when it continues that work. |
| `12 records` | Session start with no checkpoint yet: the agent was told how many records it can recall. |
| `no memory yet` | Nothing stored for this repository yet. |
| `last session ended without a checkpoint (claude-code)` | The last session stopped, or crashed, before saving where it stood. Its last turns were read from its transcript; the agent was told, and `memory_bootstrap` returns them. |
| `turns after r3 not checkpointed` | Work happened after the last checkpoint. The agent was told, and `memory_bootstrap` returns those turns. |
| `transcript import needs your answer` | The import question above is still open. |
| `workstream to confirm` | Debrief cannot tell which line of work this session continues, so the agent will ask you. |
| `saved turn (12 events)` | The turn that just ended was saved. |
| `recalling: retry budget` | The agent searched memory. |
| `⚠ turn not saved (…)` or `⚠ 2 hook failures (…)` | Something failed. Run `debrief diag status`. The session itself carries on: a failing hook never interrupts it. |
| `not running: the debrief command is not on PATH` | The plugin is installed but the command is not: `npm install -g debrief-cli`. |

## Commands

| Command | What it does |
|---|---|
| `debrief status` | Is it working here? Checks the plugin, the MCP handshake, each hook's last run, the last capture and the import choice. Exits 1 on a problem. **Run this first when something seems off.** |
| `debrief import [--set all\|current_project\|none]` | Shows the import question, or records your answer and imports to completion. |
| `debrief report [--since 7d] [--all]` | Did Debrief help? Searches per session, which returned records the agent went on to use, which turned out wrong, how fresh they were, what it cost. This repository by default; `--all` for every one. Offline, from this machine's data only. It never estimates tokens "saved". |
| `debrief report --review` | Rate up to 10 random searches from the window: good, partial or missed something, with an optional note. The next report shows your ratings. |
| `debrief delete-data [--yes]` | Deletes all stored memory after you type `delete` (see below). |

The `debrief diag …` commands and `debrief mcp` are for diagnostics and for the host: see [development.md](development.md#commands).

## Keeping things out of memory

| You want | Do |
|---|---|
| a passage never stored | wrap it in `<private>…</private>` in your prompt |
| a whole session forgotten | tell the agent **"don't remember this session"**: Debrief forgets what the session stored (in a resumed conversation, what its earlier sessions stored too), never imports its transcript, and refuses its later writes |
| a wrong memory fixed | say so ("that's wrong", "that changed"); the agent is instructed to correct or retract it with `memory_manage` |

Claude Code's own transcript files still hold the conversation. That is Claude Code's data, not Debrief's.

## Meaning search (opt-in)

Recall ranks memory by the words it shares with the query. Meaning search adds a small embedding model (snowflake-arctic-embed-xs, 23 MB, shipped inside the npm package), so a question can find an answer that shares none of its words. It sends nothing anywhere: the model and its runtime come with the code.

It is off by default. In a driven test with real Claude (150 sessions), the agent found the answer to every question it searched for with keyword search alone, because it rewrites the question into its own queries. Meaning search added nothing there and it costs memory. See [benchmarks.md](benchmarks.md#real-agent-runs).

What it costs: the MCP server starts the model in its own process when a recall or new memory needs it, and stops it after two idle minutes, which gives the memory back. While it runs, that process holds about 215 MB (RSS, macOS arm64; up to about 250 MB while the model loads, and about 135 MB of physical footprint), per Claude Code session that searched or saved memory in the last two minutes. Existing and imported memory is embedded in the background, which takes minutes of CPU for a large history. Hooks never load the model.

To turn it on, set `DEBRIEF_MEANING_SEARCH=on` where Claude Code starts, then start a new session. Any other value leaves it off. Either:

- in your shell, before starting Claude Code (it passes its environment on to the MCP server): `export DEBRIEF_MEANING_SEARCH=on`, or
- in Claude Code's settings (`~/.claude/settings.json`), whose `env` reaches the plugin's MCP server:

  ```json
  { "env": { "DEBRIEF_MEANING_SEARCH": "on" } }
  ```

`debrief status` reads its own environment, not Claude Code's settings. With the setting only in `settings.json` it says `off`, so check the model with `DEBRIEF_MEANING_SEARCH=on debrief status`. On, it shows the model and how much of this repository's memory is searchable by meaning, and a model that fails to load is a problem. Off, it says `meaning search · off (DEBRIEF_MEANING_SEARCH=on to enable)`, and names a value it did not recognise.

Found only by meaning, an answer that shares no word with the question ranks below the records that share some.

## Uninstall, and deleting your data

Uninstalling and deleting data are separate steps, so removing Debrief never deletes memory by accident.

```text
1. debrief delete-data                  optional, and first: it needs the debrief command
2. /plugin uninstall debrief@debrief    in Claude Code
3. npm uninstall -g debrief-cli
```

`debrief delete-data` shows the path, size and number of repositories, and deletes only after you type `delete` (`--yes` skips the question, and is required when there is no terminal). Close Claude Code sessions first, since a running session keeps writing. It removes only the files Debrief created: anything else in `$DEBRIEF_HOME` is left alone.

Without `delete-data`, your memory stays in `~/.debrief`.

## Known limits

- A step killed within about 0.1 s is lost. Claude Code writes each step to its transcript a moment after taking it (measured on 2.1.283). A session killed inside that moment loses that step.
- Memory is not ground truth. It is what agents observed and concluded. Freshness warnings cover code that has changed; issues, PRs and other outside state are not checked.
