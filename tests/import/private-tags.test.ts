import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, claudeToolExchange, codexHome, codexThreadId, installCodexRollout, installTranscript, renderCodexFixture, renderFixture } from "./fixtures.js";

// One token, so the FTS index (which stores tokens lowercased) is searched too.
const MARKER = "ZQXVPRIVATEMARKER7731";

/** The shared fixture text with `<private>` spans in the user's prompt and the assistant's reply. */
function withPrivate(content: string): string {
  return content
    .replaceAll("Checkout double-charges when", `Checkout double-charges <private>card ${MARKER}</private> when`)
    .replaceAll("then read the retry logic", `then read <PRIVATE>${MARKER}B</PRIVATE> the retry logic`);
}

/** Every byte SQLite wrote for this workspace: the database, its WAL and shared memory. */
function storedBytes(memory: Memory): string {
  const dbPath = memory.status().storage.dbPath ?? "";
  memory.close();
  return ["", "-wal", "-shm"]
    .map((suffix) => dbPath + suffix)
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path).toString("latin1"))
    .join("");
}

function expectPrivateGone(memory: Memory): void {
  const excerpts = memory.recall({ query: "double charges gateway" }).items.map((item) => item.excerpt);
  expect(excerpts).toContain("Checkout double-charges [private] when the payment gateway times out. Find out why before changing anything.");
  const bytes = storedBytes(memory);
  expect(bytes).not.toContain(MARKER);
  expect(bytes).not.toContain(MARKER.toLowerCase());
}

describe("<private>…</private> is replaced before anything is stored", () => {
  test("Claude Code: prompts and replies", () => {
    const repo = initRepo();
    const home = tempDir();
    const config = claudeConfigDir();
    const sessionId = "70000000-0000-4000-8000-000000000001";
    installTranscript(config, "", { cwd: repo, sessionId, content: withPrivate(renderFixture("2.1.281/basic.jsonl", { cwd: repo, sessionId })) });
    const memory = openMemory({ cwd: repo, home, host: "claude-code", claudeConfigDir: config });
    onCleanup(() => {
      memory.close();
    });
    memory.bootstrap({ importChoice: "current_project" });
    expectPrivateGone(memory);
  });

  test("Codex: prompts and replies", () => {
    const repo = initRepo();
    const home = tempDir();
    const codex = codexHome();
    const threadId = codexThreadId();
    installCodexRollout(codex, "", { cwd: repo, threadId, content: withPrivate(renderCodexFixture("0.142.5/basic.jsonl", { cwd: repo, threadId })) });
    const memory = openMemory({ cwd: repo, home, host: "codex", codexHome: codex });
    onCleanup(() => {
      memory.close();
    });
    memory.bootstrap({ importChoice: "current_project" });
    expectPrivateGone(memory);
  });

  test("an unclosed tag hides everything after it", () => {
    const repo = initRepo();
    const home = tempDir();
    const config = claudeConfigDir();
    const sessionId = "70000000-0000-4000-8000-000000000002";
    const content = renderFixture("2.1.281/basic.jsonl", { cwd: repo, sessionId }).replace("when the payment gateway times out.", `<private>when ${MARKER} times out.`);
    installTranscript(config, "", { cwd: repo, sessionId, content });
    const memory = openMemory({ cwd: repo, home, host: "claude-code", claudeConfigDir: config });
    onCleanup(() => {
      memory.close();
    });
    memory.bootstrap({ importChoice: "current_project" });
    expect(memory.recall({ query: "double charges" }).items.map((item) => item.excerpt)).toContain("Checkout double-charges [private]");
    const bytes = storedBytes(memory);
    expect(bytes).not.toContain(MARKER);
    expect(bytes).not.toContain(MARKER.toLowerCase());
  });

  test("an agent relaying a span into memory_record or memory_checkpoint stores [private] instead", () => {
    const repo = initRepo();
    const memory = openMemory({ cwd: repo, home: tempDir(), host: "claude-code", claudeConfigDir: claudeConfigDir() });
    onCleanup(() => {
      memory.close();
    });
    memory.bootstrap();
    const span = `<private>${MARKER}</private>`;
    const recorded = memory.record({ kind: "decision", title: `Retry ${span} policy`, body: `Keep one idempotency key per order ${span}.`, attribution: "agent_inference", operationKey: "op-private-1" });
    memory.checkpoint({ expectedRevision: 0, goal: `Stop double charges ${span}`, status: "Fix drafted", nextSteps: [`Add the gateway test ${span} and why`] });
    expect(memory.read({ recordId: recorded.recordId })).toMatchObject({ title: "Retry [private] policy", body: "Keep one idempotency key per order [private]." });
    const checkpoint = memory.recall({}).checkpoint?.excerpt ?? "";
    expect(checkpoint).toContain("Stop double charges [private]");
    expect(checkpoint).toContain("Add the gateway test [private] and why");
    const bytes = storedBytes(memory);
    expect(bytes).not.toContain(MARKER);
    expect(bytes).not.toContain(MARKER.toLowerCase());
  });

  test("a span inside a tool call (a shell command, a Debrief call) never reaches import metadata", () => {
    const repo = initRepo();
    const home = tempDir();
    const config = claudeConfigDir();
    const sessionId = "70000000-0000-4000-8000-000000000003";
    const span = `<private>${MARKER}</private>`;
    const base = renderFixture("2.1.281/basic.jsonl", { cwd: repo, sessionId });
    const content =
      base +
      claudeToolExchange({ cwd: repo, sessionId, gitBranch: "main", parentUuid: null, id: 9_000, tool: "Bash", input: { command: `echo ${span}` }, result: "ok" }) +
      claudeToolExchange({ cwd: repo, sessionId, gitBranch: "main", parentUuid: null, id: 9_010, tool: "mcp__debrief__memory_recall", input: { query: `retry ${span}` }, result: '{"items":[]}' });
    installTranscript(config, "", { cwd: repo, sessionId, content });
    const memory = openMemory({ cwd: repo, home, host: "claude-code", claudeConfigDir: config });
    onCleanup(() => {
      memory.close();
    });
    memory.bootstrap({ importChoice: "current_project" });
    const bytes = storedBytes(memory);
    expect(bytes).toContain("echo [private]");
    expect(bytes).not.toContain(MARKER);
    expect(bytes).not.toContain(MARKER.toLowerCase());
  });
});
