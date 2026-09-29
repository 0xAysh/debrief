import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tempDir } from "../helpers.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures/claude-code");

/** A fresh stand-in for `$CLAUDE_CONFIG_DIR` (transcripts live under its `projects/`). */
export function claudeConfigDir(): string {
  return tempDir("debrief-claude-");
}

/** Claude Code's project directory name: the cwd with every non-alphanumeric character replaced by "-". */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export interface InstalledTranscript {
  sessionId: string;
  path: string;
}

/** Generated content for `large-and-sensitive.jsonl` (kept out of the file so the fixture stays small). */
const GENERATED: Record<string, string> = {
  "{{LARGE_MESSAGE}}": "log line with detail ".repeat(1_000),
  "{{LARGE_OUTPUT}}": "compiling module ".repeat(12_000),
};

/** The fixture's text with its placeholders filled in. */
export function renderFixture(fixture: string, vars: { cwd: string; sessionId: string }): string {
  let text = readFileSync(join(FIXTURES, fixture), "utf8").replaceAll("{{CWD}}", vars.cwd).replaceAll("{{SESSION}}", vars.sessionId);
  for (const [placeholder, value] of Object.entries(GENERATED)) text = text.replaceAll(placeholder, value);
  return text;
}

/** Writes a rendered fixture where Claude Code would keep the transcript of a session started in `cwd`. */
export function installTranscript(configDir: string, fixture: string, options: { cwd: string; sessionId?: string; content?: string }): InstalledTranscript {
  const sessionId = options.sessionId ?? randomUUID();
  const dir = join(configDir, "projects", projectDirName(options.cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, options.content ?? renderFixture(fixture, { cwd: options.cwd, sessionId }));
  return { sessionId, path };
}

/**
 * Two 2.1.281 transcript lines (newline-terminated): an assistant `tool_use` and the user
 * `tool_result` carrying `result`. Uuids are `…0000000000<id>` and `…0000000000<id + 1>`.
 */
export function claudeToolExchange(options: { cwd: string; sessionId: string; gitBranch: string; parentUuid: string | null; id: number; tool: string; input: object; result: string }): string {
  const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
  const common = { isSidechain: false, userType: "external", entrypoint: "cli", cwd: options.cwd, sessionId: options.sessionId, version: "2.1.281", gitBranch: options.gitBranch };
  const call = uuid(options.id);
  const toolUseId = `toolu_${options.id}`;
  return [
    { ...common, parentUuid: options.parentUuid, type: "assistant", uuid: call, timestamp: "2026-09-23T09:01:00.000Z", message: { model: "claude-opus-5-5", id: `msg_${options.id}`, type: "message", role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: options.tool, input: options.input }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { ...common, parentUuid: call, type: "user", uuid: uuid(options.id + 1), timestamp: "2026-09-23T09:01:00.200Z", message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content: [{ type: "text", text: options.result }] }] } },
  ].map((line) => `${JSON.stringify(line)}\n`).join("");
}

/**
 * One Claude Code 2.1.281 turn at `at` (newline-terminated lines): a typed prompt, optionally a
 * `Bash` command or an `Edit` with its result, and a closing reply. Uuids derive from `n`, and
 * `parentUuid` chains to `after` (the previous turn's last uuid, returned as `last`).
 */
export function claudeTurn(options: { cwd: string; sessionId: string; n: number; at: Date; prompt: string; command?: string; edit?: string; after?: string | null }): { lines: string; last: string } {
  const uuid = (k: number) => `00000000-0000-4000-8000-${(options.n * 10 + k).toString().padStart(12, "0")}`;
  const time = (ms: number) => new Date(options.at.getTime() + ms).toISOString();
  const common = { isSidechain: false, userType: "external", entrypoint: "cli", cwd: options.cwd, sessionId: options.sessionId, version: "2.1.281", gitBranch: "fix/double-charge" };
  const assistant = (k: number, content: object[]) => ({ ...common, parentUuid: uuid(k - 1), type: "assistant", uuid: uuid(k), timestamp: time(k * 100), message: { model: "claude-opus-5-5", id: `msg_${options.n}_${k}`, type: "message", role: "assistant", content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  const lines: object[] = [
    { ...common, parentUuid: options.after ?? null, promptId: `p-${options.n}`, type: "user", message: { role: "user", content: options.prompt }, uuid: uuid(1), timestamp: time(0), permissionMode: "default", origin: { kind: "human" }, promptSource: "typed" },
  ];
  const tool = options.command !== undefined ? { name: "Bash", input: { command: options.command } } : options.edit !== undefined ? { name: "Edit", input: { file_path: options.edit, old_string: "a", new_string: "b" } } : null;
  let k = 2;
  if (tool !== null) {
    const id = `toolu_${options.n}`;
    lines.push(assistant(k, [{ type: "tool_use", id, ...tool }]));
    lines.push({ ...common, parentUuid: uuid(k), type: "user", uuid: uuid(k + 1), timestamp: time((k + 1) * 100), message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: [{ type: "text", text: "ok" }] }] } });
    k += 2;
  }
  lines.push(assistant(k, [{ type: "text", text: `Done with turn ${options.n}.` }]));
  return { lines: lines.map((line) => `${JSON.stringify(line)}\n`).join(""), last: uuid(k) };
}

