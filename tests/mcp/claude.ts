import { type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { onCleanup, tempDir } from "../helpers.js";
import { CLI, NO_NETWORK } from "./harness.js";

/**
 * Drives the real Claude Code CLI for connection tests: `claude mcp add|list|get` and a
 * `claude -p` session, with HOME and CLAUDE_CONFIG_DIR in temporary directories and a localhost
 * stub of the Messages API, so no account, model or internet is involved. Claude Code (a native
 * binary) is not covered by the Node no-network preload; only the Debrief processes it starts are.
 * On macOS every Claude process also runs under a sandbox profile that denies the developer's real
 * Claude config, caches and Debrief home, and every outbound connection except to localhost.
 */

/** The Claude Code release these tests pin (native install, 2026-09). */
export const CLAUDE_PINNED_VERSION = "2.1.283";

function onPath(name: string): string | undefined {
  return (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter((dir) => isAbsolute(dir))
    .map((dir) => join(dir, name))
    .find((candidate) => existsSync(candidate));
}

export interface ClaudeSandbox {
  home: string;
  configDir: string;
}

export function claudeSandbox(): ClaudeSandbox {
  return { home: tempDir("debrief-claude-home-"), configDir: tempDir("debrief-claude-config-") };
}

/**
 * The environment Claude itself runs with. Claude Code passes its own environment on to the MCP
 * servers it starts, so this is also what Debrief inherits (plus the `-e` pairs).
 */
export function claudeEnv(sandbox: ClaudeSandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: sandbox.home,
    CLAUDE_CONFIG_DIR: sandbox.configDir,
    TMPDIR: process.env["TMPDIR"] ?? "/tmp",
    LANG: "C.UTF-8",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    ...extra,
  };
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Real paths a Claude process must neither read nor write, and no network beyond localhost. */
function guardProfile(): string {
  const home = homedir();
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const paths = [join(home, ".claude"), join(home, "Library/Caches/claude-cli-nodejs"), join(home, ".cache/claude-cli-nodejs"), join(home, ".debrief")];
  return [
    "(version 1)(allow default)",
    `(deny file-read* file-write* (regex #"^${escaped}/\\.claude\\.json") ${paths.map((p) => `(subpath "${p}")`).join(" ")})`,
    '(deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:*"))',
  ].join("");
}

function command(args: string[]): [string, string[]] {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC) ? [SANDBOX_EXEC, ["-p", guardProfile(), claudeHost().bin, ...args]] : [claudeHost().bin, args];
}

export interface ClaudeResolution {
  bin: string;
  skip: string | null;
}

/**
 * Which Claude Code binary the driven tests run, and why they are skipped when there is none at
 * the pin. DEBRIEF_TEST_CLAUDE_BIN, when set, is used as given. Otherwise `bin` (the `claude` the
 * developer runs) is used if it reports the pin; Claude Code auto-updates, so when it has moved
 * on, the native installer's kept copy of the pinned build (`<versionsDir>/<pin>`) runs instead.
 * The pin stays because it backs the README's "Tested with" column; a skip names every way out.
 */
export function resolveClaude(inputs: { bin: string; env: NodeJS.ProcessEnv; versionsDir: string; pinned?: string }): ClaudeResolution {
  const pinned = inputs.pinned ?? CLAUDE_PINNED_VERSION;
  const fixes = `set DEBRIEF_TEST_CLAUDE_BIN to a ${pinned} binary, or bump CLAUDE_PINNED_VERSION (tests/mcp/claude.ts, with the README and docs) once these suites pass on the new build with DEBRIEF_REQUIRE_HOSTS=1`;
  const explicit = inputs.env["DEBRIEF_TEST_CLAUDE_BIN"];
  const bin = explicit ?? inputs.bin;
  const version = existsSync(bin) ? (claudeVersion(bin) ?? "unknown") : undefined;
  if (version === pinned) return { bin, skip: null };
  const found = version === undefined ? `no Claude Code binary at ${bin}` : `${bin} is Claude Code ${version}`;
  if (explicit !== undefined) return { bin, skip: `${found} (DEBRIEF_TEST_CLAUDE_BIN); these tests pin ${pinned}: ${fixes}` };
  const kept = join(inputs.versionsDir, pinned);
  if (existsSync(kept) && claudeVersion(kept) === pinned) return { bin: kept, skip: null };
  return { bin, skip: `${found}, and there is no ${kept}; these tests pin ${pinned}: ${fixes}` };
}

function claudeVersion(bin: string): string | undefined {
  // Runs at collection time, outside any test, so it cleans up after itself.
  const scratch = mkdtempSync(join(tmpdir(), "debrief-claude-version-"));
  const run = spawnSync(bin, ["--version"], { env: claudeEnv({ home: scratch, configDir: scratch }), encoding: "utf8", timeout: 20_000 });
  rmSync(scratch, { recursive: true, force: true });
  return /^(\d+\.\d+\.\d+)/.exec(run.stdout)?.[1];
}

let resolved: ClaudeResolution | undefined;

/** Resolved once per test file, on first use, so importing this module (for the pin) spawns nothing. */
function claudeHost(): ClaudeResolution {
  resolved ??= resolveClaude({ bin: onPath("claude") ?? join(homedir(), ".local/bin/claude"), env: process.env, versionsDir: join(homedir(), ".local/share/claude/versions") });
  return resolved;
}

/** Null when the pinned binary is available; otherwise why the Claude Code tests are skipped. */
export function claudeSkipReason(): string | null {
  return claudeHost().skip;
}

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function claude(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): Run {
  const [bin, argv] = command(args);
  const run = spawnSync(bin, argv, { cwd, env, encoding: "utf8", timeout: 60_000 });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** Asynchronous, so a stub server in this process can answer while Claude runs. */
export function claudeAsync(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): Promise<Run> {
  const [bin, argv] = command(args);
  const options: SpawnOptions = { cwd, env, stdio: ["ignore", "pipe", "pipe"] };
  const child = spawn(bin, argv, options);
  onCleanup(() => {
    child.kill();
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve) => {
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * One `claude -p` process fed prompts (and slash commands such as `/compact` and `/clear`) over
 * stream-json, so one Claude Code session can go on across them. `send` resolves when the
 * prompt's result arrives; `end` closes stdin and resolves when Claude exits.
 */
export function claudeStream(
  env: NodeJS.ProcessEnv,
  cwd: string,
  ...args: string[]
): { send: (text: string) => Promise<Record<string, unknown>>; end: () => Promise<Run>; kill: (signal: NodeJS.Signals) => Promise<Run>; post: (text: string) => void } {
  const [bin, argv] = command(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...args]);
  const child = spawn(bin, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  onCleanup(() => {
    child.kill();
  });
  let stdout = "";
  let stderr = "";
  let seen = 0;
  const waiting: ((result: Record<string, unknown>) => void)[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    const lines = stdout.split("\n");
    lines.pop(); // the line still being written
    const results = lines.filter((line) => line.includes('"type":"result"')).map((line) => JSON.parse(line) as Record<string, unknown>).filter((message) => message["type"] === "result");
    while (seen < results.length) waiting.shift()?.(results[seen++] ?? {});
  });
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const closed = new Promise<Run>((resolve) => child.on("close", (code) => { resolve({ code, stdout, stderr }); }));
  const write = (text: string): void => {
    child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
  };
  return {
    /** Sends a prompt without waiting for its result (it may never come: see `kill`). */
    post: write,
    send: (text) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error(`no result for ${JSON.stringify(text)}; stderr: ${stderr}`)); }, 60_000);
        waiting.push((result) => {
          clearTimeout(timer);
          resolve(result);
        });
        write(text);
      }),
    end: () => {
      child.stdin.end();
      return closed;
    },
    /** Kills Claude Code itself (sandbox-exec execs it in place): no hook runs after this. */
    kill: (signal) => {
      child.kill(signal);
      return closed;
    },
  };
}

