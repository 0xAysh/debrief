import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { locateWorkspace } from "../../src/bootstrap/workspace-resolution.js";
import { openMemory } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeTurn, installTranscript } from "../import/fixtures.js";
import { CLAUDE_PINNED_VERSION, claude, claudeAsync, claudeEnv, claudeSandbox, claudeSkipReason, memchorAddArgs, sessionToolTraffic, startStubMessages } from "../mcp/claude.js";
import { CLI, NO_NETWORK } from "../mcp/harness.js";

/**
 * Seam ② for #29 with Memchor's own hooks: the real Claude Code runs `memchor hook
 * session-start`, `stop`, `user-prompt-submit` and `pre-tool-use`, registered with `--settings`,
 * against a localhost stub model. What the model received is read from the stub's request bodies.
 */

const SKIP = claudeSkipReason();

function hooksSettings(memchorHome: string): string {
  const memchor = (args: string) => `MEMCHOR_HOME='${memchorHome}' '${process.execPath}' --import '${NO_NETWORK}' '${CLI}' hook ${args} --host claude-code`;
  const path = join(tempDir(), "settings.json");
  writeFileSync(
    path,
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: memchor("session-start") }] }],
        Stop: [{ hooks: [{ type: "command", command: memchor("stop") }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: memchor("user-prompt-submit") }] }],
        PreToolUse: [{ matcher: "mcp__(plugin_memchor_)?memchor__.*", hooks: [{ type: "command", command: memchor("pre-tool-use") }] }],
      },
    }),
  );
  return path;
}