/**
 * One Claude Code 2.1.283 turn that delegates to a sub-agent (newline-terminated lines): a typed
 * prompt, the `Agent` call, its result and a closing reply. In the foreground the result is the
 * hand-back carrying `report`; in the background it is only the launch receipt, and the report
 * returns later as a task-notification prompt from the host. Uuids derive from `n`.
 */
export function claudeDelegatedTurn(options: { cwd: string; sessionId: string; n: number; at: Date; prompt: string; agentId: string; subagentPrompt: string; report: string; background?: boolean; after?: string | null }): { lines: string; last: string; toolUseId: string } {
  const uuid = (k: number) => `00000000-0000-4000-8000-${(options.n * 10 + k).toString().padStart(12, "0")}`;
  const time = (ms: number) => new Date(options.at.getTime() + ms).toISOString();
  const common = { isSidechain: false, userType: "external", entrypoint: "cli", cwd: options.cwd, sessionId: options.sessionId, version: "2.1.283", gitBranch: "fix/double-charge" };
  const toolUseId = `toolu_agent_${options.n}`;
  const assistant = (k: number, content: object[]) => ({ ...common, parentUuid: uuid(k - 1), type: "assistant", uuid: uuid(k), timestamp: time(k * 100), message: { model: "claude-opus-5-5", id: `msg_${options.n}_${k}`, type: "message", role: "assistant", content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  const handBack = `[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:\n  ${options.report}\nagentId: ${options.agentId} (use SendMessage with to: '${options.agentId}' to continue this agent)\n<usage>subagent_tokens: 2\ntool_uses: 1\nduration_ms: 900</usage>`;
  const receipt = `Async agent launched successfully. (This tool result is internal metadata.)\nagentId: ${options.agentId} (internal ID)`;
  const lines: object[] = [
    { ...common, parentUuid: options.after ?? null, promptId: `p-${options.n}`, type: "user", message: { role: "user", content: options.prompt }, uuid: uuid(1), timestamp: time(0), permissionMode: "default", origin: { kind: "human" }, promptSource: "typed" },
    assistant(2, [{ type: "tool_use", id: toolUseId, name: "Agent", input: { description: "delegated", prompt: options.subagentPrompt, subagent_type: "general-purpose", ...(options.background === true ? {} : { run_in_background: false }) } }]),
    {
      ...common,
      parentUuid: uuid(2),
      type: "user",
      uuid: uuid(3),
      timestamp: time(300),
      message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content: [{ type: "text", text: options.background === true ? receipt : handBack }] }] },
      toolUseResult:
        options.background === true
          ? { isAsync: true, status: "async_launched", agentId: options.agentId, description: "delegated", prompt: options.subagentPrompt }
          : { status: "completed", prompt: options.subagentPrompt, agentId: options.agentId, agentType: "general-purpose", content: [{ type: "text", text: options.report }], totalToolUseCount: 1 },
      sourceToolAssistantUUID: uuid(2),
    },
  ];
  if (options.background === true) {
    const notification = `<task-notification>\n<task-id>${options.agentId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Agent "delegated" finished</summary>\n<result>${options.report}</result>\n</task-notification>`;
    lines.push({ ...common, parentUuid: uuid(3), type: "user", uuid: uuid(4), timestamp: time(400), message: { role: "user", content: notification }, origin: { kind: "task-notification" } });
  }
  lines.push(assistant(5, [{ type: "text", text: `Done with turn ${options.n}.` }]));
  return { lines: lines.map((line) => `${JSON.stringify(line)}\n`).join(""), last: uuid(5), toolUseId };
}

