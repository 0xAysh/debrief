import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { hostGate } from "../host-skips.js";
import { CLI } from "../mcp/harness.js";
import { CLAUDE_PINNED_VERSION, claude, claudeAsync, claudeEnv, claudeSandbox, claudeSkipReason, startStubMessages } from "../mcp/claude.js";
import { installPackedDebrief, installPlugin, pathWith, PLUGIN_TOOL, ROOT, streamEvents, STUB_KEY } from "./plugin-install.js";

/**
 * Seam ② for #32: the Claude Code plugin in this repository, installed by the real Claude Code
 * from this repository's marketplace, running the debrief command that `npm pack` produced
 * (installed offline into a temporary prefix put on PATH, as `npm install -g` would).
 */

const SKIP = hostGate("claude code plugin tests", "claude", claudeSkipReason());

const IMPORT_QUESTION = "Transcript import needs the user's answer";

describe.skipIf(SKIP !== null)(`the Debrief plugin in the real Claude Code ${CLAUDE_PINNED_VERSION}`, () => {
  test("installed from this repository's marketplace, it gives a first session the MCP server and every hook, and the import question is asked once", async () => {
    const bin = installPackedDebrief();
    const sandbox = claudeSandbox();
    installPlugin(sandbox, pathWith(bin));
    const details = claude(claudeEnv(sandbox, { PATH: pathWith(bin) }), ROOT, "plugin", "details", "debrief@debrief");
    expect(details.stdout).toMatch(/Hooks \(5\)\s+SessionStart, SubagentStart, UserPromptSubmit, PreToolUse, Stop/);
    expect(details.stdout).toMatch(/MCP servers \(1\)\s+debrief/);

    const repo = initRepo({ branch: "fix/double-charge" });
    const debriefHome = tempDir();
    const debriefStatus = (cwd = repo) => {
      const run = spawnSync(join(bin, "debrief"), ["status"], { cwd, encoding: "utf8", timeout: 30_000, env: claudeEnv(sandbox, { PATH: pathWith(bin), DEBRIEF_HOME: debriefHome }) });
      return { code: run.status, stdout: run.stdout, stderr: run.stderr };
    };

    // Installed, but no session yet: the hooks that run every session have never run.
    const fresh = debriefStatus();
    expect(fresh.code, fresh.stderr).toBe(1);
    expect(fresh.stdout).toMatch(/^ {2}plugin {9}✔ debrief@debrief 0\.1\.0, enabled$/m);
    expect(fresh.stdout).toMatch(/^ {2}MCP server {5}✔ answering with \d+ tools \(debrief mcp --host claude-code\)$/m);
    for (const event of ["session-start", "user-prompt-submit", "stop"]) expect(fresh.stdout).toMatch(new RegExp(`^ {2}(?:hooks {10}| {15})✘ ${event} +never ran: start a new Claude Code session; if it still has not run, the hook is not firing$`, "m"));
    expect(fresh.stdout).toMatch(/^ {2}hooks {10}✘ session-start/m);
    expect(fresh.stdout).toMatch(/^ {17}· subagent-start +never ran \(it runs when a sub-agent starts\)$/m);
    expect(fresh.stdout).toMatch(/^ {17}· pre-tool-use +never ran \(it runs when the agent calls a Debrief tool\)$/m);
    expect(fresh.stdout).toMatch(/^ {2}last capture {3}never$/m);
    expect(fresh.stdout).toMatch(/^ {2}import {9}not answered yet: the agent asks at the next session start$/m);
    expect(fresh.stdout).toMatch(/^✘ 3 problems$/m);
    const drive = async (prompt: string, calls: { tool: string; input: Record<string, unknown> }[], ...args: string[]) => {
      const stub = await startStubMessages({ calls, reply: `SYNTHETIC-REPLY to ${prompt}`, mcpPrefix: PLUGIN_TOOL });
      const env = claudeEnv(sandbox, { PATH: pathWith(bin), DEBRIEF_HOME: debriefHome, ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: STUB_KEY });
      const run = await claudeAsync(env, repo, "-p", prompt, "--output-format", "stream-json", "--verbose", ...args);
      expect(run.code, run.stderr).toBe(0);
      return { stub, events: streamEvents(run.stdout) };
    };

    // First session: memory context and the import question arrive before any tool call; a
    // read-only Debrief call under the plugin's tool name runs without a permission prompt.
    const first = await drive("SYNTHETIC-PROMPT-1 where did we leave the double-charge fix?", [{ tool: "memory_status", input: {} }]);
    const opening = JSON.stringify(first.stub.requests[0] ?? {});
    expect(opening).toContain("SessionStart hook additional context: ");
    expect(opening).toContain(IMPORT_QUESTION);
    expect(first.stub.offeredTools[0]).toEqual(expect.arrayContaining([`${PLUGIN_TOOL}memory_bootstrap`, `${PLUGIN_TOOL}memory_recall`, `${PLUGIN_TOOL}memory_checkpoint`]));
    expect(JSON.stringify(first.stub.requests[1] ?? {}), "the status call ran and returned Debrief's report").toContain("sqliteVersion");
    const status = () => {
      const memory = openMemory({ cwd: repo, home: debriefHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
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

    // Next session: not asked again, and its turn is captured at Stop. What a Debrief tool
    // returned under the plugin's name is not imported back as new memory.
    const setup = openMemory({ cwd: repo, home: debriefHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    setup.record({ kind: "note", body: "SYNTHETIC-ECHO-7c3 the idempotency key lives in charge()", attribution: "agent_inference" });
    setup.close();
    const third = await drive("SYNTHETIC-PROMPT-3 continue", [{ tool: "memory_recall", input: { query: "SYNTHETIC-ECHO-7c3" } }]);
    expect(JSON.stringify(third.stub.requests[0] ?? {})).not.toContain(IMPORT_QUESTION);
    expect(third.events.filter((e) => e.subtype === "informational").map((e) => e.content)).toContain(`PreToolUse:${PLUGIN_TOOL}memory_recall says: ◪ debrief · recalling: SYNTHETIC-ECHO-7c3`);
    const after = openMemory({ cwd: repo, home: debriefHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      after.close();
    });
    const excerpts = (query: string) => after.recall({ query, maxTokens: 8_000 }).items.map((i) => i.excerpt);
    expect(excerpts("SYNTHETIC-PROMPT-3").some((t) => t.includes("SYNTHETIC-PROMPT-3 continue"))).toBe(true);
    expect(excerpts("SYNTHETIC-ECHO-7c3 idempotency").filter((t) => t.includes("SYNTHETIC-ECHO-7c3"))).toHaveLength(1);
    after.close();

    const healthy = debriefStatus();
    expect(healthy.code, healthy.stdout + healthy.stderr).toBe(0);
    for (const event of ["session-start", "user-prompt-submit", "pre-tool-use", "stop"]) expect(healthy.stdout).toMatch(new RegExp(`^ {2}(?:hooks {10}| {15})✔ ${event} +ok, (?:just now|\\d+s ago)$`, "m"));
    expect(healthy.stdout).toMatch(/^ {2}last capture {3}(just now|\d+s ago)$/m);
    expect(healthy.stdout).toMatch(/^ {2}capture gaps {3}none$/m);
    expect(healthy.stdout).toMatch(/^ {2}import {9}current_project$/m);
    expect(healthy.stdout).toMatch(/^ {2}preferences {4}no questions waiting$/m);
    expect(healthy.stdout).toMatch(/^ {2}meaning search ✔ snowflake-arctic-embed-xs@q8 loads; .* searchable by meaning/m);
    expect(healthy.stdout).toMatch(/^✔ healthy$/m);

    // An installed model that no longer loads is a problem, not a silent fall back to keyword search.
    const model = join(dirname(realpathSync(join(bin, "debrief"))), "models", "snowflake-arctic-embed-xs", "model_quantized.onnx");
    const weights = readFileSync(model);
    writeFileSync(model, weights.subarray(0, 1024));
    const unloadable = debriefStatus();
    writeFileSync(model, weights);
    expect(unloadable.code).toBe(1);
    expect(unloadable.stdout).toMatch(/^ {2}meaning search ✘ snowflake-arctic-embed-xs@q8 failed to load: model_quantized\.onnx does not match the pinned model .*; recall finds memory by its words only$/m);
    expect(unloadable.stdout).toMatch(/^✘ 1 problem$/m);

    // From another repository: the hooks fire, in the repository named.
    const elsewhere = debriefStatus(initRepo());
    expect(elsewhere.stdout).toMatch(new RegExp(`^ {17}✔ stop +ok, (?:just now|\\d+s ago) \\(in ${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)$`, "m"));

    // An installed copy whose server command fails at startup: the handshake says why.
    const installs = JSON.parse(readFileSync(join(sandbox.configDir, "plugins", "installed_plugins.json"), "utf8")) as { plugins: Record<string, { installPath: string }[]> };
    const installed = installs.plugins["debrief@debrief"]?.[0]?.installPath ?? "";
    const mcpFile = join(installed, ".mcp.json");
    const mcp = readFileSync(mcpFile, "utf8");
    writeFileSync(mcpFile, mcp.replace('"claude-code"', '"no-such-host"'));
    const crashing = debriefStatus();
    expect(crashing.code).toBe(1);
    expect(crashing.stdout).toMatch(/^ {2}MCP server {5}✘ could not start debrief mcp --host no-such-host: .*debrief: unknown --host no-such-host/m);
    writeFileSync(mcpFile, mcp);

    // An installed copy that no longer registers a hook (edited, or from an older plugin) is a problem.
    const hooksFile = join(installed, "hooks", "hooks.json");
    const registered = JSON.parse(readFileSync(hooksFile, "utf8")) as { hooks: Record<string, unknown> };
    delete registered.hooks["Stop"];
    writeFileSync(hooksFile, JSON.stringify(registered));
    const edited = debriefStatus();
    expect(edited.code).toBe(1);
    expect(edited.stdout).toMatch(/^ {17}✘ stop {17}not registered by the installed plugin: reinstall it$/m);
  }, 180_000);

  test("without the debrief command on PATH, session start says how to install it and every other hook stays quiet", async () => {
    const sandbox = claudeSandbox();
    installPlugin(sandbox, pathWith(null));
    const stub = await startStubMessages({ calls: [], reply: "SYNTHETIC-REPLY fine." });
    const env = claudeEnv(sandbox, { PATH: pathWith(null), DEBRIEF_HOME: tempDir(), ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: STUB_KEY });
    const run = await claudeAsync(env, initRepo(), "-p", "SYNTHETIC-PROMPT hello", "--output-format", "stream-json", "--verbose");
    expect(run.code, run.stderr).toBe(0);
    const events = streamEvents(run.stdout);
    expect(events.filter((e) => e.subtype === "hook_response").map((e) => [e.hook_event, e.exit_code])).toEqual(expect.arrayContaining([["SessionStart", 0]]));
    expect(JSON.stringify(events)).toContain("◪ debrief · not running: the debrief command is not on PATH (npm install -g debrief-cli)");
    expect(events.filter((e) => e.subtype === "hook_response" && e.exit_code !== 0)).toEqual([]);
    expect(JSON.stringify(stub.requests)).not.toContain("◪ debrief");

    // Status itself runs from the checkout here; the plugin's server command is what is missing.
    const status = spawnSync(process.execPath, [CLI, "status"], { cwd: initRepo(), encoding: "utf8", timeout: 30_000, env: claudeEnv(sandbox, { PATH: pathWith(null), DEBRIEF_HOME: tempDir() }) });
    expect(status.status, status.stderr).toBe(1);
    expect(status.stdout).toMatch(/^ {2}MCP server {5}✘ could not start debrief mcp --host claude-code: debrief is not on PATH \(npm install -g debrief-cli\)$/m);
  }, 120_000);
});
