import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { type ManageResult, type Memory, openMemory } from "../../src/memory.js";
import { catchDebriefError, initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, codexHome, codexThreadId, installCodexRollout, installTranscript, renderFixture } from "../import/fixtures.js";

interface Env {
  home: string;
  config: string;
  codex: string;
}

function env(): Env {
  return { home: tempDir(), config: claudeConfigDir(), codex: codexHome() };
}

function open(repo: string, e: Env, options: { host?: string; hostSessionId?: string } = {}): Memory {
  const memory = openMemory({
    cwd: repo,
    home: e.home,
    host: options.host ?? "claude-code",
    claudeConfigDir: e.config,
    codexHome: e.codex,
    ...(options.hostSessionId === undefined ? {} : { hostSessionId: options.hostSessionId }),
  });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

function markPrivate(memory: Memory): Extract<ManageResult, { action: "private_session" }> {
  const result = memory.manage({ action: "private_session" });
  if (result.action !== "private_session") throw new Error("unreachable");
  return result;
}

describe("don't remember this session", () => {
  test("marking forgets what the session wrote, refuses its later writes, and a second mark changes nothing", () => {
    const repo = initRepo();
    const e = env();
    const memory = open(repo, e);
    memory.bootstrap({ importChoice: "none" });
    const written = memory.record({ kind: "note", body: "Private musing about the queue.", attribution: "agent_inference" }).recordId;

    const first = markPrivate(memory);
    expect(first).toMatchObject({ v: 1, alreadyPrivate: false, forgotten: [written] });
    expect(first.notice).toMatch(/not be remembered/i);

    for (const write of [
      () => memory.record({ kind: "note", body: "x", attribution: "agent_inference" }),
      () => memory.record({ kind: "preference", body: "Use bun.", attribution: "user_direction" }),
      () => memory.checkpoint({ expectedRevision: 0, goal: "g", status: "s" }),
      () => memory.manage({ action: "retract", recordId: written, reason: "r", attribution: "user_direction" }),
    ]) {
      expect(catchDebriefError(write).code).toBe("session_private");
    }
    // Reads still work.
    expect(memory.recall().items).toEqual([]);
    expect(markPrivate(memory)).toMatchObject({ alreadyPrivate: true, forgotten: [] });

    const other = open(repo, e, { host: "codex" });
    expect(other.manage({ action: "inspect", recordId: written })).toMatchObject({ record: { lifecycle: "forgotten", body: "" } });
    expect(other.record({ kind: "note", body: "other sessions still write", attribution: "agent_inference" }).recordId).toMatch(/^rec_/);
  });

  test("a private Codex thread's rollout is never imported, and a resumed thread stays private", () => {
    const repo = initRepo();
    const e = env();
    const threadId = codexThreadId();
    const live = open(repo, e, { host: "codex", hostSessionId: threadId });
    live.bootstrap({ importChoice: "all" });
    markPrivate(live);
    installCodexRollout(e.codex, "0.142.5/basic.jsonl", { cwd: repo, threadId });

    const later = open(repo, e, { host: "codex" });
    later.bootstrap();
    expect(later.status().counts?.records).toBe(0);
    const resumed = open(repo, e, { host: "codex", hostSessionId: threadId });
    expect(catchDebriefError(() => resumed.record({ kind: "note", body: "x", attribution: "agent_inference" })).code).toBe("session_private");
  });

  test("a Claude transcript whose Debrief output names a private session is never imported, not even what came before it", () => {
    const repo = initRepo({ branch: "fix/double-charge" });
    const e = env();
    const live = open(repo, e);
    const sessionId = live.bootstrap({ importChoice: "all" }).scope.sessionId;
    markPrivate(live);
    // basic.jsonl contains a memory_recall result; make it the private session's output, as it would be.
    const content = renderFixture("2.1.281/basic.jsonl", { cwd: repo, sessionId: "5e550000-0000-4000-8000-0000000000cc" }).replace('{\\"items\\":', `{\\"scope\\":{\\"headRevision\\":0,\\"sessionId\\":\\"${sessionId}\\"},\\"items\\":`);
    expect(content).toContain(sessionId);
    installTranscript(e.config, "", { cwd: repo, sessionId: "5e550000-0000-4000-8000-0000000000cc", content });

    const later = open(repo, e, { host: "claude-code" });
    later.bootstrap();
    expect(later.recall({ query: "checkout double charges gateway" }).items).toEqual([]);
  });

  test("a transcript that merely recalled records a private session wrote is not that session's transcript", () => {
    const repo = initRepo({ branch: "fix/double-charge" });
    const e = env();
    const live = open(repo, e);
    const sessionId = live.bootstrap({ importChoice: "all" }).scope.sessionId;
    markPrivate(live);
    // A recalled item names its writer's session, but not as the scope's session.
    const content = renderFixture("2.1.281/basic.jsonl", { cwd: repo, sessionId: "5e550000-0000-4000-8000-0000000000ee" }).replace('{\\"items\\":[{', `{\\"items\\":[{\\"host\\":\\"claude-code\\",\\"sessionId\\":\\"${sessionId}\\",`);
    expect(content).toContain(sessionId);
    installTranscript(e.config, "", { cwd: repo, sessionId: "5e550000-0000-4000-8000-0000000000ee", content });
    const later = open(repo, e, { host: "claude-code" });
    later.bootstrap();
    expect(later.recall({ query: "checkout double charges gateway" }).items.length).toBeGreaterThan(0);
  });

  test("marking forgets what was already imported from the session's own transcript", () => {
    const repo = initRepo({ branch: "fix/double-charge" });
    const e = env();
    const live = open(repo, e);
    const sessionId = live.bootstrap({ importChoice: "all" }).scope.sessionId;
    const content = renderFixture("2.1.281/basic.jsonl", { cwd: repo, sessionId: "5e550000-0000-4000-8000-0000000000dd" }).replace('{\\"items\\":', `{\\"scope\\":{\\"headRevision\\":0,\\"sessionId\\":\\"${sessionId}\\"},\\"items\\":`);
    installTranscript(e.config, "", { cwd: repo, sessionId: "5e550000-0000-4000-8000-0000000000dd", content });
    live.bootstrap();
    expect(live.recall({ query: "checkout double charges gateway" }).items.length).toBeGreaterThan(0);

    const marked = markPrivate(live);
    expect(marked.forgotten.length).toBeGreaterThan(0);
    expect(open(repo, e, { host: "codex" }).recall({ query: "checkout double charges gateway" }).items).toEqual([]);
  });

  test("restoring an older database copy keeps the session private", () => {
    const repo = initRepo();
    const e = env();
    const threadId = codexThreadId();
    const live = open(repo, e, { host: "codex", hostSessionId: threadId });
    live.bootstrap({ importChoice: "all" });
    const dbPath = live.status().storage.dbPath ?? "";
    const backup = join(tempDir(), "backup.sqlite");
    live.close();
    copyFileSync(dbPath, backup);
    const again = open(repo, e, { host: "codex", hostSessionId: threadId });
    markPrivate(again);
    again.close();
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    copyFileSync(backup, dbPath);

    installCodexRollout(e.codex, "0.142.5/basic.jsonl", { cwd: repo, threadId });
    const later = open(repo, e, { host: "codex" });
    later.bootstrap();
    expect(later.status().counts?.records).toBe(0);
  });
});

/**
 * A resumed conversation is one session to the user: Codex resumes a thread, and Claude Code a
 * session (`claude --resume`), as a new Debrief session with the same host session id. "Don't
 * remember this session" in any of them forgets the whole conversation (#60).
 */
describe("don't remember this session, in a resumed conversation", () => {
  const note = (memory: Memory, body: string): string => memory.record({ kind: "note", body, attribution: "agent_inference" }).recordId;
  const gone = (reader: Memory, id: string): void => {
    expect(catchDebriefError(() => reader.read({ recordId: id, around: 5 })).code).toBe("not_found");
  };

  test("a resumed Codex thread forgets what its earlier session wrote and what was imported from the thread", () => {
    const repo = initRepo({ branch: "fix/double-charge" });
    const e = env();
    const threadId = codexThreadId();
    installCodexRollout(e.codex, "0.142.5/basic.jsonl", { cwd: repo, threadId });
    const first = open(repo, e, { host: "codex", hostSessionId: threadId });
    first.bootstrap({ importChoice: "all" });
    const imported = first.recall({ query: "checkout double charges gateway" }).items.map((item) => item.recordId);
    expect(imported.length).toBeGreaterThan(0);
    const r1 = note(first, "Thread note one: the ledger flush is batched.");
    const r2 = note(first, "Thread note two: the flush interval is five seconds.");
    const firstSession = first.status().scope?.sessionId;
    first.close();
    const resumed = open(repo, e, { host: "codex", hostSessionId: threadId });
    resumed.bootstrap();
    expect(resumed.status().scope?.sessionId).not.toBe(firstSession);
    const r3 = note(resumed, "Thread note three: flushing on shutdown is missing.");
    const reader = open(repo, e, { host: "claude-code" });
    // Before the mark, the timeline around r1 reaches r2.
    expect(reader.read({ recordId: r1, around: 5 }).timeline?.after.map((line) => line.slice(0, line.indexOf(" ")))).toContain(r2);

    markPrivate(resumed);

    expect(reader.recall({ query: "thread note ledger flush interval shutdown" }).items).toEqual([]);
    expect(reader.recall({ query: "checkout double charges gateway" }).items).toEqual([]);
    for (const id of [r1, r2, r3, ...imported]) gone(reader, id);
  });

  test("a resumed Claude Code session forgets what its earlier session wrote and what was imported from its transcript", () => {
    const repo = initRepo({ branch: "fix/double-charge" });
    const e = env();
    const hostSessionId = "5e550000-0000-4000-8000-0000000000f1";
    installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: repo, sessionId: hostSessionId });
    const first = open(repo, e);
    first.bootstrap({ importChoice: "all", hostSessionId });
    const imported = first.recall({ query: "checkout double charges gateway" }).items.map((item) => item.recordId);
    expect(imported.length).toBeGreaterThan(0);
    const r1 = note(first, "Session note one: the ledger flush is batched.");
    const r2 = note(first, "Session note two: the flush interval is five seconds.");
    const firstSession = first.status().scope?.sessionId;
    first.close();
    // `claude --resume` keeps Claude's session id and starts a new MCP server: a new Debrief session.
    const resumed = open(repo, e);
    resumed.bootstrap({ hostSessionId });
    expect(resumed.status().scope?.sessionId).not.toBe(firstSession);
    const r3 = note(resumed, "Session note three: flushing on shutdown is missing.");

    markPrivate(resumed);

    const reader = open(repo, e, { host: "codex" });
    expect(reader.recall({ query: "session note ledger flush interval shutdown" }).items).toEqual([]);
    expect(reader.recall({ query: "checkout double charges gateway" }).items).toEqual([]);
    for (const id of [r1, r2, r3, ...imported]) gone(reader, id);
  });

  test("another thread's sessions, and another host's session with the same host session id, are left alone", () => {
    const repo = initRepo();
    const e = env();
    const threadId = codexThreadId();
    const first = open(repo, e, { host: "codex", hostSessionId: threadId });
    first.bootstrap({ importChoice: "none" });
    const mine = note(first, "Thread note: the ledger flush is batched.");
    const otherThread = open(repo, e, { host: "codex", hostSessionId: codexThreadId() });
    const theirs = note(otherThread, "Other thread note: the cache warms on boot.");
    // Claude Code with a session id that happens to equal the Codex thread id: a different host session.
    const colliding = open(repo, e);
    colliding.bootstrap({ hostSessionId: threadId });
    const collided = note(colliding, "Colliding note: the queue drains nightly.");
    const resumed = open(repo, e, { host: "codex", hostSessionId: threadId });

    expect(markPrivate(resumed).forgotten).toEqual([mine]);

    const reader = open(repo, e, { host: "claude-code" });
    for (const id of [theirs, collided]) expect(reader.read({ recordId: id }).recordId).toBe(id);
    expect(reader.recall({ query: "cache warms boot" }).items.map((item) => item.recordId)).toEqual([theirs]);
    expect(reader.recall({ query: "queue drains nightly" }).items.map((item) => item.recordId)).toEqual([collided]);
    for (const other of [otherThread, colliding]) expect(note(other, "still writes")).toMatch(/^rec_/);
  });

  test("a restored older copy, taken before the resume, loses the earlier session's records and keeps the thread private", () => {
    const repo = initRepo();
    const e = env();
    const threadId = codexThreadId();
    const first = open(repo, e, { host: "codex", hostSessionId: threadId });
    first.bootstrap({ importChoice: "none" });
    const r1 = note(first, "Thread note one: the ledger flush is batched.");
    const r2 = note(first, "Thread note two: the flush interval is five seconds.");
    const dbPath = first.status().storage.dbPath ?? "";
    first.close();
    const backup = join(tempDir(), "backup.sqlite");
    copyFileSync(dbPath, backup);
    const resumed = open(repo, e, { host: "codex", hostSessionId: threadId });
    note(resumed, "Thread note three: flushing on shutdown is missing.");
    markPrivate(resumed);
    resumed.close();
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    copyFileSync(backup, dbPath);

    const reader = open(repo, e, { host: "claude-code" });
    expect(reader.recall({ query: "thread note ledger flush interval" }).items).toEqual([]);
    for (const id of [r1, r2]) gone(reader, id);
    // The copy never saw the resumed session: the thread is private through the earlier one.
    const again = open(repo, e, { host: "codex", hostSessionId: threadId });
    expect(catchDebriefError(() => note(again, "x")).code).toBe("session_private");
  });

  test("the result lists the earlier session's records and the notice says earlier sessions were included", () => {
    const repo = initRepo();
    const e = env();
    const threadId = codexThreadId();
    const first = open(repo, e, { host: "codex", hostSessionId: threadId });
    first.bootstrap({ importChoice: "none" });
    const r1 = note(first, "Thread note one.");
    const resumed = open(repo, e, { host: "codex", hostSessionId: threadId });
    const r2 = note(resumed, "Thread note two.");

    const marked = markPrivate(resumed);
    expect(marked.forgotten).toEqual(expect.arrayContaining([r1, r2]) as unknown);
    expect(marked.notice).toMatch(/earlier session/i);
    // A session with no earlier sessions says nothing of them.
    const alone = open(initRepo(), e, { host: "codex", hostSessionId: codexThreadId() });
    alone.bootstrap({ importChoice: "none" });
    expect(markPrivate(alone).notice).not.toMatch(/earlier session/i);
    // Nor does a Claude Code session whose session-start hook opened its own Debrief session: that is no resume.
    const claudeRepo = initRepo();
    const hostSessionId = "5e550000-0000-4000-8000-0000000000f2";
    open(claudeRepo, e).sessionStart({ hostSessionId });
    const server = open(claudeRepo, e);
    server.bootstrap({ importChoice: "none", hostSessionId });
    note(server, "Session note.");
    expect(markPrivate(server)).toMatchObject({ earlierSessions: 0, notice: expect.not.stringMatching(/earlier session/i) as unknown });
  });

  test("a global preference the earlier session confirmed is forgotten too", () => {
    const repo = initRepo();
    const e = env();
    const threadId = codexThreadId();
    const first = open(repo, e, { host: "codex", hostSessionId: threadId });
    first.bootstrap({ importChoice: "none" });
    const question = first.record({ kind: "preference", body: "Use bun instead of npm.", attribution: "user_direction" }).preference;
    const global = first.settlePreference({ candidateId: question.candidateId ?? "", reply: { action: "accept", label: "Everywhere" } });
    expect(global).toMatchObject({ state: "active", scope: "global" });
    const resumed = open(repo, e, { host: "codex", hostSessionId: threadId });

    expect(markPrivate(resumed).forgotten).toContain(global.recordId);
    expect(open(initRepo(), e, { host: "claude-code" }).bootstrap().preferences.items).toEqual([]);
  });

  test("a thread marked before this covered resumed conversations is repaired when the user marks it again", () => {
    const repo = initRepo();
    const e = env();
    const threadId = codexThreadId();
    const first = open(repo, e, { host: "codex", hostSessionId: threadId });
    first.bootstrap({ importChoice: "none" });
    const r1 = note(first, "Thread note one: the ledger flush is batched.");
    const question = first.record({ kind: "preference", body: "Use bun instead of npm.", attribution: "user_direction" }).preference;
    const global = first.settlePreference({ candidateId: question.candidateId ?? "", reply: { action: "accept", label: "Everywhere" } }).recordId ?? "";
    const resumed = open(repo, e, { host: "codex", hostSessionId: threadId });
    const resumedId = resumed.bootstrap().scope.sessionId;
    // What 0.1.0 left: the resumed session and the thread's transcript marked, the earlier session's memory active.
    const db = new Database(resumed.status().storage.dbPath ?? "");
    db.prepare("UPDATE sessions SET private = 1 WHERE id = ?").run(resumedId);
    db.prepare("INSERT INTO private_transcripts (host, transcript_id, session_id, created_at) VALUES ('codex', ?, ?, ?)").run(threadId, resumedId, new Date().toISOString());
    db.close();
    const reader = open(repo, e, { host: "claude-code" });
    expect(reader.read({ recordId: r1 }).recordId).toBe(r1);

    const repaired = markPrivate(resumed);
    expect(repaired).toMatchObject({ alreadyPrivate: false, earlierSessions: 1 });
    expect(repaired.forgotten).toEqual(expect.arrayContaining([r1, global]) as unknown);
    expect(repaired.notice).toMatch(/earlier session/i);
    gone(reader, r1);
    expect(open(initRepo(), e, { host: "claude-code" }).bootstrap().preferences.items).toEqual([]);
    // Now nothing is left: marking again changes nothing.
    expect(markPrivate(resumed)).toMatchObject({ alreadyPrivate: true, forgotten: [] });
  });

  test("the repair counts a global preference the earlier session left, even when nothing else is left", () => {
    const repo = initRepo();
    const e = env();
    const threadId = codexThreadId();
    const first = open(repo, e, { host: "codex", hostSessionId: threadId });
    first.bootstrap({ importChoice: "none" });
    const question = first.record({ kind: "preference", body: "Use bun instead of npm.", attribution: "user_direction" }).preference;
    const global = first.settlePreference({ candidateId: question.candidateId ?? "", reply: { action: "accept", label: "Everywhere" } }).recordId ?? "";
    const resumed = open(repo, e, { host: "codex", hostSessionId: threadId });
    const resumedId = resumed.bootstrap().scope.sessionId;
    const db = new Database(resumed.status().storage.dbPath ?? "");
    db.prepare("UPDATE sessions SET private = 1 WHERE id = ?").run(resumedId);
    db.prepare("INSERT INTO private_transcripts (host, transcript_id, session_id, created_at) VALUES ('codex', ?, ?, ?)").run(threadId, resumedId, new Date().toISOString());
    db.close();

    expect(markPrivate(resumed)).toMatchObject({ alreadyPrivate: false, forgotten: [global], earlierSessions: 1 });
  });
});
