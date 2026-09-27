import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { CLAUDE_PINNED_VERSION, claude, claudeAsync, claudeEnv, claudeSandbox, claudeSkipReason, startStubMessages, type ClaudeSandbox } from "../mcp/claude.js";

/**
 * Seam ② for #32: the Claude Code plugin in this repository, installed by the real Claude Code
 * from this repository's marketplace, running the memchor command that `npm pack` produced
 * (installed offline into a temporary prefix put on PATH, as `npm install -g` would).
 */

const SKIP = claudeSkipReason();
if (SKIP !== null) process.stderr.write(`claude code plugin tests skipped: ${SKIP}\n`);

const ROOT = resolve(import.meta.dirname, "../..");
const PLUGIN_TOOL = "mcp__plugin_memchor_memchor__";
const STUB_KEY = "sk-ant-stub-000";
const IMPORT_QUESTION = "Transcript import needs the user's answer";

/** `npm pack` of this checkout, installed with `npm install --global --prefix` from npm's cache; returns the prefix's bin directory. */
function installPackedMemchor(): string {
  const dir = tempDir("memchor-pack-");
  const packed = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], { cwd: ROOT, encoding: "utf8" });
  expect(packed.status, packed.stderr).toBe(0);
  const tarball = join(dir, packed.stdout.trim().split("\n").at(-1) ?? "");
  const installed = spawnSync("npm", ["install", "--global", "--prefix", join(dir, "prefix"), "--offline", "--no-audit", "--no-fund", tarball], { encoding: "utf8", timeout: 120_000 });
  expect(installed.status, `offline install from npm's cache failed (run npm ci once): ${installed.stderr}`).toBe(0);
  return join(dir, "prefix", "bin");
}

/** PATH with `bin` first (null: with no memchor at all), and the node that runs these tests. */
function pathWith(bin: string | null): string {
  const rest = (process.env["PATH"] ?? "").split(delimiter).filter((d) => d !== "" && !existsSync(join(d, "memchor")));
  return [...(bin === null ? [] : [bin]), dirname(process.execPath), ...rest].join(delimiter);
}

function installPlugin(sandbox: ClaudeSandbox, path: string): void {
  const env = claudeEnv(sandbox, { PATH: path });
  const added = claude(env, ROOT, "plugin", "marketplace", "add", ROOT);
  expect(added.code, added.stdout + added.stderr).toBe(0);
  const installed = claude(env, ROOT, "plugin", "install", "memchor@memchor");
  expect(installed.code, installed.stdout + installed.stderr).toBe(0);
}

interface StreamEvent {
  type: string;
  subtype?: string;
  content?: string;
  hook_event?: string;
  output?: string;
  exit_code?: number;
}

function streamEvents(stdout: string): StreamEvent[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StreamEvent);
}