describe.skipIf(SKIP !== null)(`Memchor's hooks in the real Claude Code ${CLAUDE_PINNED_VERSION}`, () => {
  test("the model starts with the checkpoint in context without any tool call, the turn is captured when it stops, and the next session starts with it digested", async () => {
    const sandbox = claudeSandbox();
    const repo = initRepo({ branch: "fix/double-charge" });
    const memchorHome = tempDir();
    const setup = openMemory({ cwd: repo, home: memchorHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      setup.close();
    });
    setup.bootstrap({ importChoice: "current_project" });
    setup.checkpoint({ expectedRevision: 0, goal: "Stop double charges", status: "Key drafted", nextSteps: ["SYNTHETIC-NEXT wire the idempotency key into charge()"] });
    setup.close();

    const stub = await startStubMessages({ calls: [], reply: "SYNTHETIC-REPLY the key goes into charge()." });
    const run = await claudeAsync(
      claudeEnv(sandbox, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: "sk-ant-stub-000" }),
      repo,
      "-p",
      "SYNTHETIC-PROMPT where did we leave the double-charge fix?",
      "--output-format",
      "json",
      "--settings",
      hooksSettings(memchorHome),
    );
    expect(run.code, run.stderr).toBe(0);

    const first = JSON.stringify(stub.requests[0] ?? {});
    expect(first).toContain("SessionStart hook additional context: ");
    expect(first).toContain("SYNTHETIC-NEXT wire the idempotency key into charge()");
    expect(first).toContain("Memchor is local working memory shared by the coding agents in this repository.");
    // The notice is for the user only.
    expect(JSON.stringify(stub.requests)).not.toContain("◪ memchor");
    expect(stub.offeredTools.flat().filter((t) => t.startsWith("mcp__"))).toEqual([]);

    const after = openMemory({ cwd: repo, home: memchorHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      after.close();
    });
    const texts = after.recall({ query: "SYNTHETIC-PROMPT double-charge", maxTokens: 8_000 }).items.map((i) => i.excerpt);
    expect(texts.some((t) => t.includes("SYNTHETIC-PROMPT where did we leave the double-charge fix?"))).toBe(true);
    expect(after.status().hookFailures).toEqual([]);
    after.close();

    // The next session starts with that turn digested under the checkpoint, still without a tool call.
    const next = await startStubMessages({ calls: [], reply: "Continuing." });
    const second = await claudeAsync(
      claudeEnv(sandbox, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${next.port}`, ANTHROPIC_API_KEY: "sk-ant-stub-000" }),
      repo,
      "-p",
      "Continue.",
      "--output-format",
      "json",
      "--settings",
      hooksSettings(memchorHome),
    );
    expect(second.code, second.stderr).toBe(0);
    const context = JSON.stringify(next.requests[0] ?? {});
    expect(context).toContain("## Since checkpoint r1 (claude-code, ended ");
    expect(context).toContain("- SYNTHETIC-PROMPT where did we leave the double-charge fix?");
  });

  test("a lasting-preference prompt reaches the model with the hint; a recall runs without a prompt, a write is still denied in -p; notices stay with the user", async () => {
    const sandbox = claudeSandbox();
    const repo = initRepo({ branch: "fix/double-charge" });
    const memchorHome = tempDir();
    const added = claude(claudeEnv(sandbox), repo, ...memchorAddArgs({ memchorHome, networkLog: join(tempDir(), "network.log") }));
    expect(added.code, added.stderr).toBe(0);
    const setup = openMemory({ cwd: repo, home: memchorHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      setup.close();
    });
    setup.bootstrap({ importChoice: "current_project" });
    setup.close();

    const stub = await startStubMessages({
      calls: [
        { tool: "memory_recall", input: { query: "retry policy" } },
        { tool: "memory_record", input: { kind: "note", body: "SYNTHETIC-WRITE", attribution: "agent_inference" } },
      ],
      reply: "Noted.",
    });
    const run = await claudeAsync(
      claudeEnv(sandbox, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: "sk-ant-stub-000" }),
      repo,
      "-p",
      "From now on, run the tests with --runInBand.",
      "--output-format",
      "json",
      "--settings",
      hooksSettings(memchorHome),
    );
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.stringify(stub.requests[0] ?? {})).toContain("UserPromptSubmit hook additional context: Memchor: the user's wording may state a lasting preference.");

    const result = JSON.parse(run.stdout) as { session_id: string; permission_denials: { tool_name: string }[] };
    expect(result.permission_denials.map((d) => d.tool_name)).toEqual(["mcp__memchor__memory_record"]);
    const traffic = sessionToolTraffic(sandbox, result.session_id);
    expect(traffic.uses).toEqual(["mcp__memchor__memory_recall", "mcp__memchor__memory_record"]);
    expect(traffic.results[0]).toContain('"items"');
    expect(JSON.stringify(stub.requests)).not.toContain("◪ memchor");
  }, 120_000);

  test("the fifth turn of work with no checkpoint: the stop is blocked once, the model gets the reason, and the continued stop ends the turn", async () => {
    const sandbox = claudeSandbox();
    const repo = initRepo({ branch: "fix/double-charge" });
    const memchorHome = tempDir();
    // Four earlier turns that ran commands, in a session an hour ago.
    const earlier = "e0d00000-0000-4000-8000-0000000000aa";
    const { path } = installTranscript(sandbox.configDir, "", { cwd: repo, sessionId: earlier, content: "" });
    let after: string | null = null;
    for (let n = 1; n <= 4; n++) {
      const turn = claudeTurn({ cwd: repo, sessionId: earlier, n, at: new Date(Date.now() - 3_600_000 + n * 1_000), prompt: `Step ${n}.`, command: "npm test", after });
      after = turn.last;
      appendFileSync(path, turn.lines);
    }
    const setup = openMemory({ cwd: repo, home: memchorHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      setup.close();
    });
    setup.bootstrap({ importChoice: "current_project" });
    setup.close();

    const stub = await startStubMessages({ calls: [], reply: "Step 5 done." });
    const run = await claudeAsync(
      claudeEnv(sandbox, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: "sk-ant-stub-000" }),
      repo,
      "-p",
      "Step 5.",
      "--output-format",
      "json",
      "--settings",
      hooksSettings(memchorHome),
    );
    expect(run.code, run.stderr).toBe(0);
    expect(stub.requests).toHaveLength(2);
    expect(JSON.stringify(stub.requests[0])).not.toContain("Stop hook feedback");
    expect(JSON.stringify(stub.requests[1])).toContain("Stop hook feedback:\\nMemchor: 5 turns since the last checkpoint (none yet), with files changed or commands run.");
    // The user's "saved turn" line went with the block, but never to the model.
    expect(JSON.stringify(stub.requests)).not.toContain("◪ memchor");
    const check = openMemory({ cwd: repo, home: memchorHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      check.close();
    });
    expect(check.status().hookFailures).toEqual([]);
    // Claude Code writes the reason into the transcript; it is the host talking, not the user, so it is never a prompt.
    const live = (JSON.parse(run.stdout) as { session_id: string }).session_id;
    expect(readFileSync(join(sandbox.configDir, "projects", repo.replaceAll("/", "-"), `${live}.jsonl`), "utf8")).toContain("turns since the last checkpoint");
    const stored = check.recall({ query: "Stop hook feedback turns since the last checkpoint", maxTokens: 8_000 }).items.map((i) => i.excerpt);
    expect(stored.filter((excerpt) => excerpt.includes("turns since the last checkpoint"))).toEqual([]);
  }, 120_000);

  test("\"don't remember this session\" through MCP also forgets a turn the hooks captured before any Memchor call, and the MCP server is the same session as the hooks", async () => {
    const sandbox = claudeSandbox();
    const repo = initRepo({ branch: "fix/double-charge" });
    const memchorHome = tempDir();
    const added = claude(claudeEnv(sandbox), repo, ...memchorAddArgs({ memchorHome, networkLog: join(tempDir(), "network.log") }));
    expect(added.code, added.stderr).toBe(0);
    const setup = openMemory({ cwd: repo, home: memchorHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      setup.close();
    });
    setup.bootstrap({ importChoice: "current_project" });
    setup.close();

    // Turn 1 makes no Memchor call; the Stop hook captures it.
    const stub = await startStubMessages({ calls: [], reply: "SYNTHETIC-PRIVATE-REPLY noted." });
    const env = claudeEnv(sandbox, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: "sk-ant-stub-000" });
    const first = await claudeAsync(env, repo, "-p", "SYNTHETIC-PRIVATE-PROMPT the staging password rotation", "--output-format", "json", "--settings", hooksSettings(memchorHome));
    expect(first.code, first.stderr).toBe(0);
    const live = (JSON.parse(first.stdout) as { session_id: string }).session_id;
    const captured = openMemory({ cwd: repo, home: memchorHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      captured.close();
    });
    expect(captured.recall({ query: "SYNTHETIC-PRIVATE-PROMPT", maxTokens: 8_000 }).items.map((i) => i.excerpt).join("\n")).toContain("SYNTHETIC-PRIVATE-PROMPT");
    captured.close();

    // Turn 2, resumed: the agent calls memory_manage private_session and nothing else.
    const manage = await startStubMessages({ calls: [{ tool: "memory_manage", input: { action: "private_session" } }], reply: "SYNTHETIC-PRIVATE-DONE forgotten." });
    const second = await claudeAsync(
      claudeEnv(sandbox, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${manage.port}`, ANTHROPIC_API_KEY: "sk-ant-stub-000" }),
      repo,
      "-p",
      "--resume",
      live,
      "SYNTHETIC-PRIVATE-ASK don't remember this session",
      "--output-format",
      "json",
      "--allowedTools",
      "mcp__memchor__memory_manage",
      "--settings",
      hooksSettings(memchorHome),
    );
    expect(second.code, second.stderr).toBe(0);
    const traffic = sessionToolTraffic(sandbox, (JSON.parse(second.stdout) as { session_id: string }).session_id);
    expect(traffic.uses).toEqual(["mcp__memchor__memory_manage"]);
    expect(traffic.results[0]).toContain('"action":"private_session"');

    // The MCP server's session carries Claude's session id, like the hooks' sessions.
    const db = new Database(locateWorkspace(repo, memchorHome).dbPath, { readonly: true });
    onCleanup(() => {
      db.close();
    });
    const sessions = db.prepare("SELECT host_session_id AS id, private FROM sessions WHERE host = 'claude-code' ORDER BY started_at").all() as { id: string | null; private: number }[];
    db.close();
    expect(sessions.filter((s) => s.private === 1).map((s) => s.id)).toEqual([live]);

    // Nothing from either turn is recalled, and a later import pass does not bring it back.
    const after = openMemory({ cwd: repo, home: memchorHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      after.close();
    });
    after.bootstrap({});
    const left = after.recall({ query: "SYNTHETIC-PRIVATE-PROMPT SYNTHETIC-PRIVATE-REPLY SYNTHETIC-PRIVATE-ASK SYNTHETIC-PRIVATE-DONE", maxTokens: 8_000 }).items.map((i) => i.excerpt);
    expect(left.filter((excerpt) => excerpt.includes("SYNTHETIC-PRIVATE"))).toEqual([]);
    expect(after.status().hookFailures).toEqual([]);
  }, 120_000);
});
