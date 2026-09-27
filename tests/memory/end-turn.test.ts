import { appendFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, claudeTurn, installTranscript } from "../import/fixtures.js";

/**
 * A Claude Code session in a consenting repository, driven turn by turn the way its Stop hook
 * sees it: append the turn to the transcript, then end the turn in a fresh process's Memory.
 */
function session() {
  const repo = initRepo({ branch: "fix/double-charge" });
  const home = tempDir();
  const config = claudeConfigDir();
  const sessionId = "e0d00000-0000-4000-8000-000000000001";
  const { path } = installTranscript(config, "", { cwd: repo, sessionId, content: "" });
  const open = (): Memory => {
    const memory = openMemory({ cwd: repo, home, host: "claude-code", claudeConfigDir: config });
    onCleanup(() => {
      memory.close();
    });
    return memory;
  };
  const setup = open();
  setup.bootstrap({ importChoice: "current_project" });
  setup.close();
  let n = 0;
  let after: string | null = null;
  // Checkpoints are stamped with the wall clock: turns before one sit an hour earlier, turns after it an hour later.
  let base = Date.now() - 3_600_000;
  return {
    open,
    /** Appends turn n and ends it. */
    turn(work: { command?: string; edit?: string } = { command: "npm test" }, stopHookActive = false) {
      n++;
      const turn = claudeTurn({ cwd: repo, sessionId, n, at: new Date(base + n * 1_000), prompt: `Step ${n}.`, after, ...work });
      after = turn.last;
      if (n === 1) writeFileSync(path, turn.lines);
      else appendFileSync(path, turn.lines);
      const memory = open();
      const ended = memory.endTurn({ transcriptPath: path, stopHookActive });
      memory.close();
      return ended;
    },
    /** Ends the same turn again, with nothing new in the transcript. */
    again() {
      const memory = open();
      const ended = memory.endTurn({ transcriptPath: path, stopHookActive: false });
      memory.close();
      return ended;
    },
    checkpoint(expectedRevision: number) {
      const memory = open();
      memory.bootstrap();
      memory.checkpoint({ expectedRevision, goal: "Stop double charges", status: "Key drafted" });
      memory.close();
      base = Date.now() + 3_600_000;
    },
  };
}

describe("endTurn: the Stop hook saves the turn, then asks for a checkpoint that fell behind", () => {
  test("five turns of work after the checkpoint nudge once, at the fifth; the sixth does not", () => {
    const s = session();
    s.turn();
    s.checkpoint(0);
    const nudges = [1, 2, 3, 4, 5, 6].map(() => s.turn().nudge);
    expect(nudges.slice(0, 4)).toEqual([null, null, null, null]);
    expect(nudges[4]).toBe(
      "Memchor: the checkpoint (r1) is 5 turns behind, and those turns changed files or ran commands. Before you finish, update it with memory_checkpoint (expectedRevision 1): the next concrete step and why, not a status.",
    );
    expect(nudges[5]).toBeNull();
  });

  test("without any checkpoint, five turns of work ask for the first one", () => {
    const s = session();
    const nudges = [1, 2, 3, 4, 5].map(() => s.turn({ edit: "src/gateway.ts" }).nudge);
    expect(nudges[4]).toBe(
      "Memchor: 5 turns changed files or ran commands and no checkpoint covers them. Before you finish, write one with memory_checkpoint (expectedRevision 0): the next concrete step and why, not a status.",
    );
  });

  test("turns that only talk never nudge", () => {
    const s = session();
    expect([1, 2, 3, 4, 5, 6].map(() => s.turn({}).nudge)).toEqual([null, null, null, null, null, null]);
  });

  test("a stop the host is already continuing because of a hook never nudges again", () => {
    const s = session();
    [1, 2, 3, 4].forEach(() => s.turn());
    expect(s.turn({ command: "npm test" }, true).nudge).toBeNull();
  });

  test("the user sees what the turn saved, nothing when there was nothing new, and a turn that could not be saved", () => {
    const s = session();
    expect(s.turn().notice).toMatch(/^◪ memchor · saved turn \(\d+ events\)$/);
    expect(s.again().notice).toBeNull();
    const memory = s.open();
    expect(memory.endTurn({ transcriptPath: memory.status().storage.dbPath ?? "", stopHookActive: false }).notice).toMatch(/^◪ memchor · ⚠ turn not saved \(not_a_transcript\): memchor diag status$/);
  });
});
