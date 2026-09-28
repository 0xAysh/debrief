import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type CompactPack, type ContextPack, openMemory, type Memory } from "../../src/memory.js";
import { estimateTokens, type ExternalRef } from "../../src/schemas.js";
import { git, initRepo, onCleanup, tempDir } from "../helpers.js";

function open(cwd: string, home: string): Memory {
  const memory = openMemory({ cwd, host: "claude-code", home });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

/** The whole pack as a client receives it: the budget covers all of it. */
const packBytes = (pack: object): number => Buffer.byteLength(JSON.stringify(pack), "utf8");

/** The record an entry stands for, in either mode: an index line starts with its record id. */
const idOf = (entry: string | { recordId: string }): string => (typeof entry === "string" ? entry.slice(0, entry.indexOf(" ")) : entry.recordId);

/** What one index line costs the agent: its JSON string in the pack, quotes and separator included. */
const lineTokens = (line: string): number => estimateTokens(Buffer.byteLength(JSON.stringify(line), "utf8") + 1);

describe("compact recall", () => {
  test("returns one line per hit with id, date, kind, attribution, freshness and a one-line excerpt, at most ~100 tokens each", () => {
    const memory = open(initRepo(), tempDir());
    const long = memory.record({
      kind: "decision",
      body: `Retry failed jobs with exponential backoff and jitter.\n\n${"The worker retries each failed job after a growing delay. ".repeat(40)}`,
      attribution: "user_direction",
    });
    const titled = memory.record({ kind: "note", title: "Retry lives in the worker", body: "The retry loop is in src/worker.ts, not in the queue.", attribution: "agent_inference" });
    const checkpoint = memory.checkpoint({ expectedRevision: 0, goal: "make job retries safe", status: "backoff decided" });

    const pack = memory.recall({ query: "retry", mode: "compact" });
    const day = (iso: string): string => iso.slice(0, 10);
    expect(pack.items).toHaveLength(2);
    const lineOf = (recordId: string): string => pack.items.find((line) => line.startsWith(recordId)) ?? "";

    expect(lineOf(titled.recordId)).toBe(`${titled.recordId} [${day(titled.createdAt)} · note · agent_inference · claude-code · unknown] Retry lives in the worker`);
    const longLine = lineOf(long.recordId);
    const longHead = `${long.recordId} [${day(long.createdAt)} · decision · user_direction · claude-code · unknown] `;
    expect(longLine.slice(0, longHead.length)).toBe(longHead);
    // The excerpt is the start of the passage the full pack shows for the same query, on one line.
    expect(longLine).toMatch(/…$/);
    const excerpt = longLine.slice(longHead.length, -1);
    const passage = memory.recall({ query: "retry" }).items.find((item) => item.recordId === long.recordId)?.excerpt.replace(/\s+/g, " ").trim() ?? "";
    expect(excerpt.length).toBeGreaterThanOrEqual(100);
    expect(passage.slice(0, excerpt.length)).toBe(excerpt);
    const checkpointHead = `${checkpoint.recordId} [${day(checkpoint.createdAt)} · checkpoint r1 · claude-code · unknown] `;
    expect(pack.checkpoint?.slice(0, checkpointHead.length)).toBe(checkpointHead);
    for (const line of [...pack.items, pack.checkpoint ?? ""]) {
      expect(line).not.toMatch(/\n/);
      expect(lineTokens(line)).toBeLessThanOrEqual(100);
    }
    expect(pack.budget.usedBytes).toBe(packBytes(pack));
    // Every hit was returned: a shortened excerpt is not content left out.
    expect(pack.truncated).toBe(false);
  });

  test("respects the budget and fits more hits than a full pack in the same budget", () => {
    const memory = open(initRepo(), tempDir());
    for (let i = 0; i < 40; i++) {
      memory.record({ kind: "note", body: `deploy step ${i}: ${"roll the canary, watch the error rate, then promote. ".repeat(6)}`, attribution: "agent_inference", applicability: { commit: "0000000" } });
    }
    // Sweep budgets so every packing boundary (whole line, cut line, no room) is exercised. Below
    // ~1,250 bytes the envelope (scope, notice, continuation) leaves no room for an entry in either mode.
    for (let maxBytes = 1_250; maxBytes <= 9_000; maxBytes += 250) {
      const compact = memory.recall({ query: "deploy canary", mode: "compact", maxBytes });
      expect(compact.budget.usedBytes).toBe(packBytes(compact));
      expect(compact.budget.usedBytes).toBeLessThanOrEqual(maxBytes);
      expect(compact.items.length).toBeGreaterThan(0);
      expect(compact.items.length + (compact.omissions.find((o) => o.reason === "budget")?.count ?? 0)).toBe(40);
      if (maxBytes >= 2_000) expect(compact.items.length).toBeGreaterThan(memory.recall({ query: "deploy canary", maxBytes }).items.length);
    }
    const [full, compact] = [memory.recall({ query: "deploy canary" }), memory.recall({ query: "deploy canary", mode: "compact" })];
    expect(compact.budget.maxBytes).toBe(full.budget.maxBytes);
    expect(compact.items.length).toBeGreaterThanOrEqual(3 * full.items.length);
  });

  test("continuations stay in the frozen order across compact and full pages", () => {
    const memory = open(initRepo(), tempDir());
    for (let i = 0; i < 30; i++) {
      memory.record({ kind: "note", body: `cache ${"cache ".repeat(i % 5)}entry ${i}: ${"evict the least recently used key first. ".repeat(4)}`, attribution: "agent_inference", applicability: { commit: "0000000" } });
    }
    const order = memory.recall({ query: "cache entry", maxBytes: 32_000 }).items.map((item) => item.recordId);
    expect(order).toHaveLength(30);

    let page: ContextPack | CompactPack = memory.recall({ query: "cache entry", mode: "compact", maxBytes: 2_000 });
    const seen = page.items.map(idOf);
    // A write between pages shifts bm25 statistics; the frozen sequence neither reorders nor takes it in.
    const late = memory.record({ kind: "note", body: "cache entry cache entry cache entry, written late", attribution: "agent_inference" });
    for (let pages = 0; page.continuation !== null; pages++) {
      expect(pages).toBeLessThan(40);
      const continuation: string = page.continuation;
      page = pages % 2 === 0 ? memory.recall({ continuation, maxBytes: 2_000 }) : memory.recall({ continuation, mode: "compact", maxBytes: 2_000 });
      seen.push(...page.items.map(idOf));
    }
    expect(seen).toEqual(order);
    expect(seen).not.toContain(late.recordId);
  });

  test("ineligible records (retracted, superseded, forgotten, another workstream's, a private session's) never appear", () => {
    const repo = initRepo();
    const home = tempDir();
    const memory = open(repo, home);
    const body = (what: string): string => `billing ledger ${what}: ${"reconcile the ledger nightly against the processor. ".repeat(3)}`;
    const eligible = new Set<string>();
    for (let i = 0; i < 6; i++) eligible.add(memory.record({ kind: "note", body: body(`fact ${i}`), attribution: "direct_observation" }).recordId);

    const retracted = memory.record({ kind: "note", body: body("retracted"), attribution: "agent_inference" }).recordId;
    memory.manage({ action: "retract", recordId: retracted, reason: "wrong", attribution: "user_direction" });
    const superseded = memory.record({ kind: "decision", body: body("old plan"), attribution: "user_direction" }).recordId;
    const replaced = memory.manage({ action: "supersede", recordId: superseded, body: body("new plan"), reason: "changed", attribution: "user_direction" });
    if (replaced.action !== "supersede") throw new Error("unreachable");
    eligible.add(replaced.replacementId);
    const forgotten = memory.record({ kind: "note", body: body("forgotten"), attribution: "agent_inference" }).recordId;
    const preview = memory.manage({ action: "forget_preview", recordIds: [forgotten] });
    if (preview.action !== "forget_preview") throw new Error("unreachable");
    memory.manage({ action: "forget", confirmToken: preview.confirmToken, reason: "asked", attribution: "user_direction" });

    const worktree = join(tempDir("debrief-wt-"), "wt");
    git(repo, "worktree", "add", "--quiet", "-b", "other", worktree);
    const elsewhere = open(worktree, home).record({ kind: "note", body: body("other workstream"), attribution: "agent_inference" }).recordId;

    const secret = openMemory({ cwd: repo, host: "claude-code", home, hostSessionId: "5e550000-0000-4000-8000-00000000c053" });
    onCleanup(() => {
      secret.close();
    });
    const privateRecord = secret.record({ kind: "note", body: body("private session"), attribution: "agent_inference" }).recordId;
    expect(memory.recall({ query: "billing ledger private session", mode: "compact", maxTokens: 8_000 }).items.map(idOf)).toContain(privateRecord);
    secret.manage({ action: "private_session" });

    const ineligible = [retracted, superseded, forgotten, elsewhere, privateRecord];
    let page: CompactPack = memory.recall({ query: "billing ledger", mode: "compact", maxBytes: 1_500 });
    const seen = page.items.map(idOf);
    for (let pages = 0; page.continuation !== null; pages++) {
      expect(pages).toBeLessThan(20);
      page = memory.recall({ continuation: page.continuation, mode: "compact", maxBytes: 1_500 });
      seen.push(...page.items.map(idOf));
    }
    expect(new Set(seen)).toEqual(eligible);
    expect(seen).toHaveLength(eligible.size);
    for (const id of ineligible) expect(seen).not.toContain(id);
    expect(new Set(memory.recall({ query: "billing ledger", maxBytes: 32_000 }).items.map(idOf))).toEqual(eligible);
  });

  test("freshness labels match what the full pack shows for the same records", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "queue.ts"), "export const drain = () => 1;\n");
    writeFileSync(join(repo, "worker.ts"), "export const retry = () => 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "code");
    const memory = open(repo, tempDir());
    const note = (what: string, refs: ExternalRef[]): void => {
      memory.record({ kind: "evidence", body: `queue worker ${what}`, attribution: "direct_observation", externalRefs: refs });
    };
    note("drain is slow", [{ kind: "code", locator: "queue.ts" }]);
    note("retry is linear", [{ kind: "code", locator: "worker.ts" }]);
    note("both", [{ kind: "code", locator: "queue.ts" }, { kind: "code", locator: "worker.ts" }]);
    note("tracked in an issue", [{ kind: "issue", locator: "#53" }]);
    note("without references", []);
    memory.checkpoint({ expectedRevision: 0, goal: "queue worker speed", status: "measuring", externalRefs: [{ kind: "code", locator: "queue.ts" }] });
    writeFileSync(join(repo, "queue.ts"), "export const drain = () => 2;\n");

    const full = memory.recall({ query: "queue worker" });
    const compact = memory.recall({ query: "queue worker", mode: "compact" });
    const freshnessOf = (line: string): string => /\[([^\]]*)\]/.exec(line)?.[1]?.split(" · ").at(-1) ?? "";
    expect(new Map(compact.items.map((line) => [idOf(line), freshnessOf(line)]))).toEqual(new Map(full.items.map((item) => [item.recordId, item.freshness])));
    expect(new Set(full.items.map((item) => item.freshness))).toEqual(new Set(["current", "stale", "unknown"]));
    expect(full.checkpoint?.freshness).toBe("stale");
    expect(freshnessOf(compact.checkpoint ?? "")).toBe("stale");
  });
});