/** The command `claude mcp add` registers: Debrief from this checkout's dist, with the no-network guard preloaded. */
export const DEBRIEF_COMMAND = [process.execPath, "--import", NO_NETWORK, CLI, "mcp", "--host", "claude-code"];

/**
 * `claude mcp add` for Debrief in user scope. Claude Code would pass its own environment on
 * anyway; `-e` pins DEBRIEF_HOME whatever the environment Claude is started from.
 */
export function debriefAddArgs(options: { debriefHome: string; networkLog: string }): string[] {
  return ["mcp", "add", "debrief", "-s", "user", "-e", `DEBRIEF_HOME=${options.debriefHome}`, "-e", `DEBRIEF_NETWORK_LOG=${options.networkLog}`, "--", ...DEBRIEF_COMMAND];
}

/** Every line Claude Code logged for one MCP server (its stderr included), from the sandbox's cache. */
export function mcpServerLog(sandbox: ClaudeSandbox, server: string): string {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === `mcp-logs-${server}`) for (const file of readdirSync(full)) found.push(readFileSync(join(full, file), "utf8"));
      else walk(full);
    }
  };
  walk(sandbox.home);
  return found.join("");
}

export interface StubToolUse {
  /** Tool name inside the Debrief namespace, e.g. "memory_bootstrap"; with `builtin`, the host's own tool, e.g. "Agent". */
  tool: string;
  builtin?: boolean;
  input: Record<string, unknown>;
  /**
   * Made only once a request contains this text (a later prompt), or satisfies this test (a
   * sub-agent's request: see {@link firstUserText}); otherwise at the first request that offers the tool.
   */
  when?: string | ((request: Record<string, unknown>) => boolean);
}

