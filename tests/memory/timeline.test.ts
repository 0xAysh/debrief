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
});
