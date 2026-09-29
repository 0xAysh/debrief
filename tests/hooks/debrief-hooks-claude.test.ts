import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { locateWorkspace } from "../../src/bootstrap/workspace-resolution.js";
import { openMemory } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { hostGate } from "../host-skips.js";
import { claudeTurn, installTranscript } from "../import/fixtures.js";
import { CLAUDE_PINNED_VERSION, claude, claudeAsync, claudeEnv, claudeSandbox, claudeSkipReason, claudeStream, firstUserText, debriefAddArgs, sessionToolTraffic, startStubMessages } from "../mcp/claude.js";
import { CLI, NO_NETWORK } from "../mcp/harness.js";

/**
 * Seam ② for #29 and #40 with Debrief's own hooks: the real Claude Code runs `debrief hook
 * session-start`, `subagent-start`, `stop`, `user-prompt-submit` and `pre-tool-use`, registered with `--settings`,
 * against a localhost stub model. What the model received is read from the stub's request bodies.
 */

const SKIP = hostGate("debrief hook tests in claude code", claudeSkipReason());

/** Every network log a Debrief process (hook or MCP server) in this file writes to; each is checked empty after its test. */
const networkLogs: string[] = [];

function guardedNetworkLog(): string {
  const path = join(tempDir(), "network.log");
  networkLogs.push(path);
  return path;
}

// Hooks fail open, so a blocked network call would not fail a test by itself: every log must stay empty.
afterEach(() => {
  for (const log of networkLogs.splice(0)) expect(existsSync(log) ? readFileSync(log, "utf8") : "", log).toBe("");
});

function hooksSettings(debriefHome: string): string {
  const log = guardedNetworkLog();
  const debrief = (args: string) => `DEBRIEF_HOME='${debriefHome}' DEBRIEF_NETWORK_LOG='${log}' '${process.execPath}' --import '${NO_NETWORK}' '${CLI}' hook ${args} --host claude-code`;
  const path = join(tempDir(), "settings.json");
  writeFileSync(
    path,
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: debrief("session-start") }] }],
        SubagentStart: [{ hooks: [{ type: "command", command: debrief("subagent-start") }] }],
        Stop: [{ hooks: [{ type: "command", command: debrief("stop") }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: debrief("user-prompt-submit") }] }],
        PreToolUse: [{ matcher: "mcp__(plugin_debrief_)?debrief__.*", hooks: [{ type: "command", command: debrief("pre-tool-use") }] }],
      },
    }),
  );
  return path;
}

