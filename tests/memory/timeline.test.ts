import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";

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
});
