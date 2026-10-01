import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Embedder, openEmbedder } from "../../src/embedding/embedder.js";
import { MODEL } from "../../src/embedding/model.js";
import { type CompactPack, type ContextPack, type ManageResult, type Memory, openMemory, type PackItem } from "../../src/memory.js";
import { textHash } from "../../src/retrieval/vectors.js";
import { git, initRepo, onCleanup, tempDir } from "../helpers.js";
import { PAYMENTS_SERVICE } from "./meaning-fixture.js";

/**
 * Meaning search in the memory module (#51, ADR 0001), with the real model: the bundle's
 * `embedder.mjs`, ONNX Runtime's WebAssembly build and the pinned model files in `dist/`, which the
 * test run builds. No mocks: every vector here comes from the model.
 */

const DIST = resolve(import.meta.dirname, "../../dist");

let embedder: Embedder;
beforeAll(() => {
  embedder = openEmbedder({ dir: DIST, execArgv: [] });
});
afterAll(() => {
  embedder.close();
});

function open(cwd: string, home: string, options: { model?: Embedder | null; hostSessionId?: string; now?: () => Date } = {}): Memory {
  const memory = openMemory({
    cwd,
    host: "claude-code",
    home,
    ...(options.model === null ? {} : { embedder: options.model ?? embedder }),
    ...(options.hostSessionId === undefined ? {} : { hostSessionId: options.hostSessionId }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

/** Runs the background fill to completion, as the MCP server does between calls; returns the texts it embedded. */
async function fill(memory: Memory): Promise<number> {
  let embedded = 0;
  for (;;) {
    const step = await memory.fillVectors({ maxChunks: 32 });
    if (step.state !== "filled") {
      expect(step.state).toBe("done");
      return embedded;
    }
    embedded += step.embedded;
  }
}

/** Records the fixture through `memory`; returns the ids of its keyed records. */
function seed(memory: Memory, records = PAYMENTS_SERVICE): Map<string, string> {
  const ids = new Map<string, string>();
  for (const record of records) {
    const { recordId } = memory.record({ kind: record.kind, body: record.body, attribution: "agent_inference" });
    if (record.key !== undefined) ids.set(record.key, recordId);
  }
  return ids;
}

const idsOf = (pack: ContextPack): string[] => pack.items.map((item) => item.recordId);
const need = (ids: Map<string, string>, key: string): string => {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`no record ${key}`);
  return id;
};

function dbPathOf(memory: Memory): string {
  const path = memory.status().storage.dbPath;
  if (path === null) throw new Error("no database");
  return path;
}

function vectorRows(path: string): { model: string; text_hash: string; vec: Buffer }[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare("SELECT model, text_hash, vec FROM chunk_vectors ORDER BY model, text_hash").all() as { model: string; text_hash: string; vec: Buffer }[];
  } finally {
    db.close();
  }
}

function manage<A extends ManageResult["action"]>(memory: Memory, input: Parameters<Memory["manage"]>[0], action: A): Extract<ManageResult, { action: A }> {
  const result = memory.manage(input);
  if (result.action !== action) throw new Error(`expected ${action}, got ${result.action}`);
  return result as Extract<ManageResult, { action: A }>;
}

function forget(memory: Memory, recordId: string): void {
  const { confirmToken } = manage(memory, { action: "forget_preview", recordIds: [recordId] }, "forget_preview");
  memory.manage({ action: "forget", confirmToken, reason: "The user asked to forget it.", attribution: "user_direction" });
}

/** The 50-record payments workspace, filled once for the tests that only read it. */
interface Workspace {
  repo: string;
  home: string;
  /** With meaning search, and without (keyword search alone, as on `main`): two sessions of one workspace. */
  meaning: Memory;
  keywords: Memory;
  ids: Map<string, string>;
}

let shared: Workspace | undefined;
const sharedDirs: string[] = [];
async function workspace(): Promise<Workspace> {
  if (shared !== undefined) return shared;
  const dir = (prefix: string): string => {
    const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    sharedDirs.push(path);
    return path;
  };
  const repo = dir("debrief-meaning-repo-");
  git(repo, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "--quiet", "-m", "initial");
  const home = dir("debrief-meaning-home-");
  const meaning = openMemory({ cwd: repo, host: "claude-code", home, embedder });
  const keywords = openMemory({ cwd: repo, host: "claude-code", home });
  const ids = seed(meaning);
  await fill(meaning);
  shared = { repo, home, meaning, keywords, ids };
  return shared;
}
afterAll(() => {
  shared?.meaning.close();
  shared?.keywords.close();
  for (const dir of sharedDirs) rmSync(dir, { recursive: true, force: true });
});

/** Six questions that share no word with the code memory that answers them. */
const MISMATCHED: [query: string, answer: string][] = [
  ["monetary precision rounding", "currency"],
  ["weekend shipping embargo", "oncall"],
  ["strong customer authentication friction", "threeds"],
  ["socket resets", "econnreset"],
  ["seller concurrency guard", "advisory"],
  ["throughput ceiling", "loadtest"],
];

describe("meaning search", () => {
  test("M1: code memory that shares no words with the question is in the top 5 by meaning, and not by keywords alone", async () => {
    const { meaning, keywords, ids } = await workspace();
    for (const [query, key] of MISMATCHED) {
      const answer = need(ids, key);
      expect(idsOf(keywords.recall({ query, maxTokens: 8_000 })).slice(0, 5), query).not.toContain(answer);
      const pack = meaning.recall({ query, maxTokens: 8_000 });
      expect(idsOf(pack).slice(0, 5), query).toContain(answer);
      expect(pack.items.find((item) => item.recordId === answer)?.why, query).toBe("meaning");
      expect(pack.notice ?? "", query).not.toMatch(/meaning search/);
    }
  });

  test("M2: identifiers, quoted phrases, error strings and paths keep the records they lift, first and in order", async () => {
    const { meaning, keywords } = await workspace();
    for (const query of ["createRefund", '"advisory locks"', "charges_idempotency_key_key", "src/payments/ledger.ts", "why does createRefund throw a TypeError"]) {
      const before = keywords.recall({ query, maxTokens: 8_000 });
      const lifted = leadingTiers(before);
      expect(lifted.length, query).toBeGreaterThan(0);
      const after = meaning.recall({ query, maxTokens: 8_000 });
      expect(after.items.slice(0, lifted.length), query).toEqual(lifted);
    }
  });

  test("M2: a time window and a question about now keep the records they lift, first and in order", async () => {
    const repo = initRepo();
    const home = tempDir();
    let clock = new Date("2026-09-22T10:00:00");
    const now = (): Date => clock;
    const meaning = open(repo, home, { now });
    const keywords = open(repo, home, { model: null, now });
    meaning.record({ kind: "decision", body: "The job queue runs on Redis lists with a single consumer.", attribution: "agent_inference" });
    meaning.record({ kind: "note", body: "Webhook handler latency rose after the deploy on Tuesday.", attribution: "direct_observation" });
    clock = new Date("2026-09-29T10:00:00");
    meaning.record({ kind: "decision", body: "The job queue moved to a Postgres table polled with SKIP LOCKED.", attribution: "agent_inference" });
    meaning.record({ kind: "note", body: "Webhook handler latency is back to normal after moving it to its own deployment.", attribution: "direct_observation" });
    for (const body of PAYMENTS_SERVICE.slice(10, 30).map((record) => record.body)) meaning.record({ kind: "note", body, attribution: "agent_inference" });
    clock = new Date("2026-09-30T12:00:00");
    await fill(meaning);
    for (const query of ["webhook handler latency last week", "what do we use now for the job queue"]) {
      const before = keywords.recall({ query, maxTokens: 8_000 });
      const lifted = leadingTiers(before);
      expect(lifted.length, query).toBeGreaterThan(0);
      expect(meaning.recall({ query, maxTokens: 8_000 }).items.slice(0, lifted.length), query).toEqual(lifted);
    }
  });

  test("M3: why says meaning for what meaning placed, a continuation carries it to later pages, and later pages ask the model nothing", async () => {
    const { meaning, ids } = await workspace();
    const query = "socket resets";
    const first = meaning.recall({ query, maxBytes: 2_500 });
    meaning.noteCall({ source: "tool", name: "memory_recall", args: { query, maxBytes: 2_500 }, result: first, ms: 1, bytes: 1 });
    expect(first.items[0]?.recordId).toBe(need(ids, "econnreset"));
    expect(first.continuation).not.toBeNull();
    const second = meaning.recall({ continuation: first.continuation ?? "", maxBytes: 2_500 });
    meaning.noteCall({ source: "tool", name: "memory_recall", args: { continuation: "…", maxBytes: 2_500 }, result: second, ms: 1, bytes: 1 });
    expect(second.items.length).toBeGreaterThan(0);
    // Nothing matches "socket resets" by its words: meaning placed every record on every page.
    for (const item of [...first.items, ...second.items]) expect(item.why).toBe("meaning");
    expect(new Set([...idsOf(first), ...idsOf(second)]).size).toBe(first.items.length + second.items.length);

    const db = new Database(dbPathOf(meaning), { readonly: true });
    const stages = (db.prepare("SELECT stages FROM call_log WHERE name = 'memory_recall' ORDER BY id DESC LIMIT 2").all() as { stages: string }[]).map(
      (row) => Object.keys(JSON.parse(row.stages) as Record<string, number>).sort(),
    );
    db.close();
    expect(stages).toEqual([
      ["freshness", "load", "pack", "rank"],
      ["embed", "freshness", "load", "meaning", "pack", "rank"],
    ]);
  });

  test("M3: a record keywords found that meaning ranks higher says so; one it leaves in place does not", async () => {
    const { meaning, keywords } = await workspace();
    const query = "ledger reconciliation payouts";
    const before = idsOf(keywords.recall({ query, maxTokens: 8_000 }));
    const after = meaning.recall({ query, maxTokens: 8_000 });
    expect(before.length).toBeGreaterThan(3);
    const placed = after.items.map((item, position) => ({ item, position, keywordAt: before.indexOf(item.recordId) }));
    const raised = placed.filter(({ position, keywordAt }) => keywordAt === -1 || position < keywordAt);
    expect(raised.length).toBeGreaterThan(0);
    for (const { item } of raised) expect(item.why ?? "").toMatch(/\bmeaning$/);
    for (const { item } of placed.filter(({ position, keywordAt }) => keywordAt !== -1 && position >= keywordAt)) expect(item.why ?? "").not.toMatch(/meaning/);
  });

  test("M4: retracted, forgotten, superseded, private-session and other-workstream copies are never returned and never push the answer off page 1", async () => {
    const repo = initRepo();
    const home = tempDir();
    const memory = open(repo, home);
    seed(memory, PAYMENTS_SERVICE.filter((record) => record.key !== "currency"));
    const answer = memory.record({ kind: "decision", body: "Amounts are stored as integer minor units with an ISO 4217 code; never floats.", attribution: "agent_inference" }).recordId;
    const copy = (body: string, by = memory): string => by.record({ kind: "decision", body, attribution: "agent_inference" }).recordId;
    const retracted = copy("Amounts are kept as integer minor units with an ISO 4217 code; never floats.");
    const superseded = copy("Amounts are stored as integer minor units with ISO 4217 codes; never use floats.");
    const forgotten = copy("Amounts are saved as integer minor units with an ISO 4217 code; never floats.");
    const worktree = join(tempDir("debrief-wt-"), "wt");
    git(repo, "worktree", "add", "--quiet", "-b", "other", worktree);
    const elsewhere = copy("Amounts are stored as integer minor units together with an ISO 4217 code; never floats.", open(worktree, home));
    const secret = open(repo, home, { hostSessionId: "5e550000-0000-4000-8000-00000000a051" });
    const privateCopy = copy("Amounts live as integer minor units with an ISO 4217 code; never floats.", secret);
    // Every copy is embedded while it is still current: what keeps them out is recall's eligibility.
    await fill(memory);
    expect(vectorRows(dbPathOf(memory)).length).toBeGreaterThanOrEqual(PAYMENTS_SERVICE.length + 5);

    manage(memory, { action: "retract", recordId: retracted, reason: "wrong", attribution: "user_direction" }, "retract");
    manage(memory, { action: "supersede", recordId: superseded, body: "Totals are reported per currency in the settlement CSV.", reason: "changed", attribution: "user_direction" }, "supersede");
    forget(memory, forgotten);
    manage(secret, { action: "private_session" }, "private_session");

    const ineligible = [retracted, superseded, forgotten, elsewhere, privateCopy];
    const query = "monetary precision rounding";
    let page = memory.recall({ query, maxBytes: 3_000 });
    expect(idsOf(page)).toContain(answer);
    const seen = idsOf(page);
    while (page.continuation !== null) {
      page = memory.recall({ continuation: page.continuation, maxBytes: 3_000 });
      seen.push(...idsOf(page));
    }
    expect(seen.length).toBeGreaterThan(10);
    for (const id of ineligible) expect(seen).not.toContain(id);
  });

  test("M5: recall without a query is byte for byte what keyword search returns, in both modes", async () => {
    const { repo, home } = await workspace();
    // Two sessions that resolve their scope alike (the worktree's binding), one with the model.
    const meaning = open(repo, home);
    const keywords = open(repo, home, { model: null });
    const same = (pack: ContextPack | CompactPack): string => JSON.stringify({ ...pack, scope: { ...pack.scope, sessionId: "x" } });
    for (const input of [{}, { maxBytes: 3_000 }, { kinds: ["decision" as const] }]) {
      const full = meaning.recall(input);
      expect(same(full)).toBe(same(keywords.recall(input)));
      expect(same(meaning.recall({ ...input, mode: "compact" }))).toBe(same(keywords.recall({ ...input, mode: "compact" })));
      expect(full.notice ?? "").not.toMatch(/meaning/);
    }
  });

  test("M5: budgets, citations, freshness and copies of every item are what keyword search gives it", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "retry.ts"), "export const retries = 3;\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "code");
    const home = tempDir();
    const memory = open(repo, home);
    const keywords = open(repo, home, { model: null });
    seed(memory, PAYMENTS_SERVICE.slice(0, 30));
    const evidence = memory.record({ kind: "evidence", body: "The retry loop gave up after 3 attempts on the gateway timeout.", attribution: "direct_observation", externalRefs: [{ kind: "code", locator: "retry.ts", path: "retry.ts" }] }).recordId;
    memory.record({ kind: "decision", body: "Keep 3 retries for gateway timeouts; more only add load.", attribution: "agent_inference", supportedBy: [evidence] });
    memory.record({ kind: "note", body: "The retry loop gave up after 3 attempts on the gateway timeout.", attribution: "agent_inference", links: [{ to: evidence, relation: "derived_from" }] });
    await fill(memory);
    writeFileSync(join(repo, "retry.ts"), "export const retries = 5;\n");

    for (const maxBytes of [1_500, 4_000, 32_000]) {
      const query = "gateway timeout retries";
      const before = keywords.recall({ query, maxBytes });
      const after = memory.recall({ query, maxBytes });
      expect(after.budget.maxBytes).toBe(before.budget.maxBytes);
      expect(after.budget.usedBytes).toBeLessThanOrEqual(maxBytes);
      const byId = new Map(before.items.map((item) => [item.recordId, item]));
      const both = after.items.filter((item) => byId.has(item.recordId));
      if (maxBytes === 32_000) expect(both.length).toBeGreaterThan(2);
      // Everything but `why`, which says what meaning did.
      for (const item of both) expect({ ...item, why: undefined }).toEqual({ ...byId.get(item.recordId), why: undefined });
    }
    const full = memory.recall({ query: "gateway timeout retries", maxTokens: 8_000 }).items;
    const cited = full.find((item) => item.recordId === evidence);
    expect(cited).toMatchObject({ freshness: "stale", copies: [expect.objectContaining({ recordId: expect.any(String) as unknown })] });
    expect(full.find((item) => item.citations.some((citation) => citation.recordId === evidence))).toBeDefined();
  });

  test("M6: with no model, or a model that fails to load, results are exactly keyword search's plus a notice", async () => {
    const { repo, home, keywords } = await workspace();
    const corrupt = realpathSync(mkdtempSync(join(tmpdir(), "debrief-bad-model-")));
    onCleanup(() => {
      rmSync(corrupt, { recursive: true, force: true });
    });
    cpSync(DIST, corrupt, { recursive: true, filter: (path) => !path.endsWith(".js") && !path.endsWith(".map") && !path.endsWith(".d.ts") });
    const model = join(corrupt, MODEL.directory, "model_quantized.onnx");
    writeFileSync(model, Buffer.alloc(readFileSync(model).length, 7));
    const missing = tempDir("debrief-no-model-");

    for (const [dir, why] of [
      [missing, /embedder\.mjs is missing/],
      [corrupt, /model_quantized\.onnx does not match the pinned model/],
    ] as const) {
      const broken = openEmbedder({ dir, execArgv: [] });
      onCleanup(() => {
        broken.close();
      });
      const memory = open(repo, home, { model: broken });
      for (const query of ["ledger reconciliation payouts", "socket resets", "createRefund"]) {
        const before = keywords.recall({ query, maxTokens: 8_000 });
        const after = memory.recall({ query, maxTokens: 8_000 });
        expect(after.items).toEqual(before.items);
        expect(after.notice ?? "").toMatch(/meaning search unavailable: /);
        expect(after.notice ?? "").toMatch(why);
      }
      expect(memory.status().meaning).toMatchObject({ model: MODEL.id, state: "failed", problem: expect.stringMatching(why) as unknown });
    }
  });

  test("M7: while vectors are missing, recall returns every keyword result and says how much of memory meaning covers", async () => {
    const repo = initRepo();
    const home = tempDir();
    const memory = open(repo, home);
    const keywords = open(repo, home, { model: null });
    seed(memory);
    expect(await memory.fillVectors({ maxChunks: 10 })).toMatchObject({ state: "filled", embedded: 10, stored: 10 });
    const coverage = memory.status().meaning?.coverage;
    expect(coverage).toEqual({ chunks: PAYMENTS_SERVICE.length, embedded: 10, percent: 20 });
    for (const query of ["ledger reconciliation payouts", "webhook latency", "merchant payouts"]) {
      const before = idsOf(keywords.recall({ query, maxTokens: 8_000 }));
      const after = memory.recall({ query, maxTokens: 8_000 });
      expect(before.length).toBeGreaterThan(0);
      expect(idsOf(after)).toEqual(expect.arrayContaining(before));
      expect(after.notice ?? "").toMatch(/(^|\. )meaning search covers 20% of memory$/);
    }
    await fill(memory);
    expect(memory.recall({ query: "webhook latency", maxTokens: 8_000 }).notice ?? "").not.toMatch(/meaning search/);
    expect(memory.status().meaning?.coverage).toEqual({ chunks: PAYMENTS_SERVICE.length, embedded: PAYMENTS_SERVICE.length, percent: 100 });
  });

  test("M11: forgotten and private-session records are never embedded, even when forgotten while their text is with the model", async () => {
    const repo = initRepo();
    const home = tempDir();
    const memory = open(repo, home);
    seed(memory, PAYMENTS_SERVICE.slice(0, 5));
    const before = "Old vendor contract: penalty clause 7b, account ref VND-4471.";
    forget(memory, memory.record({ kind: "note", body: before, attribution: "agent_inference" }).recordId);

    const secret = open(repo, home, { hostSessionId: "5e550000-0000-4000-8000-00000000b011" });
    const privateBody = "Personal note: salary negotiation for Q4 starts at 140k.";
    secret.record({ kind: "note", body: privateBody, attribution: "user_direction" });
    manage(secret, { action: "private_session" }, "private_session");

    // Forgotten after the fill read its text and while the model embeds it: no vector is stored.
    const during = "Customer escalation: refund dispute with account ref CUS-9902.";
    const racing = memory.record({ kind: "note", body: during, attribution: "agent_inference" }).recordId;
    const step = memory.fillVectors({ maxChunks: 32 });
    forget(memory, racing);
    expect(await step).toMatchObject({ state: "filled", embedded: 6, stored: 5 });
    await fill(memory);

    const hashes = new Set(vectorRows(dbPathOf(memory)).map((row) => row.text_hash));
    expect(hashes.size).toBe(5);
    for (const body of [before, privateBody, during]) expect(hashes.has(textHash(body)), body).toBe(false);
    for (const record of PAYMENTS_SERVICE.slice(0, 5)) expect(hashes.has(textHash(record.body))).toBe(true);
  });

  test("M13: vectors of another model are never used; coverage starts again at 0 and the fill re-embeds", async () => {
    const repo = initRepo();
    const home = tempDir();
    const memory = open(repo, home);
    const keywords = open(repo, home, { model: null });
    const ids = seed(memory);
    await fill(memory);
    const path = dbPathOf(memory);
    // Another model's vectors: every vector, retagged, and those of two records swapped, so using them would show.
    const db = new Database(path);
    db.prepare("UPDATE chunk_vectors SET model = 'other-model@q8'").run();
    const swap = (a: string, b: string): void => {
      const vec = (hash: string): Buffer => (db.prepare("SELECT vec FROM chunk_vectors WHERE text_hash = ?").get(hash) as { vec: Buffer }).vec;
      const [va, vb] = [vec(a), vec(b)];
      db.prepare("UPDATE chunk_vectors SET vec = ? WHERE text_hash = ?").run(vb, a);
      db.prepare("UPDATE chunk_vectors SET vec = ? WHERE text_hash = ?").run(va, b);
    };
    const bodyOf = (key: string): string => PAYMENTS_SERVICE.find((record) => record.key === key)?.body ?? "";
    swap(textHash(bodyOf("econnreset")), textHash(bodyOf("currency")));
    db.close();

    expect(memory.status().meaning?.coverage).toEqual({ chunks: PAYMENTS_SERVICE.length, embedded: 0, percent: 0 });
    for (const query of ["socket resets", "monetary precision rounding", "ledger reconciliation payouts"]) {
      const after = memory.recall({ query, maxTokens: 8_000 });
      expect(after.items).toEqual(keywords.recall({ query, maxTokens: 8_000 }).items);
      expect(after.notice ?? "").toMatch(/meaning search covers 0% of memory$/);
    }

    // The next process with this model (a model change is a new release) embeds everything again.
    const next = open(repo, home);
    next.bootstrap();
    expect(await fill(next)).toBe(PAYMENTS_SERVICE.length);
    expect(next.status().meaning?.coverage).toEqual({ chunks: PAYMENTS_SERVICE.length, embedded: PAYMENTS_SERVICE.length, percent: 100 });
    const rows = vectorRows(path);
    expect(rows.filter((row) => row.model === MODEL.id)).toHaveLength(PAYMENTS_SERVICE.length);
    expect(rows.filter((row) => row.model === "other-model@q8")).toHaveLength(PAYMENTS_SERVICE.length);
    expect(idsOf(memory.recall({ query: "socket resets" }))[0]).toBe(need(ids, "econnreset"));
  });

  test("M15: forget removes a record's vector from the database file, unless another live chunk has the same text", async () => {
    const repo = initRepo();
    const home = tempDir();
    const memory = open(repo, home);
    seed(memory, PAYMENTS_SERVICE.slice(0, 8));
    const secret = "Escrow account for the Lisbon office: IBAN PT50 0002 0123 1234 5678 9015 4.";
    const shared = "The staging gateway rejects cards issued in Brazil with code BR-17.";
    const target = memory.record({ kind: "note", body: secret, attribution: "user_direction" }).recordId;
    const twin = memory.record({ kind: "note", body: shared, attribution: "agent_inference" }).recordId;
    memory.record({ kind: "evidence", body: shared, attribution: "direct_observation" });
    await fill(memory);
    const path = dbPathOf(memory);
    const vecOf = (body: string): Buffer | undefined => vectorRows(path).find((row) => row.text_hash === textHash(body))?.vec;
    const secretVec = vecOf(secret);
    const sharedVec = vecOf(shared);
    expect(secretVec?.length).toBe(MODEL.dimensions);
    expect(sharedVec?.length).toBe(MODEL.dimensions);

    forget(memory, target);
    forget(memory, twin);
    expect(vecOf(secret)).toBeUndefined();
    expect(vecOf(shared)).toEqual(sharedVec);
    memory.close();
    // With every connection closed (the WAL folded back), the file itself: secure_delete zeroed the freed bytes.
    const raw = readFileSync(path);
    expect(raw.indexOf(secretVec ?? Buffer.alloc(0))).toBe(-1);
    expect(raw.indexOf(sharedVec ?? Buffer.alloc(0))).toBeGreaterThan(-1);
  });

  test("M16: a private session erases its vectors, and so does replaying the ledger on a restored older copy", async () => {
    const repo = initRepo();
    const home = tempDir();
    const session = "5e550000-0000-4000-8000-00000000c016";
    const others = open(repo, home);
    seed(others, PAYMENTS_SERVICE.slice(0, 6));
    const writer = open(repo, home, { hostSessionId: session });
    const body = "Draft layoff plan for the support team, not announced yet.";
    writer.record({ kind: "note", body, attribution: "user_direction" });
    await fill(writer);
    const path = dbPathOf(writer);
    const vector = vectorRows(path).find((row) => row.text_hash === textHash(body))?.vec;
    expect(vector?.length).toBe(MODEL.dimensions);
    expect(vectorRows(path)).toHaveLength(7);
    others.close();
    writer.close();
    const backup = join(tempDir(), "backup.sqlite");
    copyFileSync(path, backup);

    const same = open(repo, home, { hostSessionId: session });
    manage(same, { action: "private_session" }, "private_session");
    expect(vectorRows(path).some((row) => row.text_hash === textHash(body))).toBe(false);
    same.close();
    expect(readFileSync(path).indexOf(vector ?? Buffer.alloc(0))).toBe(-1);

    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) rmSync(path + suffix);
    copyFileSync(backup, path);
    expect(readFileSync(path).indexOf(vector ?? Buffer.alloc(0))).toBeGreaterThan(-1);
    const restored = open(repo, home);
    // Opening the workspace replays the ledger.
    restored.bootstrap();
    expect(vectorRows(path).some((row) => row.text_hash === textHash(body))).toBe(false);
    expect(vectorRows(path)).toHaveLength(6);
    restored.close();
    expect(readFileSync(path).indexOf(vector ?? Buffer.alloc(0))).toBe(-1);
  });

  test("M19: status shows the model, whether it is loaded, and this repository's coverage", async () => {
    const repo = initRepo();
    const home = tempDir();
    const own = openEmbedder({ dir: DIST, execArgv: [] });
    onCleanup(() => {
      own.close();
    });
    const memory = open(repo, home, { model: own });
    seed(memory, PAYMENTS_SERVICE.slice(0, 4));
    expect(memory.status().meaning).toEqual({ model: MODEL.id, state: "unloaded", problem: null, coverage: { chunks: 4, embedded: 0, percent: 0 }, filled: 0 });
    await fill(memory);
    expect(memory.status().meaning).toEqual({ model: MODEL.id, state: "loaded", problem: null, coverage: { chunks: 4, embedded: 4, percent: 100 }, filled: 4 });
    own.unload();
    expect(memory.status().meaning).toMatchObject({ state: "unloaded" });
    expect(open(repo, home, { model: null }).status().meaning).toBeNull();
  });
});

/** The leading items of a keyword pack that a tier lifted (a phrase or identifier, a time window, "now"). */
function leadingTiers(pack: ContextPack): PackItem[] {
  const lifted: PackItem[] = [];
  for (const item of pack.items) {
    if (!/exact "|created |newest first/.test(item.why ?? "")) break;
    lifted.push(item);
  }
  return lifted;
}