/**
 * A localhost Messages API: while calls remain queued, each request that offers the next one's
 * tool is answered with it as a `tool_use` (Claude Code names Debrief's `mcp__debrief__<tool>`, or `mcpPrefix`);
 * once the queue is empty, and for any request that does not offer it, with a
 * plain assistant message (`reply`, or what it returns for that request) that ends the turn. `requests` keeps every Messages request body, in order.
 */
export async function startStubMessages(script: {
  calls: StubToolUse[];
  reply: string | ((request: Record<string, unknown>) => string);
  /** How Claude Code names Debrief's tools: `mcp__debrief__` (user scope, the default) or the plugin's `mcp__plugin_debrief_debrief__`. */
  mcpPrefix?: string;
  /** Requests never answered: Claude Code waits on them mid-turn (to be killed there). `held` resolves at the first. */
  hold?: (request: Record<string, unknown>) => boolean;
}): Promise<{ port: number; offeredTools: string[][]; requests: Record<string, unknown>[]; held: Promise<Record<string, unknown>> }> {
  let onHeld: (request: Record<string, unknown>) => void = () => undefined;
  const held = new Promise<Record<string, unknown>>((resolve) => (onHeld = resolve));
  const state = { port: 0, offeredTools: [] as string[][], requests: [] as Record<string, unknown>[], held };
  const queue = [...script.calls];
  let n = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      n++;
      if (req.method !== "POST" || req.url?.startsWith("/v1/messages?") !== true) {
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      const json = JSON.parse(body) as { model?: string; stream?: boolean; tools?: { name: string }[] } & Record<string, unknown>;
      state.requests.push(json);
      if (script.hold?.(json) === true) {
        onHeld(json);
        return;
      }
      const tools = (json.tools ?? []).map((t) => t.name);
      state.offeredTools.push(tools);
      const head = queue[0];
      const name = (call: StubToolUse): string => (call.builtin === true ? call.tool : `${script.mcpPrefix ?? "mcp__debrief__"}${call.tool}`);
      const next = head !== undefined && tools.includes(name(head)) && (head.when === undefined || (typeof head.when === "string" ? body.includes(head.when) : head.when(json))) ? queue.shift() : undefined;
      const usage = { input_tokens: 1, output_tokens: 1 };
      const reply = typeof script.reply === "string" ? script.reply : script.reply(json);
      const stop = next === undefined ? "end_turn" : "tool_use";
      const block =
        next === undefined
          ? { type: "text", text: reply }
          : { type: "tool_use", id: `toolu_stub_${n}`, name: name(next), input: next.input };
      if (json.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `msg_stub_${n}`, type: "message", role: "assistant", model: json.model, content: [block], stop_reason: stop, stop_sequence: null, usage }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, data: Record<string, unknown>): boolean => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send("message_start", { message: { id: `msg_stub_${n}`, type: "message", role: "assistant", model: json.model, content: [], stop_reason: null, stop_sequence: null, usage } });
      if (next === undefined) {
        send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        send("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply } });
      } else {
        send("content_block_start", { index: 0, content_block: { ...block, input: {} } });
        send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(next.input) } });
      }
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
      send("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  state.port = typeof address === "object" && address !== null ? address.port : 0;
  onCleanup(() => {
    server.closeAllConnections();
    server.close();
  });
  return state;
}

/**
 * The text of a Messages request's first user message: the prompt that started the conversation,
 * which for a sub-agent is the prompt its parent gave it (the parent's own requests carry that
 * prompt only inside the Agent tool call).
 */
export function firstUserText(request: Record<string, unknown>): string {
  const first = ((request["messages"] ?? []) as { role: string; content: unknown }[]).find((m) => m.role === "user");
  if (first === undefined) return "";
  return typeof first.content === "string" ? first.content : (first.content as { type: string; text?: string }[]).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("\n");
}

/** Tool calls and results a Claude Code session transcript recorded, in order. */
export function sessionToolTraffic(sandbox: ClaudeSandbox, sessionId: string): { uses: string[]; results: string[] } {
  const projects = join(sandbox.configDir, "projects");
  const file = readdirSync(projects)
    .map((dir) => join(projects, dir, `${sessionId}.jsonl`))
    .find((candidate) => existsSync(candidate));
  if (file === undefined) throw new Error(`no transcript for session ${sessionId}`);
  const uses: string[] = [];
  const results: string[] = [];
  for (const line of readFileSync(file, "utf8").trim().split("\n")) {
    const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as { type: string; name?: string; content?: unknown }[]) {
      if (block.type === "tool_use" && block.name !== undefined) uses.push(block.name);
      if (block.type === "tool_result") {
        const text = Array.isArray(block.content) ? (block.content as { text?: string }[]).map((c) => c.text ?? "").join("") : String(block.content);
        results.push(text);
      }
    }
  }
  return { uses, results };
}
