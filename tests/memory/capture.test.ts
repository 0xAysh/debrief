import { appendFileSync, readdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, installTranscript, renderFixture } from "../import/fixtures.js";

function open(repo: string, home: string, config: string, hostSessionId?: string): Memory {
  const memory = openMemory({ cwd: repo, home, host: "claude-code", claudeConfigDir: config, ...(hostSessionId === undefined ? {} : { hostSessionId }) });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

/** A repo whose Claude Code history was approved (`current_project`) and imported once. */
function approved() {
  const repo = initRepo({ branch: "fix/double-charge" });
  const home = tempDir();
  const config = claudeConfigDir();
  const memory = open(repo, home, config);
  expect(memory.bootstrap({ importChoice: "current_project" }).import.state).toBe("complete");
  return { repo, home, config, memory };
}

function visible(memory: Memory, text: string): boolean {
  return memory.recall({ query: text, maxTokens: 8_000 }).items.some((item) => item.excerpt.includes(text));
}

describe("captureTurn: the one transcript a Stop hook names", () => {
  test("imports the named session's new lines, and only that session", () => {
    const { repo, config, memory } = approved();
    const session = installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    const other = installTranscript(config, "2.1.281/redis-claim.jsonl", { cwd: repo });

    const captured = memory.captureTurn({ transcriptPath: session.path });
    expect(captured).toMatchObject({ state: "captured", transcriptId: session.sessionId });
    expect(captured.events).toBeGreaterThan(0);
    expect(visible(memory, "idempotency key per order")).toBe(true);
    // The other session waits for its own Stop or the next session start.
    expect(visible(memory, "Redis is required")).toBe(false);

    const again = memory.captureTurn({ transcriptPath: session.path });
    expect(again).toMatchObject({ state: "captured", events: 0 });
    expect(other.sessionId).not.toBe(session.sessionId);
  });

  test("a hook's Memory that only captures binds no session, however many turns it captures", () => {
    const { repo, home, config, memory } = approved();
    const session = installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    const sessions = () => {
      const db = new Database(memory.status().storage.dbPath ?? "", { readonly: true });
      try {
        return (db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n;
      } finally {
        db.close();
      }
    };
    // The first import opens one session for the imported conversation itself; turns add none.
    memory.captureTurn({ transcriptPath: session.path });
    const before = sessions();
    for (let turn = 0; turn < 3; turn++) {
      appendFileSync(session.path, renderFixture("2.1.281/redis-claim.jsonl", { cwd: repo, sessionId: session.sessionId }).replaceAll("-0000000003", `-000000${turn}003`));
      const hook = open(repo, home, config, session.sessionId);
      hook.captureTurn({ transcriptPath: session.path });
      hook.close();
    }
    expect(sessions()).toBe(before);
  });

  test("a line still being written is left for the next capture, then imported once", () => {
    const { repo, config, memory } = approved();
    const lines = renderFixture("2.1.281/redis-claim.jsonl", { cwd: repo, sessionId: "5e550000-0000-4000-8000-0000000000c1" }).split(/(?<=\n)/);
    const first = lines[0] ?? "";
    const session = installTranscript(config, "", { cwd: repo, sessionId: "5e550000-0000-4000-8000-0000000000c1", content: first.slice(0, 40) });

    expect(memory.captureTurn({ transcriptPath: session.path })).toMatchObject({ state: "captured", events: 0 });
    appendFileSync(session.path, first.slice(40));
    expect(memory.captureTurn({ transcriptPath: session.path })).toMatchObject({ state: "captured", events: 1 });
    expect(memory.captureTurn({ transcriptPath: session.path })).toMatchObject({ state: "captured", events: 0 });
  });

  test("without consent nothing is read or created, and the result says why", () => {
    const repo = initRepo();
    const home = tempDir();
    const config = claudeConfigDir();
    const session = installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    const memory = open(repo, home, config);
    expect(memory.captureTurn({ transcriptPath: session.path })).toMatchObject({ state: "skipped", reason: "consent_required", events: 0 });
    expect(readdirSync(home)).toEqual([]);
    memory.bootstrap({ importChoice: "none" });
    expect(memory.captureTurn({ transcriptPath: session.path })).toMatchObject({ state: "skipped", reason: "declined" });
    expect(visible(memory, "idempotency key per order")).toBe(false);
  });

  test("a path that is not one of the host's transcripts is refused, whatever it contains", () => {
    const { repo, config, memory } = approved();
    const outside = join(tempDir(), "5e550000-0000-4000-8000-0000000000c2.jsonl");
    writeFileSync(outside, renderFixture("2.1.281/basic.jsonl", { cwd: repo, sessionId: "5e550000-0000-4000-8000-0000000000c2" }));
    const nested = installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    const subagent = join(nested.path.replace(/\.jsonl$/, ""), "subagents", "agent-1.jsonl");

    for (const path of [outside, subagent, join(config, "projects", "..", "..", "etc.jsonl"), "relative.jsonl"]) {
      expect(memory.captureTurn({ transcriptPath: path })).toMatchObject({ state: "skipped", reason: "not_a_transcript", events: 0 });
    }
    expect(visible(memory, "idempotency key per order")).toBe(false);
  });

  test("a transcript of another repository is not imported into this one", () => {
    const { config, memory } = approved();
    const elsewhere = initRepo();
    const session = installTranscript(config, "2.1.281/basic.jsonl", { cwd: elsewhere });
    expect(memory.captureTurn({ transcriptPath: session.path })).toMatchObject({ state: "skipped", reason: "not_approved", events: 0 });
    expect(visible(memory, "idempotency key per order")).toBe(false);
  });

  test("a session the user asked not to remember stays unread (the hook names Claude's session id)", () => {
    const { repo, home, config } = approved();
    const session = installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    const memory = open(repo, home, config, session.sessionId);
    memory.captureTurn({ transcriptPath: session.path });
    memory.bootstrap();
    memory.manage({ action: "private_session" });
    appendFileSync(session.path, renderFixture("2.1.281/redis-claim.jsonl", { cwd: repo, sessionId: session.sessionId }));
    expect(memory.captureTurn({ transcriptPath: session.path })).toMatchObject({ events: 0 });
    expect(visible(memory, "Redis is required")).toBe(false);
  });
});