describe.skipIf(SKIP !== null)(`the Memchor plugin in the real Claude Code ${CLAUDE_PINNED_VERSION}`, () => {
  test("installed from this repository's marketplace, it gives a first session the MCP server and every hook, and the import question is asked once", async () => {
    const bin = installPackedMemchor();
    const sandbox = claudeSandbox();
    installPlugin(sandbox, pathWith(bin));
    const details = claude(claudeEnv(sandbox, { PATH: pathWith(bin) }), ROOT, "plugin", "details", "memchor@memchor");
    expect(details.stdout).toMatch(/Hooks \(5\)\s+SessionStart, SubagentStart, UserPromptSubmit, PreToolUse, Stop/);
    expect(details.stdout).toMatch(/MCP servers \(1\)\s+memchor/);

    const repo = initRepo({ branch: "fix/double-charge" });
    const memchorHome = tempDir();
    const drive = async (prompt: string, calls: { tool: string; input: Record<string, unknown> }[], ...args: string[]) => {
      const stub = await startStubMessages({ calls, reply: `SYNTHETIC-REPLY to ${prompt}`, mcpPrefix: PLUGIN_TOOL });
      const env = claudeEnv(sandbox, { PATH: pathWith(bin), MEMCHOR_HOME: memchorHome, ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: STUB_KEY });
      const run = await claudeAsync(env, repo, "-p", prompt, "--output-format", "stream-json", "--verbose", ...args);
      expect(run.code, run.stderr).toBe(0);
      return { stub, events: streamEvents(run.stdout) };
    };

    // First session: memory context and the import question arrive before any tool call; a
    // read-only Memchor call under the plugin's tool name runs without a permission prompt.
    const first = await drive("SYNTHETIC-PROMPT-1 where did we leave the double-charge fix?", [{ tool: "memory_status", input: {} }]);
    const opening = JSON.stringify(first.stub.requests[0] ?? {});
    expect(opening).toContain("SessionStart hook additional context: ");
    expect(opening).toContain(IMPORT_QUESTION);
    expect(first.stub.offeredTools[0]).toEqual(expect.arrayContaining([`${PLUGIN_TOOL}memory_bootstrap`, `${PLUGIN_TOOL}memory_recall`, `${PLUGIN_TOOL}memory_checkpoint`]));
    expect(JSON.stringify(first.stub.requests[1] ?? {}), "the status call ran and returned Memchor's report").toContain("sqliteVersion");
    const status = () => {
      const memory = openMemory({ cwd: repo, home: memchorHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
      onCleanup(() => {
        memory.close();
      });
      try {
        return memory.status();
      } finally {
        memory.close();
      }
    };
    expect(status().hookRuns.map((r) => [r.event, r.outcome, r.cwd])).toEqual([
      ["pre-tool-use", "ok", repo],
      ["session-start", "ok", repo],
      ["stop", "ok", repo],
      ["user-prompt-submit", "ok", repo],
    ]);
    expect(status().hookFailures).toEqual([]);

    // The user answers (the agent relays it, with the user's approval of that write).
    await drive("SYNTHETIC-PROMPT-2 import this project's history", [{ tool: "memory_bootstrap", input: { importChoice: "current_project" } }], "--allowedTools", `${PLUGIN_TOOL}memory_bootstrap`);
    expect(status().import?.consent?.choice).toBe("current_project");

    // Next session: not asked again, and its turn is captured at Stop. What a Memchor tool
    // returned under the plugin's name is not imported back as new memory.
    const setup = openMemory({ cwd: repo, home: memchorHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    setup.record({ kind: "note", body: "SYNTHETIC-ECHO-7c3 the idempotency key lives in charge()", attribution: "agent_inference" });
    setup.close();
    const third = await drive("SYNTHETIC-PROMPT-3 continue", [{ tool: "memory_recall", input: { query: "SYNTHETIC-ECHO-7c3" } }]);
    expect(JSON.stringify(third.stub.requests[0] ?? {})).not.toContain(IMPORT_QUESTION);
    expect(third.events.filter((e) => e.subtype === "informational").map((e) => e.content)).toContain(`PreToolUse:${PLUGIN_TOOL}memory_recall says: ◪ memchor · recalling: SYNTHETIC-ECHO-7c3`);
    const after = openMemory({ cwd: repo, home: memchorHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      after.close();
    });
    const excerpts = (query: string) => after.recall({ query, maxTokens: 8_000 }).items.map((i) => i.excerpt);
    expect(excerpts("SYNTHETIC-PROMPT-3").some((t) => t.includes("SYNTHETIC-PROMPT-3 continue"))).toBe(true);
    expect(excerpts("SYNTHETIC-ECHO-7c3 idempotency").filter((t) => t.includes("SYNTHETIC-ECHO-7c3"))).toHaveLength(1);
    after.close();
  }, 180_000);

  test("without the memchor command on PATH, session start says how to install it and every other hook stays quiet", async () => {
    const sandbox = claudeSandbox();
    installPlugin(sandbox, pathWith(null));
    const stub = await startStubMessages({ calls: [], reply: "SYNTHETIC-REPLY fine." });
    const env = claudeEnv(sandbox, { PATH: pathWith(null), MEMCHOR_HOME: tempDir(), ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: STUB_KEY });
    const run = await claudeAsync(env, initRepo(), "-p", "SYNTHETIC-PROMPT hello", "--output-format", "stream-json", "--verbose");
    expect(run.code, run.stderr).toBe(0);
    const events = streamEvents(run.stdout);
    expect(events.filter((e) => e.subtype === "hook_response").map((e) => [e.hook_event, e.exit_code])).toEqual(expect.arrayContaining([["SessionStart", 0]]));
    expect(JSON.stringify(events)).toContain("◪ memchor · not running: the memchor command is not on PATH (npm install -g memchor)");
    expect(events.filter((e) => e.subtype === "hook_response" && e.exit_code !== 0)).toEqual([]);
    expect(JSON.stringify(stub.requests)).not.toContain("◪ memchor");
  }, 120_000);
});
