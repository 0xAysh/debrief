import { rmSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { PROTOCOL } from "../../src/protocol.js";
import { SESSION_CONTEXT_CHARS, SUBAGENT_CONTEXT_CHARS } from "../../src/retrieval/session-context.js";
import { recentHookFailures } from "../../src/import/hook-failures.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, installTranscript } from "../import/fixtures.js";

const PARENT = "5e550000-0000-4000-8000-0000000000a1";

function open(repo: string, home: string, config: string): Memory {
  const memory = openMemory({ cwd: repo, home, host: "claude-code", claudeConfigDir: config });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

function started(memory: Memory): string {
  const start = memory.subagentStart({ hostSessionId: PARENT });
  if (start === null) throw new Error("no sub-agent context inside a repository");
  return start.context;
}

function workspace() {
  return { repo: initRepo({ branch: "fix/double-charge" }), home: tempDir(), config: claudeConfigDir() };
}

describe("subagentStart: what a sub-agent starts knowing", () => {
  test("the head checkpoint, confirmed preferences and labelled items, within a cap well under session start's; no protocol, no questions for the user", () => {
    const { repo, home, config } = workspace();
    installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    const setup = open(repo, home, config);
    setup.bootstrap({ importChoice: "current_project" });
    setup.checkpoint({ expectedRevision: 0, goal: "Stop double charges", status: "Idempotency key drafted", nextSteps: ["Add the key to charge(); the gateway test already fails"] });
    const confirmed = setup.record({ kind: "preference", body: "Run the gateway tests before every commit.", attribution: "user_direction" });
    setup.settlePreference({ candidateId: confirmed.preference.candidateId ?? "", reply: { action: "accept", label: "This repo only" } });
    const pending = setup.record({ kind: "preference", body: "Squash commits before merging.", attribution: "user_direction" });
    expect(pending.preference.question).toContain("Squash commits before merging.");
    setup.close();

    const context = started(open(repo, home, config));
    expect(SUBAGENT_CONTEXT_CHARS).toBeLessThan(SESSION_CONTEXT_CHARS);
    expect(context.length).toBeLessThanOrEqual(SUBAGENT_CONTEXT_CHARS);
    expect(context).toMatch(/\[checkpoint r1 · (now|\dm) · claude-code · \w+\]/);
    expect(context).toContain("Add the key to charge(); the gateway test already fails");
    expect(context).toMatch(/## Preferences \(.*\)\n- Run the gateway tests before every commit\./);
    const items = (context.split("## Recent memory\n")[1] ?? "").split("\n").filter((line) => line.startsWith("- ["));
    expect(items.length).toBeGreaterThanOrEqual(3);
    // The checkpoint is the parent's to keep; the protocol and anything meant for the user stay with the parent.
    expect(context).toContain("do not call memory_checkpoint");
    expect(context).not.toContain(PROTOCOL);
    expect(context).not.toContain("Squash commits before merging.");
    expect(context).not.toContain("Preference question");
  });

  test("a pending preference question is left for the user: the parent's next session start still asks it", () => {
    const { repo, home, config } = workspace();
    const setup = open(repo, home, config);
    setup.bootstrap({ importChoice: "none" });
    setup.record({ kind: "preference", body: "Squash commits before merging.", attribution: "user_direction" });
    setup.close();
    expect(started(open(repo, home, config))).not.toContain("Squash commits before merging.");
    expect(open(repo, home, config).sessionStart()?.context).toContain("## Preference question for the user\n");
  });

  test("before consent the import question is not passed on: the sub-agent cannot ask the user", () => {
    const { repo, home, config } = workspace();
    installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    const context = started(open(repo, home, config));
    expect(context).not.toContain("importChoice");
    expect(context).toContain("No memory for this repository yet.");
  });

  test("a large memory is cut to the cap, and the cut says how to get the rest", () => {
    const { repo, home, config } = workspace();
    const setup = open(repo, home, config);
    setup.bootstrap({ importChoice: "none" });
    setup.checkpoint({ expectedRevision: 0, goal: "Stop double charges", status: "Drafted", nextSteps: [`Keep going ${"with the retry queue; ".repeat(90)}`], decisions: [`Order ${"by enqueue time; ".repeat(100)}`] });
    for (let i = 0; i < 60; i++) setup.record({ kind: "note", body: `Observation ${i}: ${"the retry queue drains in order; ".repeat(12)}`, attribution: "direct_observation" });
    setup.close();
    const context = started(open(repo, home, config));
    expect(context.length).toBeLessThanOrEqual(SUBAGENT_CONTEXT_CHARS);
    expect(context).toMatch(/… \(memory_read rec_[0-9a-f]{32} for all of it\)/);
    expect(context).toMatch(/more not shown: use memory_recall/);
  });

  test("memory that cannot be read is never presented as empty", () => {
    const { repo, home, config } = workspace();
    const setup = open(repo, home, config);
    setup.bootstrap({ importChoice: "none" });
    const dbPath = setup.status().storage.dbPath ?? "";
    setup.close();
    for (const suffix of ["-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
    writeFileSync(dbPath, "not a database ".repeat(100));
    const context = started(open(repo, home, config));
    // A sub-agent cannot tell the user: it says so in its report.
    expect(context).toMatch(/^Memory could not be loaded \(storage_\w+\)\. Do not assume this project has none; say so in your report\.$/);
    expect(open(repo, home, config).status().hookFailures.map((f) => [f.event, f.code.startsWith("storage_")])).toEqual([["subagent-start", true]]);
  });

  test("outside a Git repository it says nothing and records no failure", () => {
    const home = tempDir();
    expect(open(tempDir(), home, claudeConfigDir()).subagentStart({ hostSessionId: PARENT })).toBeNull();
    expect(recentHookFailures(home)).toEqual([]);
  });
});
