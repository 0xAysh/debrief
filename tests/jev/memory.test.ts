import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { git, initRepo, onCleanup, tempDir } from "../helpers.js";
import { enableJev } from "../../src/judge/jev.js";
import { type Memory, openMemory, type PackItem } from "../../src/memory.js";
import { debrief } from "./cli.js";
import { startJevStub, verdictReply, type JevStub } from "./stub.js";

/**
 * The memory module with Jev on (seam ③), against the localhost stub of TypeSafe's API: what a
 * verdict does to an item's warning, and what `debrief status` then reports.
 */

const KEY = "test-key-memory";
const RETRY = "export function retryDelay(attempt: number): number {\n  return 100 * 2 ** attempt;\n}\n";

async function judgedRepo(stub: JevStub): Promise<{ repo: string; home: string; memory: Memory; recordId: string }> {
  const repo = initRepo();
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/retry.ts"), RETRY);
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "retry");
  const home = tempDir();
  const access = { endpoint: stub.url, apiKey: KEY };
  expect(await enableJev(home, access, null, new Date())).toEqual({ ok: true });
  const memory = openMemory({ cwd: repo, host: "codex", home, jev: access });
  onCleanup(() => {
    memory.close();
  });
  memory.bootstrap();
  const { recordId } = memory.record({
    kind: "decision",
    title: "retryDelay backoff",
    body: "retryDelay doubles the delay on every attempt; the design note has the reasoning.",
    attribution: "agent_inference",
    externalRefs: [
      { kind: "code", locator: "src/retry.ts", lines: [1, 3] },
      { kind: "url", locator: "https://example.invalid/design-note" },
    ],
  });
  writeFileSync(join(repo, "src/retry.ts"), RETRY.replace("100 * 2", "100 * 3"));
  return { repo, home, memory, recordId };
}

function itemOf(memory: Memory, recordId: string): PackItem {
  const item = memory.recall({ query: "retryDelay" }).items.find((i) => i.recordId === recordId);
  if (item === undefined) throw new Error(`${recordId} was not recalled`);
  return item;
}

const STALE = "Stale: a referenced file changed or is gone. Read the current file before relying on this.";
const REMOTE = "Historical: issue/PR/URL/document state is as observed then; verify it with your own tools.";

describe("a verdict on a stale memory", () => {
  test("J6: the re-read warning stays unless Jev judged 'still holds' with high confidence (0.9 or more)", async () => {
    const cases: ["still_holds" | "invalidated", number, boolean][] = [
      ["still_holds", 0.95, true],
      ["still_holds", 0.9, true],
      ["still_holds", 0.89, false],
      ["invalidated", 0.97, false],
      ["invalidated", 0.55, false],
    ];
    for (const [verdict, p, lifted] of cases) {
      const label = `${verdict} ${p}`;
      const stub = await startJevStub();
      stub.answer = (body) => verdictReply(body, verdict, p);
      const { memory, recordId } = await judgedRepo(stub);

      const before = itemOf(memory, recordId);
      expect(before.judgment, label).toBeUndefined();
      expect(before.warning, label).toBe(`${STALE} ${REMOTE}`);
      expect(await memory.judge(), label).toMatchObject({ calls: 1, pending: 0, paused: false });

      const after = itemOf(memory, recordId);
      // Advisory: freshness itself is unchanged.
      expect(after.freshness, label).toBe("stale");
      expect(after.externalRefs.map((ref) => ref.freshness), label).toEqual(["stale", "unknown"]);
      expect(after.judgment, label).toEqual({ verdict, probability: p, model: "jev-1.13.0" });
      if (lifted) {
        expect(after.warning, label).toBe(`Changed since observed; Jev judged the change leaves this claim true (${p.toFixed(2)}). ${REMOTE}`);
      } else {
        expect(after.warning, label).toBe(`${STALE} ${REMOTE}`);
      }
      // A read shows the same verdict and warning.
      const read = memory.read({ recordId });
      expect(read.judgment, label).toEqual(after.judgment);
      expect(read.warning, label).toBe(after.warning);
    }
  });

  test("J12: debrief status shows Jev's calls, tokens and estimated dollars, today and in total", async () => {
    const stub = await startJevStub();
    const { repo, home, memory, recordId } = await judgedRepo(stub);
    const env = { TYPESAFE_API_KEY: KEY, DEBRIEF_JEV_ENDPOINT: stub.url };
    expect((await debrief(env, repo, home, "status")).stdout).toMatch(/jev today +0 calls, 0 tokens, ~\$0\.00/);

    itemOf(memory, recordId);
    await memory.judge();
    stub.answer = () => ({ status: 429, json: { error: "slow down" } });
    writeFileSync(join(repo, "src/retry.ts"), RETRY.replace("100 * 2", "100 * 4"));
    itemOf(memory, recordId);
    await memory.judge();

    const status = await debrief(env, repo, home, "status");
    // 1,000 input + 20 output tokens answered (the stub's usage), and one 429; $0.042 per million input tokens.
    expect(status.stdout).toMatch(/jev +on · jev-1\.13\.0 at http:\/\/127\.0\.0\.1:\d+/);
    expect(status.stdout).toMatch(/jev today +2 calls \(1 failed\), 1,020 tokens, ~\$0\.00004/);
    expect(status.stdout).toMatch(/jev total +2 calls \(1 failed\), 1,020 tokens, ~\$0\.00004/);
    expect(status.stdout + status.stderr).not.toContain(KEY);
    const listed = await debrief(env, repo, home, "jev");
    expect(listed.stdout).toMatch(new RegExp(`${new Date().toISOString().slice(0, 10)} +2 calls \\(1 failed\\), 1,020 tokens`));
  });
});
