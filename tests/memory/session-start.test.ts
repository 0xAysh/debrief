import { rmSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { PROTOCOL } from "../../src/protocol.js";
import { SESSION_CONTEXT_CHARS } from "../../src/retrieval/session-context.js";
import { recordCaptureFailure } from "../../src/import/capture-failures.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, installTranscript } from "../import/fixtures.js";

function open(repo: string, home: string, config: string, hostSessionId?: string): Memory {
  const memory = openMemory({ cwd: repo, home, host: "claude-code", claudeConfigDir: config, ...(hostSessionId === undefined ? {} : { hostSessionId }) });
  onCleanup(() => {
    memory.close();
  });
  return memory;
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

    const start = open(repo, home, config).sessionStart({ source: "startup" });
    expect(start.context).toContain(PROTOCOL);
    expect(start.context).toMatch(/\[checkpoint r1 · (now|\dm) · claude-code · \w+\]/);
    expect(start.context).toContain("Add the key to charge(); the gateway test already fails");
    expect(start.context).toMatch(/## Preferences \(.*\)\n- Run the gateway tests before every commit\./);
    const items = (start.context.split("## Recent memory\n")[1] ?? "").split("\n").filter((line) => line.startsWith("- ["));
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const line of items) expect(line).toMatch(/^- \[(evidence|note|decision|observation|next_step|question) · \d+(m|h|d|w|mo|y) · claude-code · (current|stale|unknown)\] .+ \(rec_[0-9a-f]{32}\)$/);
    expect(start.context.length).toBeLessThanOrEqual(SESSION_CONTEXT_CHARS);
    expect(start.notice).toMatch(/^◪ memchor · checkpoint r1 loaded · 1 preference · \d+ items$/);
  });

  test("an empty workspace says so with what to record once; later sessions only say it is empty", () => {
    const { repo, home, config } = workspace();
    const first = open(repo, home, config).sessionStart({ source: "startup" });
    expect(first.context).toMatch(/No memory for this repository yet\. Record decisions, failed attempts and next steps/);
    expect(first.notice).toMatch(/^◪ memchor · no memory yet/);
    const later = open(repo, home, config).sessionStart({ source: "startup" });
    expect(later.context).toContain("No memory for this workstream yet.");
    expect(later.context).not.toContain("Record decisions, failed attempts");
  });

  test("before consent the import question is passed on verbatim, for the agent to ask", () => {
    const { repo, home, config } = workspace();
    installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    const memory = open(repo, home, config);
    const start = memory.sessionStart({ source: "startup" });
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

    const start = open(repo, home, config).sessionStart({ source: "startup" });
    expect(start.context).toMatch(/^Memory could not be loaded \(storage_\w+\)\. Do not assume this project has none\./);
    expect(start.context).not.toContain("No memory");
    expect(start.notice).toMatch(/^◪ memchor · memory could not be loaded \(storage_\w+\)$/);
    expect(open(repo, home, config).status().captureFailures.map((f) => [f.event, f.code.startsWith("storage_")])).toEqual([["session-start", true]]);
  });

  test("a large memory is cut to the cap, and the cut says how to get the rest", () => {
    const { repo, home, config } = workspace();
    const setup = open(repo, home, config);
    setup.bootstrap({ importChoice: "none" });
    for (let i = 0; i < 60; i++) setup.record({ kind: "note", body: `Observation ${i}: ${"the retry queue drains in order; ".repeat(12)}`, attribution: "direct_observation" });
    setup.close();
    const start = open(repo, home, config).sessionStart({ source: "startup" });
    expect(start.context.length).toBeLessThanOrEqual(SESSION_CONTEXT_CHARS);
    expect(start.context).toMatch(/more not shown: use memory_recall/);
    expect(start.context).toContain(PROTOCOL);
  });

  test("recent capture failures reach the user's notice", () => {
    const { repo, home, config } = workspace();
    open(repo, home, config).bootstrap({ importChoice: "none" });
    recordCaptureFailure(home, { host: "claude-code", event: "stop", code: "storage_busy", message: "database is locked" });
    const start = open(repo, home, config).sessionStart({ source: "resume" });
    expect(start.notice).toMatch(/ · ⚠ 1 capture failure \(storage_busy\): memchor diag status$/);
  });
});
