import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { type BootstrapResult, openMemory, type Memory, type SessionStart } from "../../src/memory.js";
import { PROTOCOL } from "../../src/protocol.js";
import { SESSION_CONTEXT_CHARS } from "../../src/retrieval/session-context.js";
import { recentHookFailures, recordHookFailure } from "../../src/import/hook-failures.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, installTranscript, renderFixture } from "../import/fixtures.js";
import { spawnServer } from "../mcp/harness.js";

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

/** The context's lines that point at work memory: the pointer, if any. */
function pointers(context: string): string[] {
  return context.split("\n").filter((line) => line.includes("for this line of work"));
}

function notes(memory: Memory, count: number): void {
  for (let i = 0; i < count; i++) memory.record({ kind: "note", body: `Observation ${i}: ${"the retry queue drains in order; ".repeat(12)}`, attribution: "direct_observation" });
}

const README = readFileSync(resolve(import.meta.dirname, "../../README.md"), "utf8");

describe("sessionStart: what a session-start hook injects", () => {
  test("S1: the header, the protocol, questions for the user, the pointer and preferences; no checkpoint body, digest or memory items", () => {
    const { repo, home, config } = workspace();
    installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    const setup = open(repo, home, config);
    setup.bootstrap({ importChoice: "current_project" });
    setup.checkpoint({ expectedRevision: 0, goal: "Stop double charges", status: "Idempotency key drafted", nextSteps: ["Add the key to charge(); the gateway test already fails"] });
    const question = setup.record({ kind: "preference", body: "Run the gateway tests before every commit.", attribution: "user_direction" });
    setup.settlePreference({ candidateId: question.preference.candidateId ?? "", reply: { action: "accept", label: "This repo only" } });
    setup.record({ kind: "preference", body: "Squash commits before merging.", attribution: "user_direction" });
    setup.close();

    const start = started(open(repo, home, config));
    const { context } = start;
    expect(context).toMatch(/^# Debrief: .+ \/ .+, head r1\n\n/);
    expect(context).toContain(PROTOCOL);
    expect(context).toContain("## Preference question for the user\nSave \"Squash commits before merging.\"");
    expect(context).toMatch(/## Preferences \(.*\)\n- Run the gateway tests before every commit\./);
    expect(pointers(context)).toEqual([expect.stringMatching(/^Memory for this line of work: checkpoint r1 \("Stop double charges"\), /)]);
    // Questions come first, before anything long; the pointer stands where the work used to.
    const at = (text: string): number => context.indexOf(text);
    expect(at(PROTOCOL)).toBeLessThan(at("## Preference question"));
    expect(at("## Preference question")).toBeLessThan(at("Memory for this line of work"));
    expect(at("Memory for this line of work")).toBeLessThan(at("## Preferences ("));

    // No work context: the checkpoint's body, the transcript's turns and memory items are memory_bootstrap's and memory_recall's.
    for (const absent of ["## Checkpoint", "Idempotency key drafted", "Add the key to charge()", "## Last session", "## Since checkpoint", "## Recent memory", "Root cause: charge() retries a 504", "more not shown"]) {
      expect(context).not.toContain(absent);
    }
    expect(context).not.toMatch(/rec_[0-9a-f]{32}/);
    expect(context.length).toBeLessThanOrEqual(SESSION_CONTEXT_CHARS);
    // S5: no item count; the confirmed preference is counted.
    expect(start.notice).toBe("◪ debrief · checkpoint r1 · 1 preference");
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

  test("S4: the start's size does not depend on how much memory there is, and stays within the cap", () => {
    const { repo, home, config } = workspace();
    const setup = open(repo, home, config);
    setup.bootstrap({ importChoice: "none" });
    // A preference is listed in full, never counted as a record, even when the budget leaves it out of the pack.
    const preference = setup.record({ kind: "preference", body: "Run the gateway tests before every commit.", attribution: "user_direction" });
    setup.settlePreference({ candidateId: preference.preference.candidateId ?? "", reply: { action: "accept", label: "This repo only" } });
    notes(setup, 1);
    setup.close();
    const small = started(open(repo, home, config)).context;
    const more = open(repo, home, config);
    notes(more, 59);
    more.close();
    const large = started(open(repo, home, config)).context;

    expect(pointers(small)).toEqual(["1 record for this line of work: memory_recall when the task needs them."]);
    expect(pointers(large)).toEqual(["60 records for this line of work: memory_recall when the task needs them."]);
    // Only the count differs.
    expect(large.replace("60 records", "1 record")).toBe(small);
    expect(large.length).toBeLessThanOrEqual(SESSION_CONTEXT_CHARS);
    expect(large).toContain(PROTOCOL);
    expect(large).not.toContain("Observation");
  });

  test("recent hook failures reach the user's notice", () => {
    const { repo, home, config } = workspace();
    open(repo, home, config).bootstrap({ importChoice: "none" });
    recordHookFailure(home, { host: "claude-code", event: "stop", cwd: repo, code: "storage_busy", message: "database is locked" });
    recordHookFailure(home, { host: "claude-code", event: "stop", cwd: initRepo(), code: "storage_full", message: "another repository's failure" });
    const start = started(open(repo, home, config));
    expect(start.notice).toMatch(/ · ⚠ 1 hook failure \(storage_busy\): debrief diag status$/);
  });

  test("before the user answers the import question, the notice says it is waiting", () => {
    const { repo, home, config } = workspace();
    installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    const start = started(open(repo, home, config));
    expect(start.notice).toContain("transcript import needs your answer");
    const answered = open(repo, home, config);
    answered.bootstrap({ importChoice: "none" });
    answered.close();
    expect(started(open(repo, home, config)).notice).not.toContain("transcript import needs your answer");
  });
});

describe("sessionStart: the pointer to work memory", () => {
  test("S2: absent when the workspace has nothing, or only preferences", () => {
    const { repo, home, config } = workspace();
    const empty = started(open(repo, home, config));
    expect(pointers(empty.context)).toEqual([]);
    expect(empty.context).not.toContain("memory_bootstrap before");

    const setup = open(repo, home, config);
    const preference = setup.record({ kind: "preference", body: "Run the gateway tests before every commit.", attribution: "user_direction" });
    setup.settlePreference({ candidateId: preference.preference.candidateId ?? "", reply: { action: "accept", label: "This repo only" } });
    setup.close();
    const preferencesOnly = started(open(repo, home, config));
    expect(preferencesOnly.context).toContain("- Run the gateway tests before every commit.");
    expect(pointers(preferencesOnly.context)).toEqual([]);
  });

  test("S2: a checkpoint is named by revision, age and goal (truncated), with memory_bootstrap, on one line of at most 300 characters", () => {
    const { repo, home, config } = workspace();
    const setup = open(repo, home, config);
    setup.bootstrap({ importChoice: "none" });
    const goal = `Stop double charges ${"when the gateway times out and the client retries ".repeat(6)}`;
    setup.checkpoint({ expectedRevision: 0, goal, status: "Drafted", nextSteps: ["SYNTHETIC-NEXT wire the key"] });
    setup.close();

    const start = started(open(repo, home, config));
    const [pointer] = pointers(start.context);
    expect(pointer).toMatch(/^Memory for this line of work: checkpoint r1 \("Stop double charges when the gateway times out[^"]*…"\), just now\. Call memory_bootstrap before continuing this work\.$/);
    expect(pointer?.length).toBeLessThanOrEqual(300);
    expect(start.context).not.toContain("SYNTHETIC-NEXT");
    expect(start.notice).toBe("◪ debrief · checkpoint r1");
  });

  test("S2: a last session that ended without any checkpoint is named with its host and age", () => {
    const { repo, home, config } = workspace();
    installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    open(repo, home, config).bootstrap({ importChoice: "current_project" });
    const start = started(open(repo, home, config));
    expect(pointers(start.context)).toEqual([
      expect.stringMatching(/^Memory for this line of work: no checkpoint; the last session \(claude-code, \d+(m|h|d|w|mo|y) ago\) ended without one\. Call memory_bootstrap before continuing this work\.$/),
    ]);
    expect(start.context).not.toContain("Checkout double-charges when the payment gateway times out.");
    // S5: the crash phrase stays.
    expect(start.notice).toBe("◪ debrief · last session ended without a checkpoint (claude-code)");
  });

  test("S2: turns after the checkpoint are named; a checkpoint after every turn says nothing about a crash", () => {
    const { repo, home, config } = workspace();
    const sessionId = "5e550000-0000-4000-8000-0000000000f5";
    const transcript = installTranscript(config, "2.1.281/redis-claim.jsonl", { cwd: repo, sessionId });
    const setup = open(repo, home, config);
    setup.bootstrap({ importChoice: "current_project" });
    setup.checkpoint({ expectedRevision: 0, goal: "Queue work", status: "Covers every turn so far" });
    setup.close();
    const covered = started(open(repo, home, config));
    expect(pointers(covered.context)).toEqual([expect.stringMatching(/^Memory for this line of work: checkpoint r1 \("Queue work"\), just now\. Call memory_bootstrap before continuing this work\.$/)]);
    expect(covered.notice).toBe("◪ debrief · checkpoint r1");

    // The session goes on after the checkpoint (timestamps later than it), then crashes.
    appendFileSync(transcript.path, renderFixture("2.1.281/basic.jsonl", { cwd: repo, sessionId }).replaceAll("2026-09-20T", "2099-01-01T"));
    const start = started(open(repo, home, config));
    const [pointer] = pointers(start.context);
    expect(pointer).toBe('Memory for this line of work: checkpoint r1 ("Queue work"), just now; the last session ended without one (turns after r1). Call memory_bootstrap before continuing this work.');
    expect(start.context).not.toContain("Use a server-side idempotency key per order");
    // S5: the crash phrase stays.
    expect(start.notice).toBe("◪ debrief · checkpoint r1 · turns after r1 not checkpointed");
  });

  test("S5: every phrase of the notice is in the README's table", () => {
    const { repo, home, config } = workspace();
    installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    const setup = open(repo, home, config);
    setup.bootstrap({ importChoice: "current_project" });
    const crashed = started(open(repo, home, config)).notice;
    setup.checkpoint({ expectedRevision: 0, goal: "Stop double charges", status: "Drafted" });
    const preference = setup.record({ kind: "preference", body: "Run the gateway tests before every commit.", attribution: "user_direction" });
    setup.settlePreference({ candidateId: preference.preference.candidateId ?? "", reply: { action: "accept", label: "This repo only" } });
    setup.close();
    const loaded = started(open(repo, home, config)).notice;

    const table = README.slice(README.indexOf("## What the `◪ debrief` notices mean"));
    const phrases = [...table.matchAll(/^\| `([^`]+)`/gm)].flatMap((match) => (match[1] ?? "").split(" · "));
    for (const notice of [crashed, loaded, "◪ debrief · checkpoint r3 · turns after r3 not checkpointed"]) {
      for (const part of notice.split(" · ").slice(1)) {
        const shape = new RegExp(`^${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\d+/g, "\\d+").replace(/preference\b/, "preferences?")}$`);
        expect(phrases.some((phrase) => shape.test(phrase)), `"${part}" in ${phrases.join(" | ")}`).toBe(true);
      }
    }
    expect(table).not.toMatch(/\d+ items/);
  });
});

describe("memory_bootstrap: the last session's turns no checkpoint covers (lastSession)", () => {
  async function bootstrapOverMcp(repo: string, home: string, config: string): Promise<BootstrapResult> {
    const server = await spawnServer({ cwd: repo, home, host: "claude-code", claudeConfigDir: config });
    const boot = await server.ok<BootstrapResult>("memory_bootstrap", { importChoice: "current_project" });
    await server.close();
    return boot;
  }

  test("S3: a session that ended without a checkpoint: prompts, last reply, commands, files, end time", async () => {
    const { repo, home, config } = workspace();
    installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    const { lastSession } = await bootstrapOverMcp(repo, home, config);
    expect(lastSession).toMatchObject({ host: "claude-code", otherSessions: 0 });
    expect(lastSession?.endedAt).toMatch(/^2026-09-20T10:00:\d\d(\.\d+)?Z$/);
    expect(lastSession?.prompts).toEqual([
      "Checkout double-charges when the payment gateway times out. Find out why before changing anything.",
      "Use a server-side idempotency key per order; do not add client retries.",
    ]);
    expect(lastSession?.lastReply).toMatch(/^Root cause: charge\(\) retries a 504/);
    expect(lastSession?.commands).toEqual([{ command: "npm test -- gateway", failed: true }]);
    expect(lastSession?.files).toEqual(["docs/screenshot.png", "src/gateway.ts"]);
    expect(lastSession?.recordIds.length).toBeGreaterThan(0);
  });

  test("S3: null when a checkpoint covers every turn; the turns after it once the session went on", async () => {
    const { repo, home, config } = workspace();
    const sessionId = "5e550000-0000-4000-8000-0000000000f5";
    const transcript = installTranscript(config, "2.1.281/redis-claim.jsonl", { cwd: repo, sessionId });
    const setup = open(repo, home, config);
    setup.bootstrap({ importChoice: "current_project" });
    setup.checkpoint({ expectedRevision: 0, goal: "Queue work", status: "Covers every turn so far" });
    setup.close();
    expect((await bootstrapOverMcp(repo, home, config)).lastSession).toBeNull();

    appendFileSync(transcript.path, renderFixture("2.1.281/basic.jsonl", { cwd: repo, sessionId }).replaceAll("2026-09-20T", "2099-01-01T"));
    const { lastSession } = await bootstrapOverMcp(repo, home, config);
    expect(lastSession?.endedAt).toMatch(/^2099-01-01T10:00:\d\d(\.\d+)?Z$/);
    expect(lastSession?.prompts).toContain("Use a server-side idempotency key per order; do not add client retries.");
  });

  test("S3: a closing reply is not unfinished work: after a checkpoint, only a new user prompt means the session went on", async () => {
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
    expect((await bootstrapOverMcp(repo, home, config)).lastSession).toBeNull();
    const start = started(open(repo, home, config));
    expect(start.context).not.toContain("turns after");
    expect(start.notice).not.toContain("turns after");
  });

  test("the session asking is never its own last session: a resumed or live session's turns are not reported back to it", () => {
    const { repo, home, config } = workspace();
    const crashed = "5e550000-0000-4000-8000-0000000000f7";
    const current = "5e550000-0000-4000-8000-0000000000f8";
    installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo, sessionId: crashed });
    const live = installTranscript(config, "2.1.281/redis-claim.jsonl", { cwd: repo, sessionId: current });
    // The live session's turns are the newest.
    writeFileSync(live.path, readFileSync(live.path, "utf8").replaceAll("2026-09-2", "2099-01-0"));
    open(repo, home, config).bootstrap({ importChoice: "current_project" });

    expect(open(repo, home, config).bootstrap().lastSession?.endedAt).toMatch(/^2099-/);
    const own = open(repo, home, config, current).bootstrap().lastSession;
    expect(own?.endedAt).toMatch(/^2026-09-20T/);
    expect(own?.prompts).toContain("Use a server-side idempotency key per order; do not add client retries.");
    expect(started(open(repo, home, config, current)).notice).toBe("◪ debrief · last session ended without a checkpoint (claude-code)");
    // Nothing but the live session: no last session at all.
    const alone = workspace();
    installTranscript(alone.config, "2.1.281/redis-claim.jsonl", { cwd: alone.repo, sessionId: current });
    expect(open(alone.repo, alone.home, alone.config, current).bootstrap({ importChoice: "current_project" }).lastSession).toBeNull();
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
