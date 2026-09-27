import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory, type SessionStart } from "../../src/memory.js";
import { PROTOCOL } from "../../src/protocol.js";
import { SESSION_CONTEXT_CHARS } from "../../src/retrieval/session-context.js";
import { recentHookFailures, recordHookFailure } from "../../src/import/hook-failures.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, installTranscript, renderFixture } from "../import/fixtures.js";

function open(repo: string, home: string, config: string, hostSessionId?: string): Memory {
  const memory = openMemory({ cwd: repo, home, host: "claude-code", claudeConfigDir: config, ...(hostSessionId === undefined ? {} : { hostSessionId }) });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

function started(memory: Memory): SessionStart {
  const start = memory.sessionStart();
  if (start === null) throw new Error("no session-start context inside a repository");
  return start;
}

function workspace() {
  return { repo: initRepo({ branch: "fix/double-charge" }), home: tempDir(), config: claudeConfigDir() };
}

describe("sessionStart: what a session-start hook injects", () => {
  test("carries the protocol, the head checkpoint, preferences and labelled items within the size cap", () => {
    const { repo, home, config } = workspace();
    installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    const setup = open(repo, home, config);
    setup.bootstrap({ importChoice: "current_project" });
    setup.checkpoint({ expectedRevision: 0, goal: "Stop double charges", status: "Idempotency key drafted", nextSteps: ["Add the key to charge(); the gateway test already fails"] });
    const question = setup.record({ kind: "preference", body: "Run the gateway tests before every commit.", attribution: "user_direction" });
    setup.settlePreference({ candidateId: question.preference.candidateId ?? "", reply: { action: "accept", label: "This repo only" } });
    setup.close();

    const start = started(open(repo, home, config));
    expect(start.context).toContain(PROTOCOL);
    expect(start.context).toMatch(/\[checkpoint r1 · (now|\dm) · claude-code · \w+\]/);
    expect(start.context).toContain("Add the key to charge(); the gateway test already fails");
    expect(start.context).toMatch(/## Preferences \(.*\)\n- Run the gateway tests before every commit\./);
    const items = (start.context.split("## Recent memory\n")[1] ?? "").split("\n").filter((line) => line.startsWith("- ["));
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const line of items) expect(line).toMatch(/^- \[(evidence|note|decision|observation|next_step|question) · \d+(m|h|d|w|mo|y) · claude-code · (current|stale|unknown)\] .+ \(rec_[0-9a-f]{32}\)$/);
    expect(start.context.length).toBeLessThanOrEqual(SESSION_CONTEXT_CHARS);
    expect(start.notice).toMatch(/^◪ debrief · checkpoint r1 loaded · 1 preference · \d+ items$/);
  });

  test("an empty workspace says so with what to record once; later sessions only say it is empty", () => {
    const { repo, home, config } = workspace();
    const first = started(open(repo, home, config));
    expect(first.context).toMatch(/No memory for this repository yet\. Record decisions, failed attempts and next steps/);
    expect(first.notice).toMatch(/^◪ debrief · no memory yet/);
    const later = started(open(repo, home, config));
    expect(later.context).toContain("No memory for this workstream yet.");
    expect(later.context).not.toContain("Record decisions, failed attempts");
  });

  test("before consent the import question is passed on verbatim, for the agent to ask", () => {
    const { repo, home, config } = workspace();
    installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    const memory = open(repo, home, config);
    const start = started(memory);
    const question = memory.status().import?.question ?? "";
    expect(question).not.toBe("");
    expect(start.context).toContain(question);
    expect(start.context).toContain("importChoice");
  });

  test("memory that cannot be read is never presented as empty", () => {
    const { repo, home, config } = workspace();
    const setup = open(repo, home, config);
    setup.bootstrap({ importChoice: "none" });
    const dbPath = setup.status().storage.dbPath ?? "";
    setup.close();
    for (const suffix of ["-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
    writeFileSync(dbPath, "not a database ".repeat(100));

    const start = started(open(repo, home, config));
    expect(start.context).toMatch(/^Memory could not be loaded \(storage_\w+\)\. Do not assume this project has none\./);
    expect(start.context).not.toContain("No memory");
    expect(start.notice).toMatch(/^◪ debrief · memory could not be loaded \(storage_\w+\)$/);
    expect(open(repo, home, config).status().hookFailures.map((f) => [f.event, f.code.startsWith("storage_")])).toEqual([["session-start", true]]);
  });

  test("a large memory is cut to the cap, and the cut says how to get the rest", () => {
    const { repo, home, config } = workspace();
    const setup = open(repo, home, config);
    setup.bootstrap({ importChoice: "none" });
    for (let i = 0; i < 60; i++) setup.record({ kind: "note", body: `Observation ${i}: ${"the retry queue drains in order; ".repeat(12)}`, attribution: "direct_observation" });
    setup.close();
    const start = started(open(repo, home, config));
    expect(start.context.length).toBeLessThanOrEqual(SESSION_CONTEXT_CHARS);
    expect(start.context).toMatch(/more not shown: use memory_recall/);
    expect(start.context).toContain(PROTOCOL);
  });

  test("recent hook failures reach the user's notice", () => {
    const { repo, home, config } = workspace();
    open(repo, home, config).bootstrap({ importChoice: "none" });
    recordHookFailure(home, { host: "claude-code", event: "stop", cwd: repo, code: "storage_busy", message: "database is locked" });
    recordHookFailure(home, { host: "claude-code", event: "stop", cwd: initRepo(), code: "storage_full", message: "another repository's failure" });
    const start = started(open(repo, home, config));
    expect(start.notice).toMatch(/ · ⚠ 1 hook failure \(storage_busy\): debrief diag status$/);
  });
});

describe("sessionStart: the digest of turns no checkpoint covers", () => {
  test("a session that ended without a checkpoint is digested: prompts, last reply, commands, files, end time", () => {
    const { repo, home, config } = workspace();
    installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    open(repo, home, config).bootstrap({ importChoice: "current_project" });
    const start = started(open(repo, home, config));
    const digest = start.context.slice(start.context.indexOf("## Last session"));
    expect(digest).toMatch(/^## Last session \(claude-code, ended 2026-09-20T10:00:\d\d(\.\d+)?Z, without a checkpoint\)/);
    expect(digest).toContain("- Checkout double-charges when the payment gateway times out.");
    expect(digest).toContain("- Use a server-side idempotency key per order; do not add client retries.");
    expect(digest).toMatch(/Last reply: Root cause: charge\(\) retries a 504/);
    expect(digest).toMatch(/Commands: ✗ npm test -- gateway/);
    expect(digest).toContain("Files: docs/screenshot.png, src/gateway.ts");
    // What the digest shows is not listed again under recent memory.
    expect(start.context.split("Root cause: charge() retries a 504")).toHaveLength(2);
    expect(start.notice).toContain("last session ended without a checkpoint");
  });

  test("turns after the checkpoint are digested under it; a checkpoint after every turn needs no digest", () => {
    const { repo, home, config } = workspace();
    const sessionId = "5e550000-0000-4000-8000-0000000000f5";
    const transcript = installTranscript(config, "2.1.281/redis-claim.jsonl", { cwd: repo, sessionId });
    const setup = open(repo, home, config);
    setup.bootstrap({ importChoice: "current_project" });
    setup.checkpoint({ expectedRevision: 0, goal: "Queue work", status: "Covers every turn so far" });
    setup.close();
    expect(started(open(repo, home, config)).context).not.toContain("## Since checkpoint");

    // The session goes on after the checkpoint (timestamps later than it), then crashes.
    const later = renderFixture("2.1.281/basic.jsonl", { cwd: repo, sessionId }).replaceAll("2026-09-20T", "2099-01-01T");
    appendFileSync(transcript.path, later);
    const start = started(open(repo, home, config));
    expect(start.context).toMatch(/## Since checkpoint r1 \(claude-code, ended 2099-01-01T10:00:\d\d(\.\d+)?Z\)/);
    expect(start.context).toContain("- Use a server-side idempotency key per order; do not add client retries.");
    expect(start.context.indexOf("## Checkpoint")).toBeLessThan(start.context.indexOf("## Since checkpoint r1"));
  });
});

describe("sessionStart: a closing reply is not unfinished work", () => {
  test("after a checkpoint, only a new user prompt means the session went on", () => {
    const { repo, home, config } = workspace();
    const sessionId = "5e550000-0000-4000-8000-0000000000f6";
    const transcript = installTranscript(config, "2.1.281/redis-claim.jsonl", { cwd: repo, sessionId });
    const setup = open(repo, home, config);
    setup.bootstrap({ importChoice: "current_project" });
    setup.checkpoint({ expectedRevision: 0, goal: "Queue work", status: "Done for today" });
    setup.close();
    // The agent's reply after checkpointing ("Checkpoint saved.") lands after it.
    const reply = renderFixture("2.1.281/basic.jsonl", { cwd: repo, sessionId }).split("\n").findLast((line) => line.includes('"role":"assistant"') && line.includes('"type":"text"')) ?? "";
    expect(reply).toContain('"role":"assistant"');
    appendFileSync(transcript.path, `${reply.replaceAll("2026-09-20T", "2099-01-01T")}\n`);
    const start = started(open(repo, home, config));
    expect(start.context).not.toContain("## Since checkpoint");
    expect(start.notice).not.toContain("turns after");
  });
});

describe("sessionStart and captureTurn outside a Git repository", () => {
  test("say nothing and record no failure", () => {
    const dir = tempDir();
    const home = tempDir();
    const config = claudeConfigDir();
    const session = installTranscript(config, "2.1.281/basic.jsonl", { cwd: dir });
    const memory = open(dir, home, config);
    expect(memory.sessionStart()).toBeNull();
    expect(memory.captureTurn({ transcriptPath: session.path })).toMatchObject({ state: "skipped", reason: "not_a_repository", failure: null });
    expect(recentHookFailures(home)).toEqual([]);
  });
});

