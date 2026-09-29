import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { git, initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, claudeReadStep, claudeSession, installTranscript, type SessionStep } from "./fixtures.js";

/**
 * Imported file reads get freshness from the text the agent read (#54): the transcript holds
 * what the model saw, so its fingerprint (never the text) labels the read's record `current`
 * while the file still holds that text, `stale` once it does not. Transcripts are hand-written;
 * the files are real, in a real Git worktree.
 */

/** 30 distinct, non-blank lines. */
const GATEWAY = Array.from({ length: 30 }, (_, i) => `export const step${i + 1} = retry(${i + 1});`).join("\n") + "\n";

function writeFile(repo: string, path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

/** A repository with `files` committed. */
function repoWith(files: Record<string, string>): string {
  const repo = initRepo();
  for (const [path, content] of Object.entries(files)) writeFile(repo, path, content);
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "files");
  return repo;
}

/** Imports one hand-written Claude Code session recorded in `repo`, returning the memory it was imported into. */
function importClaude(repo: string, steps: readonly SessionStep[]): Memory {
  const config = claudeConfigDir();
  installTranscript(config, "", { cwd: repo, content: claudeSession({ cwd: repo, sessionId: "5e55a000-0000-4000-8000-000000000001", steps }) });
  const memory = openMemory({ cwd: repo, host: "claude-code", home: tempDir(), claudeConfigDir: config });
  onCleanup(() => {
    memory.close();
  });
  expect(memory.bootstrap({ importChoice: "current_project" }).import.state).toBe("complete");
  return memory;
}

/** Ids of the imported records whose title starts with `tool`, oldest first. */
function recordsOf(memory: Memory, tool: string): string[] {
  const found: { id: string; at: string }[] = [];
  let pack = memory.recall({ maxTokens: 8_000 });
  for (;;) {
    for (const item of pack.items) if (item.title?.startsWith(`${tool}:`)) found.push({ id: item.recordId, at: item.createdAt });
    if (pack.continuation === null) break;
    pack = memory.recall({ maxTokens: 8_000, continuation: pack.continuation });
  }
  return found.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map((r) => r.id);
}

/** The live label of the record's one reference: [freshness, reason, linesNow?]. */
function label(memory: Memory, recordId: string): unknown[] {
  const read = memory.read({ recordId });
  expect(read.externalRefs).toHaveLength(1);
  const ref = read.externalRefs[0];
  return ref?.linesNow === undefined ? [ref?.freshness, ref?.reason] : [ref.freshness, ref.reason, ref.linesNow];
}

describe("Claude Code Read", () => {
  test("R1: a whole-file Read is current while the file holds the text read, and stale once it is edited", () => {
    const repo = repoWith({ "src/gateway.ts": GATEWAY });
    const memory = importClaude(repo, [claudeReadStep(join(repo, "src/gateway.ts"), GATEWAY)]);
    const [read] = recordsOf(memory, "Read");
    expect(label(memory, read ?? "")).toEqual(["current", "unchanged"]);
    expect(memory.read({ recordId: read ?? "" }).externalRefs[0]).toMatchObject({ kind: "code", path: "src/gateway.ts", observedAt: "2026-09-23T09:00:01.500Z" });

    writeFile(repo, "src/gateway.ts", GATEWAY.replace("retry(30)", "retry(31)"));
    expect(label(memory, read ?? "")).toEqual(["stale", "changed"]);
  });

  test("R2: a Read with offset/limit fingerprints the lines read: an edit elsewhere or lines moved leave it current, an edit to them makes it stale", () => {
    const repo = repoWith({ "src/gateway.ts": GATEWAY });
    const memory = importClaude(repo, [claudeReadStep(join(repo, "src/gateway.ts"), GATEWAY, { offset: 10, limit: 5 })]);
    const [read] = recordsOf(memory, "Read");
    expect(memory.read({ recordId: read ?? "" }).externalRefs[0]).toMatchObject({ path: "src/gateway.ts", lines: [10, 14], freshness: "current" });

    writeFile(repo, "src/gateway.ts", GATEWAY.replace("retry(25)", "retry(250)"));
    expect(label(memory, read ?? "")).toEqual(["current", "changed_elsewhere"]);

    writeFile(repo, "src/gateway.ts", `// header\n// more\n${GATEWAY}`);
    expect(label(memory, read ?? "")).toEqual(["current", "lines_moved", [12, 16]]);

    writeFile(repo, "src/gateway.ts", GATEWAY.replace("retry(12)", "retry(120)"));
    expect(label(memory, read ?? "")).toEqual(["stale", "lines_changed"]);
  });
});