/**
 * A Claude Code 2.1.283 sub-agent's transcript, written where Claude Code keeps it
 * (`<project>/<session>/subagents/agent-<agentId>.jsonl`, with its `.meta.json`): the prompt its
 * parent gave it, one `Bash` command and its output, and its final report.
 */
export function installSubagent(
  configDir: string,
  options: { cwd: string; sessionId: string; agentId: string; toolUseId: string; at: Date; prompt: string; command: string; output: string; report: string; agentType?: string },
): { path: string } {
  const dir = join(configDir, "projects", projectDirName(options.cwd), options.sessionId, "subagents");
  mkdirSync(dir, { recursive: true });
  const uuid = (k: number) => `5ab00000-0000-4000-8000-${k.toString().padStart(12, "0")}`;
  const time = (ms: number) => new Date(options.at.getTime() + ms).toISOString();
  const agentType = options.agentType ?? "general-purpose";
  const common = { isSidechain: true, agentId: options.agentId, userType: "external", entrypoint: "cli", cwd: options.cwd, sessionId: options.sessionId, version: "2.1.283", gitBranch: "fix/double-charge" };
  const assistant = (k: number, content: object[]) => ({ ...common, parentUuid: uuid(k - 1), type: "assistant", uuid: uuid(k), timestamp: time(k * 100), message: { model: "claude-opus-5-5", id: `msg_sub_${k}`, type: "message", role: "assistant", content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, attributionAgent: agentType });
  const lines: object[] = [
    { ...common, parentUuid: null, promptId: "p-sub", type: "user", message: { role: "user", content: options.prompt }, uuid: uuid(1), timestamp: time(0) },
    { ...common, parentUuid: uuid(1), type: "attachment", attachment: { type: "hook_additional_context" }, uuid: uuid(2), timestamp: time(50) },
    assistant(3, [{ type: "tool_use", id: "toolu_sub_bash", name: "Bash", input: { command: options.command } }]),
    { ...common, parentUuid: uuid(3), type: "user", uuid: uuid(4), timestamp: time(400), message: { role: "user", content: [{ tool_use_id: "toolu_sub_bash", type: "tool_result", content: options.output, is_error: false }] } },
    assistant(5, [{ type: "text", text: options.report }]),
  ];
  const path = join(dir, `agent-${options.agentId}.jsonl`);
  writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  writeFileSync(join(dir, `agent-${options.agentId}.meta.json`), JSON.stringify({ agentType, description: "delegated", toolUseId: options.toolUseId, spawnDepth: 1, requestShape: "foreground", requestNonInteractive: true }));
  return { path };
}

/**
 * A synthetic history for load and interruption tests: `transcripts` sessions, each the
 * `basic.jsonl` conversation repeated `turns` times with unique event and tool ids (7 records
 * per turn).
 */
export function installSyntheticHistory(configDir: string, cwd: string, options: { transcripts: number; turns: number }): InstalledTranscript[] {
  const installed: InstalledTranscript[] = [];
  for (let t = 0; t < options.transcripts; t++) {
    const sessionId = randomUUID();
    const base = renderFixture("2.1.281/basic.jsonl", { cwd, sessionId });
    const turns: string[] = [];
    for (let turn = 0; turn < options.turns; turn++) {
      const prefix = (turn + 1).toString(16).padStart(8, "0");
      turns.push(base.replace(/00000000-0000-4000-8000-(\d{12})/g, `${prefix}-0000-4000-8000-$1`).replace(/toolu_(\d{4})/g, `toolu_${turn}_$1`));
    }
    installed.push(installTranscript(configDir, "", { cwd, sessionId, content: turns.join("") }));
  }
  return installed;
}

// ── Codex ──

const CODEX_FIXTURES = resolve(import.meta.dirname, "fixtures/codex");

/** A fresh stand-in for `$CODEX_HOME` (rollouts live under its `sessions/` and `archived_sessions/`). */
export function codexHome(): string {
  return tempDir("debrief-codex-");
}

/** A UUIDv7-shaped thread id, like the ones Codex generates. */
export function codexThreadId(): string {
  const hex = randomUUID().replaceAll("-", "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface CodexVars {
  cwd: string;
  threadId: string;
  cwd2?: string;
  parentId?: string;
  workstreamId?: string;
  recordId?: string;
}

/** The Codex fixture's text with its placeholders filled in. */
export function renderCodexFixture(fixture: string, vars: CodexVars): string {
  let text = readFileSync(join(CODEX_FIXTURES, fixture), "utf8")
    .replaceAll("{{CWD2}}", vars.cwd2 ?? `${vars.cwd}-elsewhere`)
    .replaceAll("{{CWD}}", vars.cwd)
    .replaceAll("{{THREAD}}", vars.threadId)
    .replaceAll("{{PARENT}}", vars.parentId ?? "01900000-0000-7000-8000-00000000beef")
    .replaceAll("{{SHA}}", "0123456789abcdef0123456789abcdef01234567")
    .replaceAll("{{WORKSTREAM}}", vars.workstreamId ?? "wst_00000000000000000000000000000000")
    .replaceAll("{{RECORD}}", vars.recordId ?? "rec_00000000000000000000000000000000");
  for (const [placeholder, value] of Object.entries(GENERATED)) text = text.replaceAll(placeholder, value);
  return text;
}

/**
 * A synthetic Codex history for load and interruption tests: `transcripts` rollouts, each the
 * `0.142.5/basic.jsonl` thread (one session_meta) followed by its turn repeated `turns` times with
 * unique call and item ids (8 records per turn; event ids are byte offsets, so already unique).
 */
export function installSyntheticCodexHistory(home: string, cwd: string, options: { transcripts: number; turns: number }): InstalledTranscript[] {
  const installed: InstalledTranscript[] = [];
  for (let t = 0; t < options.transcripts; t++) {
    const threadId = codexThreadId();
    const [meta = "", ...body] = renderCodexFixture("0.142.5/basic.jsonl", { cwd, threadId }).split(/(?<=\n)/);
    const turns: string[] = [meta];
    for (let turn = 0; turn < options.turns; turn++) turns.push(body.join("").replace(/(call|ws|msg|rs)_(\d{4})/g, `$1_${turn}_$2`));
    installed.push(installCodexRollout(home, "", { cwd, threadId, content: turns.join("") }));
  }
  return installed;
}

/**
 * Writes a rendered fixture where Codex keeps a thread's rollout:
 * `sessions/2026/01/01/rollout-2026-01-01T00-00-00-<thread>.jsonl`, or flat under
 * `archived_sessions/` once archived.
 */
export function installCodexRollout(
  home: string,
  fixture: string,
  options: Omit<CodexVars, "threadId"> & { threadId?: string; archived?: boolean; content?: string },
): InstalledTranscript {
  const threadId = options.threadId ?? codexThreadId();
  const dir = options.archived === true ? join(home, "archived_sessions") : join(home, "sessions", "2026", "01", "01");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-01-01T00-00-00-${threadId}.jsonl`);
  writeFileSync(path, options.content ?? renderCodexFixture(fixture, { ...options, threadId }));
  return { sessionId: threadId, path };
}

// ── File reads (#54): transcripts whose tool results are a file's text ──

/** One step of a hand-written session: a tool call with its result as the model saw it, or an assistant reply. */
export type SessionStep =
  | { tool: string; input: object; result: string | object[]; toolUseResult?: object; isError?: boolean }
  | { say: string };

/**
 * A Claude Code 2.1.283 session (newline-terminated lines): a typed prompt, then each step as an
 * assistant `tool_use` and the user `tool_result` (with `toolUseResult` when given), or an
 * assistant reply. Timestamps advance one second per step from `at`.
 */
export function claudeSession(options: { cwd: string; sessionId: string; at?: Date; steps: readonly SessionStep[] }): string {
  const at = options.at ?? new Date("2026-09-23T09:00:00.000Z");
  const common = { isSidechain: false, userType: "external", entrypoint: "cli", cwd: options.cwd, sessionId: options.sessionId, version: "2.1.283", gitBranch: "main" };
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${(++n).toString().padStart(12, "0")}`;
  const time = (step: number, ms = 0) => new Date(at.getTime() + step * 1_000 + ms).toISOString();
  const lines: object[] = [];
  let parent = uuid();
  lines.push({ ...common, parentUuid: null, promptId: "p-1", type: "user", message: { role: "user", content: "Look at the gateway." }, uuid: parent, timestamp: time(0), permissionMode: "default", origin: { kind: "human" }, promptSource: "typed" });
  const assistant = (content: object[], step: number) => {
    const id = uuid();
    lines.push({ ...common, parentUuid: parent, type: "assistant", uuid: id, timestamp: time(step), message: { model: "claude-opus-5-5", id: `msg_${id.slice(-4)}`, type: "message", role: "assistant", content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    parent = id;
  };
  options.steps.forEach((step, index) => {
    if ("say" in step) {
      assistant([{ type: "text", text: step.say }], index + 1);
      return;
    }
    const toolUseId = `toolu_read_${index + 1}`;
    assistant([{ type: "tool_use", id: toolUseId, name: step.tool, input: step.input }], index + 1);
    const id = uuid();
    lines.push({
      ...common,
      parentUuid: parent,
      type: "user",
      uuid: id,
      timestamp: time(index + 1, 500),
      message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content: step.result, ...(step.isError === true ? { is_error: true } : {}) }] },
      ...(step.toolUseResult === undefined ? {} : { toolUseResult: step.toolUseResult }),
      sourceToolAssistantUUID: parent,
    });
    parent = id;
  });
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

/**
 * What Claude Code's `Read` tool returns for `text` (a file's exact content): each line of the
 * window prefixed `N\t` in `message.content`, and the window in `toolUseResult.file`. A final
 * newline shows as a last, empty line, as Claude Code counts lines (`content.split("\n")`).
 */
export function claudeReadStep(path: string, text: string, window: { offset?: number; limit?: number } = {}): SessionStep {
  const all = text.split("\n");
  const start = window.offset ?? 1;
  const shown = all.slice(start - 1, window.limit === undefined ? undefined : start - 1 + window.limit);
  return {
    tool: "Read",
    input: { file_path: path, ...(window.offset === undefined ? {} : { offset: window.offset }), ...(window.limit === undefined ? {} : { limit: window.limit }) },
    result: shown.map((line, i) => `${start + i}\t${line}`).join("\n"),
    toolUseResult: { type: "text", file: { filePath: path, content: shown.join("\n"), numLines: shown.length, startLine: start, totalLines: all.length } },
  };
}

/** A Claude Code `Bash` step whose stdout was `stdout`: the model sees it with leading blank lines dropped and the end trimmed, as Claude Code shows shell output. */
export function claudeBashStep(command: string, stdout: string, extra: object = {}): SessionStep {
  const shown = stdout.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
  return { tool: "Bash", input: { command, description: "Print the file" }, result: shown, toolUseResult: { stdout: shown, stderr: "", interrupted: false, isImage: false, noOutputExpected: false, ...extra } };
}

/** Lines `a`..`b` (1-based, inclusive) of `text` as `sed -n 'a,bp'` prints them: each newline-terminated, clipped at the end of the file. */
export function sedPrint(text: string, a: number, b: number): string {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  const shown = lines.slice(a - 1, b);
  return shown.map((line, i) => (a - 1 + i === lines.length - 1 && !text.endsWith("\n") ? line : `${line}\n`)).join("");
}

/** A Codex 0.142.5 rollout (newline-terminated lines): session_meta, a turn_context, then one `exec_command` call and its framed output per step. */
export function codexSession(options: { cwd: string; threadId: string; calls: readonly { cmd: string; output: string }[] }): string {
  const time = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 1, s)).toISOString();
  const lines: object[] = [
    { timestamp: time(0), type: "session_meta", payload: { session_id: options.threadId, id: options.threadId, timestamp: time(0), cwd: options.cwd, originator: "Codex Desktop", cli_version: "0.142.5", source: "vscode", thread_source: "user", model_provider: "openai", base_instructions: { text: "<placeholder base instructions>" }, dynamic_tools: [], git: { branch: "main" } } },
    { timestamp: time(1), type: "turn_context", payload: { turn_id: "turn-1", cwd: options.cwd } },
  ];
  options.calls.forEach((call, index) => {
    const callId = `call_read_${index + 1}`;
    lines.push({ timestamp: time(2 + index * 2), type: "response_item", payload: { type: "function_call", id: `fc_${callId}`, name: "exec_command", arguments: JSON.stringify({ cmd: call.cmd, workdir: options.cwd, yield_time_ms: 10_000, max_output_tokens: 10_000 }), call_id: callId } });
    lines.push({ timestamp: time(3 + index * 2), type: "response_item", payload: { type: "function_call_output", call_id: callId, output: `Chunk ID: 0a1b${index}\nWall time: 0.0100 seconds\nProcess exited with code 0\nOriginal token count: 20\nOutput:\n${call.output}` } });
  });
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}