describe.skipIf(SKIP !== null)(`Debrief's hooks in the real Claude Code ${CLAUDE_PINNED_VERSION}`, () => {
  test("the model starts with the checkpoint in context without any tool call, the turn is captured when it stops, and the next session starts with it digested", async () => {
    const sandbox = claudeSandbox();
    const repo = initRepo({ branch: "fix/double-charge" });
    const debriefHome = tempDir();
    const setup = openMemory({ cwd: repo, home: debriefHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
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
      hooksSettings(debriefHome),
    );
    expect(run.code, run.stderr).toBe(0);

    const first = JSON.stringify(stub.requests[0] ?? {});
    expect(first).toContain("SessionStart hook additional context: ");
    expect(first).toContain("SYNTHETIC-NEXT wire the idempotency key into charge()");
    expect(first).toContain("Debrief is local working memory shared by the coding agents in this repository.");
    // The notice is for the user only.
    expect(JSON.stringify(stub.requests)).not.toContain("◪ debrief");
    expect(stub.offeredTools.flat().filter((t) => t.startsWith("mcp__"))).toEqual([]);

    const after = openMemory({ cwd: repo, home: debriefHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
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
      hooksSettings(debriefHome),
    );
    expect(second.code, second.stderr).toBe(0);
    const context = JSON.stringify(next.requests[0] ?? {});
    expect(context).toContain("## Since checkpoint r1 (claude-code, ended ");
    expect(context).toContain("- SYNTHETIC-PROMPT where did we leave the double-charge fix?");
  });

  test("a lasting-preference prompt reaches the model with the hint; a recall runs without a prompt, a write is still denied in -p; notices stay with the user", async () => {
    const sandbox = claudeSandbox();
    const repo = initRepo({ branch: "fix/double-charge" });
    const debriefHome = tempDir();
    const added = claude(claudeEnv(sandbox), repo, ...debriefAddArgs({ debriefHome, networkLog: guardedNetworkLog() }));
    expect(added.code, added.stderr).toBe(0);
    const setup = openMemory({ cwd: repo, home: debriefHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
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
      hooksSettings(debriefHome),
    );
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.stringify(stub.requests[0] ?? {})).toContain("UserPromptSubmit hook additional context: Debrief: the user's wording may state a lasting preference.");

    const result = JSON.parse(run.stdout) as { session_id: string; permission_denials: { tool_name: string }[] };
    expect(result.permission_denials.map((d) => d.tool_name)).toEqual(["mcp__debrief__memory_record"]);
    const traffic = sessionToolTraffic(sandbox, result.session_id);
    expect(traffic.uses).toEqual(["mcp__debrief__memory_recall", "mcp__debrief__memory_record"]);
    expect(traffic.results[0]).toContain('"items"');
    expect(JSON.stringify(stub.requests)).not.toContain("◪ debrief");
  }, 120_000);

  test("the fifth turn of work with no checkpoint: the stop is blocked once, the model gets the reason, and the continued stop ends the turn", async () => {
    const sandbox = claudeSandbox();
    const repo = initRepo({ branch: "fix/double-charge" });
    const debriefHome = tempDir();
    // Four earlier turns that ran commands, in a session an hour ago.
    const earlier = "e0d00000-0000-4000-8000-0000000000aa";
    const { path } = installTranscript(sandbox.configDir, "", { cwd: repo, sessionId: earlier, content: "" });
    let after: string | null = null;
    for (let n = 1; n <= 4; n++) {
      const turn = claudeTurn({ cwd: repo, sessionId: earlier, n, at: new Date(Date.now() - 3_600_000 + n * 1_000), prompt: `Step ${n}.`, command: "npm test", after });
      after = turn.last;
      appendFileSync(path, turn.lines);
    }
    const setup = openMemory({ cwd: repo, home: debriefHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
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
      hooksSettings(debriefHome),
    );
    expect(run.code, run.stderr).toBe(0);
    expect(stub.requests).toHaveLength(2);
    expect(JSON.stringify(stub.requests[0])).not.toContain("Stop hook feedback");
    expect(JSON.stringify(stub.requests[1])).toContain("Stop hook feedback:\\nDebrief: 5 turns since the last checkpoint (none yet), with files changed or commands run.");
    // The user's "saved turn" line went with the block, but never to the model.
    expect(JSON.stringify(stub.requests)).not.toContain("◪ debrief");
    const check = openMemory({ cwd: repo, home: debriefHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
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

  test("\"don't remember this session\" through MCP also forgets a turn the hooks captured before any Debrief call, and the MCP server is the same session as the hooks", async () => {
    const sandbox = claudeSandbox();
    const repo = initRepo({ branch: "fix/double-charge" });
    const debriefHome = tempDir();
    const added = claude(claudeEnv(sandbox), repo, ...debriefAddArgs({ debriefHome, networkLog: guardedNetworkLog() }));
    expect(added.code, added.stderr).toBe(0);
    const setup = openMemory({ cwd: repo, home: debriefHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      setup.close();
    });
    setup.bootstrap({ importChoice: "current_project" });
    setup.close();

    // Turn 1 makes no Debrief call; the Stop hook captures it.
    const stub = await startStubMessages({ calls: [], reply: "SYNTHETIC-PRIVATE-REPLY noted." });
    const env = claudeEnv(sandbox, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: "sk-ant-stub-000" });
    const first = await claudeAsync(env, repo, "-p", "SYNTHETIC-PRIVATE-PROMPT the staging password rotation", "--output-format", "json", "--settings", hooksSettings(debriefHome));
    expect(first.code, first.stderr).toBe(0);
    const live = (JSON.parse(first.stdout) as { session_id: string }).session_id;
    const captured = openMemory({ cwd: repo, home: debriefHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
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
      "mcp__debrief__memory_manage",
      "--settings",
      hooksSettings(debriefHome),
    );
    expect(second.code, second.stderr).toBe(0);
    const traffic = sessionToolTraffic(sandbox, (JSON.parse(second.stdout) as { session_id: string }).session_id);
    expect(traffic.uses).toEqual(["mcp__debrief__memory_manage"]);
    expect(traffic.results[0]).toContain('"action":"private_session"');

    // The MCP server's session carries Claude's session id, like the hooks' sessions.
    const db = new Database(locateWorkspace(repo, debriefHome).dbPath, { readonly: true });
    onCleanup(() => {
      db.close();
    });
    const sessions = db.prepare("SELECT host_session_id AS id, private FROM sessions WHERE host = 'claude-code' ORDER BY started_at").all() as { id: string | null; private: number }[];
    db.close();
    expect(sessions.filter((s) => s.private === 1).map((s) => s.id)).toEqual([live]);

    // Nothing from either turn is recalled, and a later import pass does not bring it back.
    const after = openMemory({ cwd: repo, home: debriefHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      after.close();
    });
    after.bootstrap({});
    const left = after.recall({ query: "SYNTHETIC-PRIVATE-PROMPT SYNTHETIC-PRIVATE-REPLY SYNTHETIC-PRIVATE-ASK SYNTHETIC-PRIVATE-DONE", maxTokens: 8_000 }).items.map((i) => i.excerpt);
    expect(left.filter((excerpt) => excerpt.includes("SYNTHETIC-PRIVATE"))).toEqual([]);
    expect(after.status().hookFailures).toEqual([]);
  }, 120_000);

  test("resume, compact and clear: the model's next request carries the checkpoint as it is then, still without a tool call", async () => {
    const sandbox = claudeSandbox();
    const repo = initRepo({ branch: "fix/double-charge" });
    const debriefHome = tempDir();
    const memory = openMemory({ cwd: repo, home: debriefHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      memory.close();
    });
    memory.bootstrap({ importChoice: "current_project" });
    let revision = 0;
    // A new revision before each event, so a request can only carry it if that event's SessionStart delivered it (not history).
    const checkpoint = (next: string): void => {
      revision = memory.checkpoint({ expectedRevision: revision, goal: "Stop double charges", status: "Key drafted", nextSteps: [next] }).revision;
    };
    const stub = await startStubMessages({ calls: [], reply: "SYNTHETIC-REPLY ok." });
    const env = claudeEnv(sandbox, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: "sk-ant-stub-000" });
    const carried = (marker: string, next: string): boolean => {
      const request = JSON.stringify(stub.requests.find((r) => JSON.stringify(r).includes(marker)) ?? {});
      return request.includes("SessionStart hook additional context: ") && request.includes(next);
    };

    checkpoint("SYNTHETIC-NEXT-STARTUP");
    const session = claudeStream(env, repo, "--settings", hooksSettings(debriefHome));
    const first = await session.send("SYNTHETIC-FIRST where were we?");
    checkpoint("SYNTHETIC-NEXT-COMPACT");
    await session.send("/compact");
    await session.send("SYNTHETIC-AFTER-COMPACT go on");
    checkpoint("SYNTHETIC-NEXT-CLEAR");
    await session.send("/clear");
    const cleared = await session.send("SYNTHETIC-AFTER-CLEAR go on");
    const ended = await session.end();
    expect(ended.code, ended.stderr).toBe(0);
    expect(cleared["session_id"]).not.toBe(first["session_id"]);
    expect(carried("SYNTHETIC-FIRST", "SYNTHETIC-NEXT-STARTUP")).toBe(true);
    expect(carried("SYNTHETIC-AFTER-COMPACT", "SYNTHETIC-NEXT-COMPACT")).toBe(true);
    expect(carried("SYNTHETIC-AFTER-CLEAR", "SYNTHETIC-NEXT-CLEAR")).toBe(true);

    checkpoint("SYNTHETIC-NEXT-RESUME");
    const resumed = await claudeAsync(env, repo, "-p", "--resume", String(first["session_id"]), "SYNTHETIC-RESUMED go on", "--output-format", "json", "--settings", hooksSettings(debriefHome));
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(carried("SYNTHETIC-RESUMED", "SYNTHETIC-NEXT-RESUME")).toBe(true);
    expect(stub.offeredTools.flat().filter((t) => t.startsWith("mcp__"))).toEqual([]);
  }, 180_000);

  test("after /clear, \"don't remember this session\" forgets the conversation since /clear, not the one before it", async () => {
    const sandbox = claudeSandbox();
    const repo = initRepo({ branch: "fix/double-charge" });
    const debriefHome = tempDir();
    const added = claude(claudeEnv(sandbox), repo, ...debriefAddArgs({ debriefHome, networkLog: guardedNetworkLog() }));
    expect(added.code, added.stderr).toBe(0);
    const setup = openMemory({ cwd: repo, home: debriefHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      setup.close();
    });
    setup.bootstrap({ importChoice: "current_project" });
    setup.close();
    const stub = await startStubMessages({ calls: [{ tool: "memory_manage", input: { action: "private_session" }, when: "SYNTHETIC-FORGET" }], reply: "SYNTHETIC-REPLY ok." });
    const env = claudeEnv(sandbox, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: "sk-ant-stub-000" });

    const session = claudeStream(env, repo, "--allowedTools", "mcp__debrief__memory_manage", "--settings", hooksSettings(debriefHome));
    await session.send("SYNTHETIC-KEEP the retry budget is three");
    await session.send("/clear");
    await session.send("SYNTHETIC-SECRET the staging password rotation");
    const forgot = await session.send("SYNTHETIC-FORGET don't remember this session");
    const ended = await session.end();
    expect(ended.code, ended.stderr).toBe(0);
    expect(sessionToolTraffic(sandbox, String(forgot["session_id"])).uses).toEqual(["mcp__debrief__memory_manage"]);

    const after = openMemory({ cwd: repo, home: debriefHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      after.close();
    });
    after.bootstrap({});
    const excerpts = after.recall({ query: "SYNTHETIC-KEEP SYNTHETIC-SECRET SYNTHETIC-FORGET", maxTokens: 8_000 }).items.map((i) => i.excerpt);
    expect(excerpts.filter((e) => e.includes("SYNTHETIC-SECRET") || e.includes("SYNTHETIC-FORGET"))).toEqual([]);
    expect(excerpts.some((e) => e.includes("SYNTHETIC-KEEP the retry budget is three"))).toBe(true);
    expect(after.status().hookFailures).toEqual([]);
  }, 180_000);
  test("a sub-agent starts with the checkpoint without a tool call, its Debrief recall runs without a prompt, and what only its commands found is recalled in a new session", async () => {
    const sandbox = claudeSandbox();
    const repo = initRepo({ branch: "fix/double-charge" });
    const debriefHome = tempDir();
    const added = claude(claudeEnv(sandbox), repo, ...debriefAddArgs({ debriefHome, networkLog: guardedNetworkLog() }));
    expect(added.code, added.stderr).toBe(0);
    const setup = openMemory({ cwd: repo, home: debriefHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      setup.close();
    });
    setup.bootstrap({ importChoice: "current_project" });
    setup.checkpoint({ expectedRevision: 0, goal: "Stop double charges", status: "Key drafted", nextSteps: ["SYNTHETIC-NEXT find where the retry budget is set"] });
    setup.close();

    const delegated = "SYNTHETIC-DELEGATED find where the retry budget is set";
    const fromSubagent = (request: Record<string, unknown>): boolean => firstUserText(request).includes(delegated);
    const stub = await startStubMessages({
      calls: [
        // Background, Claude Code's default: the parent's Stop runs while the sub-agent works.
        { tool: "Agent", builtin: true, input: { description: "retry budget", prompt: delegated, subagent_type: "general-purpose" }, when: "SYNTHETIC-PROMPT" },
        { tool: "Bash", builtin: true, input: { command: "echo SYNTHETIC-FINDING retry budget lives in src/retry.ts", description: "look" }, when: fromSubagent },
        { tool: "memory_recall", input: { query: "retry budget" }, when: fromSubagent },
      ],
      reply: (request) => (fromSubagent(request) ? "SYNTHETIC-REPORT the budget is set in src/retry.ts." : "SYNTHETIC-PARENT-REPLY on it."),
    });
    const run = await claudeAsync(
      claudeEnv(sandbox, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: "sk-ant-stub-000" }),
      repo,
      "-p",
      "SYNTHETIC-PROMPT where is the retry budget set? Use a helper.",
      "--output-format",
      "json",
      "--allowedTools",
      "Bash",
      "--settings",
      hooksSettings(debriefHome),
    );
    expect(run.code, run.stderr).toBe(0);

    // Memory in: the sub-agent's first request carries the checkpoint, and not the session's protocol.
    const first = stub.requests.find(fromSubagent);
    expect(JSON.stringify(first)).toContain("SubagentStart hook additional context: ");
    expect(JSON.stringify(first)).toContain("SYNTHETIC-NEXT find where the retry budget is set");
    expect(JSON.stringify(first)).not.toContain("Debrief is local working memory shared by the coding agents in this repository.");
    // Its read-only Debrief call ran without --allowedTools: the PreToolUse auto-allow applies inside the sub-agent.
    const parentSession = (JSON.parse(run.stdout) as { session_id: string }).session_id;
    const subagents = join(sandbox.configDir, "projects", repo.replaceAll("/", "-"), parentSession, "subagents");
    const [transcript] = readdirSync(subagents).filter((f) => f.endsWith(".jsonl"));
    expect(readFileSync(join(subagents, transcript ?? ""), "utf8")).toContain('\\"items\\"');

    // Work out: a new session recalls what only the sub-agent's command printed, as the sub-agent's.
    const after = openMemory({ cwd: repo, home: debriefHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      after.close();
    });
    expect(after.status().hookFailures).toEqual([]);
    const found = after.recall({ query: "SYNTHETIC-FINDING retry budget", maxTokens: 8_000 }).items.filter((i) => i.excerpt.includes("SYNTHETIC-FINDING"));
    expect(found.map((i) => [i.attribution, i.source?.agentType])).toEqual([["direct_observation", "general-purpose"]]);
    // The report is one observation, the sub-agent's: not also the parent's Agent result, a launch receipt, or the task-notification.
    const reports = after.recall({ query: "SYNTHETIC-REPORT budget", maxTokens: 8_000 }).items.filter((i) => i.excerpt.includes("SYNTHETIC-REPORT"));
    expect(reports.map((i) => [i.source?.agentType, i.corroboration])).toEqual([["general-purpose", { independentRoots: 1, records: 1 }]]);
    expect(after.recall({ query: "Async agent launched", maxTokens: 8_000 }).items.filter((i) => i.excerpt.includes("Async agent launched"))).toEqual([]);
    const context = after.sessionStart()?.context ?? "";
    const digest = context.split("User prompts:\n")[1]?.split("\n") ?? [];
    expect(digest.slice(0, digest.findIndex((line) => !line.startsWith("- ")))).toEqual(["- SYNTHETIC-PROMPT where is the retry budget set? Use a helper."]);
    expect(context).toMatch(/Commands: .*✓ echo SYNTHETIC-FINDING retry budget lives in src\/retry\.ts/);
  }, 120_000);
});
