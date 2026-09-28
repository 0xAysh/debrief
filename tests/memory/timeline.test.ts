import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { catchDebriefError, git, initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, claudeDelegatedTurn, codexThreadId, installSubagent, installTranscript } from "../import/fixtures.js";

/** One clock for every session a test opens, a minute per tick, so records interleave in a known order. */
function clock(): { now: () => Date; tick: () => void } {
  let at = Date.parse("2026-09-20T09:00:00.000Z");
  return { now: () => new Date(at), tick: () => (at += 60_000) };
}

function open(cwd: string, home: string, options: { now: () => Date; host?: string; hostSessionId?: string }): Memory {
  const memory = openMemory({
    cwd,
    home,
    host: options.host ?? "claude-code",
    now: options.now,
    ...(options.hostSessionId === undefined ? {} : { hostSessionId: options.hostSessionId }),
  });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

/** The record a timeline line stands for: an index line starts with its record id. */
const idOf = (line: string): string => line.slice(0, line.indexOf(" "));

describe("a timeline around a read record", () => {
  test("around: 2 returns up to two records before and two after from the same session, in time order, without the record itself", () => {
    const time = clock();
    const memory = open(initRepo(), tempDir(), time);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(memory.record({ kind: "note", body: `step ${i} of the queue migration`, attribution: "agent_inference" }).recordId);
      time.tick();
    }

    const read = memory.read({ recordId: ids[2] ?? "", around: 2 });
    expect(read.body).toBe("step 2 of the queue migration");
    expect(read.timeline?.before.map(idOf)).toEqual([ids[0], ids[1]]);
    expect(read.timeline?.after.map(idOf)).toEqual([ids[3], ids[4]]);
    expect(read.timeline?.omitted).toEqual({ before: 0, after: 0 });
    expect(read.timeline?.before[1]).toBe(`${ids[1]} [2026-09-20 · note · agent_inference · claude-code · unknown] step 1 of the queue migration`);
    // Near the start of the session there is only one record before.
    expect(memory.read({ recordId: ids[1] ?? "", around: 2 }).timeline?.before.map(idOf)).toEqual([ids[0]]);
  });

  test("another session's records, interleaved in time, never appear", () => {
    const time = clock();
    const repo = initRepo();
    const home = tempDir();
    const mine = open(repo, home, time);
    const theirs = open(repo, home, { ...time, host: "codex" });
    const own: string[] = [];
    const other: string[] = [];
    for (let i = 0; i < 4; i++) {
      own.push(mine.record({ kind: "note", body: `mine ${i}`, attribution: "agent_inference" }).recordId);
      time.tick();
      other.push(theirs.record({ kind: "note", body: `theirs ${i}`, attribution: "agent_inference" }).recordId);
      time.tick();
    }

    const timeline = mine.read({ recordId: own[1] ?? "", around: 3 }).timeline;
    expect(timeline?.before.map(idOf)).toEqual([own[0]]);
    expect(timeline?.after.map(idOf)).toEqual([own[2], own[3]]);
    expect(theirs.read({ recordId: other[2] ?? "", around: 3 }).timeline?.before.map(idOf)).toEqual([other[0], other[1]]);
  });

  test("retracted, superseded, tainted and checkpoint neighbours are skipped and do not use up around", () => {
    // The real clock: checkpoints and lifecycle changes are stamped with it, so everything stays in write order.
    const memory = openMemory({ cwd: initRepo(), home: tempDir(), host: "claude-code" });
    onCleanup(() => {
      memory.close();
    });
    const note = (body: string, supportedBy: string[] = []): string => memory.record({ kind: "note", body, attribution: "agent_inference", supportedBy }).recordId;
    const early = [note("first eligible"), note("second eligible")];
    const retracted = note("retracted before");
    const superseded = note("superseded before");
    const evidence = note("evidence that will be retracted");
    const tainted = note("rests on the retracted evidence", [evidence]);
    const checkpoint = memory.checkpoint({ expectedRevision: 0, goal: "g", status: "a checkpoint between" }).recordId;
    const target = note("the record being read");
    const retractedAfter = note("retracted after");
    const late = [note("third eligible"), note("fourth eligible")];
    for (const recordId of [retracted, evidence, retractedAfter]) memory.manage({ action: "retract", recordId, reason: "wrong", attribution: "user_direction" });
    memory.manage({ action: "supersede", recordId: superseded, body: "the new version", reason: "changed", attribution: "user_direction" });
    expect(memory.manage({ action: "inspect", recordId: tainted })).toMatchObject({ record: { lifecycle: "active", eligible: false } });

    const timeline = memory.read({ recordId: target, around: 2 }).timeline;
    expect(timeline?.before.map(idOf)).toEqual(early);
    expect(timeline?.after.map(idOf)).toEqual(late);
    expect([...(timeline?.before ?? []), ...(timeline?.after ?? [])].map(idOf)).not.toContain(checkpoint);
  });

  test("a private session's records never appear, even when it shares the host session id (a resumed Codex thread)", () => {
    const time = clock();
    const repo = initRepo();
    const home = tempDir();
    const threadId = codexThreadId();
    const first = open(repo, home, { ...time, host: "codex", hostSessionId: threadId });
    const kept: string[] = [];
    for (let i = 0; i < 3; i++) {
      kept.push(first.record({ kind: "note", body: `before the resume ${i}`, attribution: "agent_inference" }).recordId);
      time.tick();
    }
    // Resuming the thread starts a new Debrief session with the same thread id.
    const resumed = open(repo, home, { ...time, host: "codex", hostSessionId: threadId });
    expect(resumed.status().scope?.sessionId).not.toBe(first.status().scope?.sessionId);
    const hidden: string[] = [];
    for (let i = 0; i < 2; i++) {
      hidden.push(resumed.record({ kind: "note", body: `after the resume ${i}`, attribution: "agent_inference" }).recordId);
      time.tick();
    }
    resumed.manage({ action: "private_session" });

    const reader = open(repo, home, time);
    const timeline = reader.read({ recordId: kept[2] ?? "", around: 5 }).timeline;
    expect(timeline?.before.map(idOf)).toEqual([kept[0], kept[1]]);
    expect(timeline?.after).toEqual([]);
    for (const id of hidden) expect(catchDebriefError(() => reader.read({ recordId: id, around: 5 })).code).toBe("not_found");
  });

  test("another workstream's records never appear; workspace-level records of the same session do", () => {
    const time = clock();
    const memory = open(initRepo(), tempDir(), time);
    const first = memory.bootstrap({ importChoice: "none", task: "PROJ-7" }).scope;
    const note = (body: string, workspaceLevel = false): string => {
      const { recordId } = memory.record({ kind: "note", body, attribution: "agent_inference", workspaceLevel });
      time.tick();
      return recordId;
    };
    const elsewhere = note("written for the first workstream");
    const shared = note("true for the whole repository", true);
    // The user names another task and chooses a new workstream for it: the same session moves there.
    expect(memory.bootstrap({ task: "PROJ-8" }).scope.ambiguity).not.toBeNull();
    const moved = memory.bootstrap({ task: "PROJ-8", workstream: "new" }).scope;
    expect(moved).toMatchObject({ sessionId: first.sessionId, taskKey: "PROJ-8" });
    expect(moved.workstreamId).not.toBe(first.workstreamId);
    const target = note("written for PROJ-8");
    const later = memory.record({ kind: "note", body: "later, still for PROJ-8", attribution: "agent_inference" }).recordId;

    const timeline = memory.read({ recordId: target, around: 5 }).timeline;
    expect(timeline?.before.map(idOf)).toEqual([shared]);
    expect(timeline?.after.map(idOf)).toEqual([later]);
    expect([...(timeline?.before ?? []), ...(timeline?.after ?? [])].map(idOf)).not.toContain(elsewhere);
  });

  test("a tight budget keeps the nearest lines, counts the rest as omitted, and the body continues via nextOffset", () => {
    const time = clock();
    const memory = open(initRepo(), tempDir(), time);
    const note = (body: string): string => {
      const { recordId } = memory.record({ kind: "note", body, attribution: "agent_inference" });
      time.tick();
      return recordId;
    };
    const before = [0, 1, 2, 3].map((i) => note(`what came before, step ${i}`));
    const body = "The decision in full: drain the queue before the migration. ".repeat(20);
    const target = note(body);
    const after = [0, 1, 2, 3].map((i) => note(`what followed, step ${i}`));

    const whole = memory.read({ recordId: target, around: 4, maxBytes: 32_000 });
    expect(whole.body).toBe(body);
    expect(whole.budget.usedBytes).toBe(Buffer.byteLength(body) + [...(whole.timeline?.before ?? []), ...(whole.timeline?.after ?? [])].reduce((sum, line) => sum + Buffer.byteLength(line), 0));
    const bytes = (line: string | undefined): number => Buffer.byteLength(line ?? "");
    const [b1, b2] = [whole.timeline?.before[3], whole.timeline?.before[2]];
    const a1 = whole.timeline?.after[0];
    // Room for the three nearest lines (one before, one after, the next before) and 40 bytes of body.
    const maxBytes = bytes(b1) + bytes(a1) + bytes(b2) + 40;

    const tight = memory.read({ recordId: target, around: 4, maxBytes });
    expect(tight.timeline).toEqual({ before: [b2, b1], after: [a1], omitted: { before: 2, after: 3 } });
    expect(tight.timeline?.before.map(idOf)).toEqual([before[2], before[3]]);
    expect(tight.timeline?.after.map(idOf)).toEqual([after[0]]);
    expect(tight.body).toBe(body.slice(0, 40));
    expect(tight.budget.usedBytes).toBe(maxBytes);
    expect(tight.truncated).toBe(true);
    let rest = "";
    for (let offset = tight.nextOffset; offset !== null; ) {
      const slice = memory.read({ recordId: target, offset, maxBytes: 500 });
      rest += slice.body;
      offset = slice.nextOffset;
    }
    expect(tight.body + rest).toBe(body);
  });

  test("edges: the first and last records have an empty side, and around must be 1–10", () => {
    const time = clock();
    const memory = open(initRepo(), tempDir(), time);
    const ids = [0, 1, 2].map((i) => {
      const { recordId } = memory.record({ kind: "note", body: `record ${i}`, attribution: "agent_inference" });
      time.tick();
      return recordId;
    });
    expect(memory.read({ recordId: ids[0] ?? "", around: 10 }).timeline).toMatchObject({ before: [], after: [expect.stringContaining(ids[1] ?? ""), expect.stringContaining(ids[2] ?? "")] });
    expect(memory.read({ recordId: ids[2] ?? "", around: 10 }).timeline).toMatchObject({ before: [expect.stringContaining(ids[0] ?? ""), expect.stringContaining(ids[1] ?? "")], after: [] });
    for (const around of [0, 11, 1.5]) expect(catchDebriefError(() => memory.read({ recordId: ids[1] ?? "", around })).code).toBe("invalid_input");
  });

  test("neighbour lines carry live freshness: a cited file edited after recording shows stale", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "queue.ts"), "export const drain = () => 1;\n");
    writeFileSync(join(repo, "worker.ts"), "export const retry = () => 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "code");
    const time = clock();
    const memory = open(repo, tempDir(), time);
    const evidence = (body: string, locator: string): string => {
      const { recordId } = memory.record({ kind: "evidence", body, attribution: "direct_observation", externalRefs: [{ kind: "code", locator }] });
      time.tick();
      return recordId;
    };
    const drain = evidence("drain is slow", "queue.ts");
    const target = memory.record({ kind: "decision", body: "batch the drain", attribution: "agent_inference" }).recordId;
    time.tick();
    const retry = evidence("retry is linear", "worker.ts");
    writeFileSync(join(repo, "queue.ts"), "export const drain = () => 2;\n");

    const freshnessOf = (line: string | undefined): string => /\[([^\]]*)\]/.exec(line ?? "")?.[1]?.split(" · ").at(-1) ?? "";
    const timeline = memory.read({ recordId: target, around: 1 }).timeline;
    expect(timeline?.before.map(idOf)).toEqual([drain]);
    expect(freshnessOf(timeline?.before[0])).toBe("stale");
    expect(freshnessOf(timeline?.after[0])).toBe("current");
    // The same labels a read of each neighbour shows.
    expect(memory.read({ recordId: drain }).freshness).toBe("stale");
    expect(memory.read({ recordId: retry }).freshness).toBe("current");
  });

  test("imported records follow the transcript's time, not insert order: a sub-agent's work sits inside the turn that delegated it", () => {
    const repo = initRepo({ branch: "fix/double-charge" });
    const home = tempDir();
    const config = claudeConfigDir();
    const setup = openMemory({ cwd: repo, home, host: "claude-code", claudeConfigDir: config });
    setup.bootstrap({ importChoice: "current_project" });
    setup.close();
    const session = "e0d00000-0000-4000-8000-0000000000d9";
    const agentId = "a400000000000000d9";
    const at = new Date(Date.now() - 60_000);
    // The parent's turn: prompt at +0, the Agent call at +200, its hand-back at +300, the reply at +500.
    const turn = claudeDelegatedTurn({ cwd: repo, sessionId: session, n: 1, at, prompt: "SYNTHETIC-PROMPT check the retry budget", agentId, subagentPrompt: "SYNTHETIC-DELEGATED find the retry budget", report: "SYNTHETIC-REPORT three attempts" });
    const parent = installTranscript(config, "", { cwd: repo, sessionId: session, content: turn.lines });
    // The sub-agent ran inside it (+150 … +650), and is imported after the parent's transcript.
    installSubagent(config, { cwd: repo, sessionId: session, agentId, toolUseId: turn.toolUseId, at: new Date(at.getTime() + 150), prompt: "SYNTHETIC-DELEGATED find the retry budget", command: "grep -rn budget src", output: "SYNTHETIC-FINDING retry.ts sets 3", report: "SYNTHETIC-REPORT three attempts" });
    const memory = openMemory({ cwd: repo, home, host: "claude-code", claudeConfigDir: config });
    onCleanup(() => {
      memory.close();
    });
    expect(memory.endTurn({ transcriptPath: parent.path }).failure).toBeNull();

    // Every eligible record the import wrote, copies included, in the transcript's time order.
    const pack = memory.recall({ maxTokens: 8_000 });
    const imported = pack.items.flatMap((item) => [item, ...item.copies]).filter((entry) => entry.source?.transcriptId.startsWith(session));
    const byTime = [...imported].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    expect(new Set(byTime.map((entry) => entry.createdAt)).size).toBe(byTime.length);
    // In time order: the parent's prompt, the sub-agent's prompt, the parent's reply, then the sub-agent's command and report.
    expect(byTime.map((entry) => entry.source?.agentType ?? "parent")).toEqual(["parent", "general-purpose", "parent", "general-purpose", "general-purpose"]);
    const ids = byTime.map((entry) => entry.recordId);

    // Inserted after the parent's whole transcript, the sub-agent's prompt still comes before the parent's reply.
    const timeline = memory.read({ recordId: ids[2] ?? "", around: 10 }).timeline;
    expect(timeline?.before.map(idOf)).toEqual(ids.slice(0, 2));
    expect(timeline?.after.map(idOf)).toEqual(ids.slice(3));
  });
});
