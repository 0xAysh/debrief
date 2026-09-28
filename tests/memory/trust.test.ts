import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory, type PackItem } from "../../src/memory.js";
import { FRESHNESS_LIMITS } from "../../src/retrieval/freshness.js";
import { git, initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, installTranscript } from "../import/fixtures.js";

function open(cwd: string, home = tempDir()): Memory {
  const memory = openMemory({ cwd, host: "claude-code", home });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

function writeFile(repo: string, path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

/** A repository with each of `paths` committed (one line of code apiece). */
function repoWith(...paths: string[]): string {
  const repo = initRepo();
  for (const path of paths) writeFile(repo, path, `export const ${path.replace(/\W/g, "_")} = 1;\n`);
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "code");
  return repo;
}

/** A note citing `path`, as an agent would record what it saw in it. */
const cites = (memory: Memory, body: string, path: string): string =>
  memory.record({ kind: "evidence", body, attribution: "direct_observation", externalRefs: [{ kind: "code", locator: path, path }] }).recordId;

const recall = (memory: Memory, query: string): PackItem[] => memory.recall({ query, maxTokens: 8_000 }).items;
const ranked = (memory: Memory, query: string): string[] => recall(memory, query).map((item) => item.recordId);

/**
 * Bodies of the same length that match "queue worker drains" alike, so bm25 ties and, before
 * trust, the newest record leads.
 */
const EQUAL = ["queue worker drains the alpha shard", "queue worker drains the bravo shard", "queue worker drains the delta shard", "queue worker drains the gamma shard"];

describe("recall ranking: trust among equally relevant records", () => {
  test("T1: a record whose cited file changed ranks below an equally relevant current one", () => {
    const repo = repoWith("src/alpha.ts", "src/bravo.ts");
    const memory = open(repo);
    const current = cites(memory, EQUAL[0] ?? "", "src/alpha.ts");
    const stale = cites(memory, EQUAL[1] ?? "", "src/bravo.ts");
    writeFile(repo, "src/bravo.ts", "export const bravo = 2;\n");

    const items = recall(memory, "queue worker drains");
    expect(items.map((item) => item.recordId)).toEqual([current, stale]);
    expect(items.map((item) => item.freshness)).toEqual(["current", "stale"]);
  });

  test("T2: current above unknown (no reference) above stale", () => {
    const repo = repoWith("src/alpha.ts", "src/bravo.ts");
    const memory = open(repo);
    const current = cites(memory, EQUAL[0] ?? "", "src/alpha.ts");
    const unknown = memory.record({ kind: "evidence", body: EQUAL[1] ?? "", attribution: "direct_observation" }).recordId;
    const stale = cites(memory, EQUAL[2] ?? "", "src/bravo.ts");
    writeFile(repo, "src/bravo.ts", "export const bravo = 2;\n");

    const items = recall(memory, "queue worker drains");
    expect(items.map((item) => item.recordId)).toEqual([current, unknown, stale]);
    expect(items.map((item) => item.freshness)).toEqual(["current", "unknown", "stale"]);
  });

  test("T3: a captured test run ranks above an asserted one against the same state", () => {
    const { memory, run } = withCapturedOutput();
    const captured = run(EQUAL[0] ?? "", "captured");
    const asserted = run(EQUAL[1] ?? "", "asserted");

    const items = recall(memory, "queue worker drains");
    expect(items.map((item) => item.recordId)).toEqual([captured, asserted]);
    expect(items.map((item) => [item.testRun?.evidence, item.testRun?.applies])).toEqual([
      ["captured", "current"],
      ["asserted", "current"],
    ]);
  });

  test("T4: of two runs against another state (both stale), the captured one ranks first", () => {
    const { repo, memory, run } = withCapturedOutput();
    const captured = run(EQUAL[0] ?? "", "captured");
    const asserted = run(EQUAL[1] ?? "", "asserted");
    writeFile(repo, "src/gateway.ts", "export const retries = 1;\n");

    const items = recall(memory, "queue worker drains");
    expect(items.map((item) => item.recordId)).toEqual([captured, asserted]);
    expect(items.map((item) => [item.freshness, item.testRun?.evidence, item.testRun?.reason])).toEqual([
      ["stale", "captured", "other_state"],
      ["stale", "asserted", "other_state"],
    ]);
  });

  test("T5: observed and user-given records rank above the agent's inference", () => {
    const memory = open(initRepo());
    const said = (body: string, attribution: "direct_observation" | "user_direction" | "agent_inference"): string =>
      memory.record({ kind: "note", body, attribution }).recordId;
    const observed = said(EQUAL[0] ?? "", "direct_observation");
    const user = said(EQUAL[1] ?? "", "user_direction");
    const inferred = said(EQUAL[2] ?? "", "agent_inference");

    // Observed and user-given rank alike, so bm25's tie-break (newest first) orders them.
    expect(ranked(memory, "queue worker drains")).toEqual([user, observed, inferred]);
  });

  test("T6: a claim from two independent roots ranks above a single-root claim; a derived_from copy does not lift it", () => {
    const memory = open(initRepo());
    const note = (body: string, links: { to: string; relation: "derived_from" }[] = []): string =>
      memory.record({ kind: "note", body, attribution: "agent_inference", links }).recordId;
    const first = note(EQUAL[0] ?? "");
    const second = note(EQUAL[0] ?? "");
    const original = note(EQUAL[1] ?? "");
    note(EQUAL[1] ?? "", [{ to: original, relation: "derived_from" }]);
    const single = note(EQUAL[2] ?? "");

    // Newest first on bm25's tie-break would be: single, the copy (folded into original), original, second, first.
    const items = recall(memory, "queue worker drains");
    expect(items.map((item) => item.recordId)).toEqual([second, first, single, original]);
    expect(items.map((item) => item.corroboration)).toEqual([
      { independentRoots: 2, records: 2 },
      { independentRoots: 2, records: 2 },
      { independentRoots: 1, records: 1 },
      { independentRoots: 1, records: 2 },
    ]);
  });

  test("T7: relevance leads: a clearly better stale match stays above a weak current one, and a stale only answer comes back labelled", () => {
    const repo = repoWith("src/alpha.ts", "src/bravo.ts");
    const memory = open(repo);
    const better = cites(memory, "the queue worker drains each shard, and the worker drains it again on retry", "src/bravo.ts");
    const weak = cites(memory, "the queue is long on mondays, and nobody minds it much", "src/alpha.ts");
    writeFile(repo, "src/bravo.ts", "export const bravo = 2;\n");

    const items = recall(memory, "queue worker drains");
    expect(items.map((item) => [item.recordId, item.freshness])).toEqual([
      [better, "stale"],
      [weak, "current"],
    ]);

    const [only] = recall(memory, "worker drains retry");
    expect(recall(memory, "worker drains retry")).toHaveLength(1);
    expect(only).toMatchObject({ recordId: better, freshness: "stale" });
    expect(only?.warning).toMatch(/read the current file/i);
  });

  test("T8: page 1 freezes the trust order: a file restored between pages changes the labels, not the order or the why", () => {
    const repo = repoWith("src/alpha.ts", "src/bravo.ts");
    const memory = open(repo);
    const best = memory.record({ kind: "note", body: "queue worker drains, queue worker drains", attribution: "direct_observation" }).recordId;
    const current = cites(memory, EQUAL[0] ?? "", "src/alpha.ts");
    const stale = cites(memory, EQUAL[1] ?? "", "src/bravo.ts");
    const original = "export const src_bravo_ts = 1;\n";
    writeFile(repo, "src/bravo.ts", "export const bravo = 2;\n");

    const first = memory.recall({ query: "queue worker drains", maxBytes: PAGE_OF_ONE });
    expect(first.items.map((item) => item.recordId)).toEqual([best]);
    writeFile(repo, "src/bravo.ts", original);
    const second = memory.recall({ continuation: first.continuation ?? "", maxTokens: 8_000 });

    expect(second.items.map((item) => item.recordId)).toEqual([current, stale]);
    expect(second.items.map((item) => item.freshness)).toEqual(["current", "current"]);
    expect(second.items.map((item) => item.why)).toEqual(["trusted: current", undefined]);
    // Ranked afresh, both are current and bm25's tie-break puts the newer first, with no trust reason.
    expect(recall(memory, "queue worker drains").map((item) => [item.recordId, item.why])).toEqual([
      [best, undefined],
      [stale, undefined],
      [current, undefined],
    ]);
  });

  test("T9: why says what trust decided: trusted: current, captured", () => {
    const { memory, run } = withCapturedOutput();
    const captured = run(EQUAL[0] ?? "", "captured");
    const noRun = cites(memory, EQUAL[1] ?? "", "src/gateway.ts");
    const asserted = run(EQUAL[2] ?? "", "asserted");

    const items = recall(memory, "queue worker drains");
    expect(items.map((item) => item.recordId)).toEqual([captured, noRun, asserted]);
    // Captured beat the record without a run on evidence, and the asserted run on freshness.
    expect(items.map((item) => item.why)).toEqual(["trusted: current, captured", "trusted: current", undefined]);
  });

  test("T10: the query's tiers come first: a phrase match beats a more trusted non-match, and a question about now stays newest first", () => {
    const repo = repoWith("src/alpha.ts", "src/bravo.ts");
    const memory = open(repo);
    // The same words, so bm25 ties; only the first has the phrase verbatim, and only its file changes.
    const phrase = cites(memory, "queue worker drains the alpha shard", "src/bravo.ts");
    const trusted = cites(memory, "the alpha queue worker drains shard", "src/alpha.ts");
    writeFile(repo, "src/bravo.ts", "export const bravo = 2;\n");
    expect(recall(memory, '"drains the alpha"').map((item) => [item.recordId, item.freshness, item.why])).toEqual([
      [phrase, "stale", 'exact "drains the alpha"'],
      [trusted, "current", undefined],
    ]);

    const other = repoWith("src/alpha.ts", "src/bravo.ts");
    const now = open(other);
    const older = cites(now, EQUAL[2] ?? "", "src/alpha.ts");
    const newer = cites(now, EQUAL[3] ?? "", "src/bravo.ts");
    writeFile(other, "src/bravo.ts", "export const bravo = 2;\n");
    expect(recall(now, "which shard does the queue worker drain now").map((item) => [item.recordId, item.freshness, item.why])).toEqual([
      [newer, "stale", "newest first: asks about now"],
      [older, "current", "newest first: asks about now"],
    ]);
  });

  test("T11: recall without a query (the recent list, bootstrap) is never reordered by trust", () => {
    const repo = repoWith("src/alpha.ts", "src/bravo.ts");
    const memory = open(repo);
    const older = cites(memory, EQUAL[0] ?? "", "src/alpha.ts");
    const newer = cites(memory, EQUAL[1] ?? "", "src/bravo.ts");
    writeFile(repo, "src/bravo.ts", "export const bravo = 2;\n");

    const recent = memory.recall({ maxTokens: 8_000 }).items;
    expect(recent.map((item) => [item.recordId, item.freshness, item.why])).toEqual([
      [newer, "stale", undefined],
      [older, "current", undefined],
    ]);
    expect(memory.bootstrap().context.items.map((item) => item.recordId)).toEqual([newer, older]);
  });

  test("T12: with more equally relevant records than one freshness check covers, recall completes and the unchecked sit between current and stale", () => {
    const repo = repoWith("src/alpha.ts", "src/bravo.ts", "src/delta.ts");
    const memory = open(repo);
    const shard = (i: number): string => `queue worker drains shard s${i}`;
    // Oldest, so last in bm25's tie order: past the check's budget. Their file never changes.
    const unchecked = Array.from({ length: 6 }, (_, i) => cites(memory, shard(i), "src/delta.ts"));
    const current: string[] = [];
    const stale: string[] = [];
    for (let i = 0; i < FRESHNESS_LIMITS.refsPerCheck; i++) {
      if (i % 2 === 0) current.push(cites(memory, shard(100 + i), "src/alpha.ts"));
      else stale.push(cites(memory, shard(100 + i), "src/bravo.ts"));
    }
    writeFile(repo, "src/bravo.ts", "export const bravo = 2;\n");

    const items: PackItem[] = [];
    let page = memory.recall({ query: "queue worker drains", maxTokens: 8_000 });
    items.push(...page.items);
    while (page.continuation !== null) {
      page = memory.recall({ continuation: page.continuation, maxTokens: 8_000 });
      items.push(...page.items);
    }
    const newestFirst = (ids: string[]): string[] => [...ids].reverse();
    expect(items.map((item) => item.recordId)).toEqual([...newestFirst(current), ...newestFirst(unchecked), ...newestFirst(stale)]);
    // Ranked as unknown (never demoted to stale), labelled by a check of their own.
    const labelled = items.filter((item) => unchecked.includes(item.recordId));
    expect(labelled.map((item) => [item.freshness, item.why])).toEqual(unchecked.map(() => ["current", "trusted: not stale"]));
  });
});

/** A budget whose page holds the envelope, a continuation and one short item. */
const PAGE_OF_ONE = 2_000;

/**
 * A repository whose Claude Code transcript (the `basic.jsonl` fixture) is imported, so a record can
 * cite the test output Debrief captured: `run` records a test run that cites it (`captured`) or not
 * (`asserted`), as `applicability.test.ts` establishes.
 */
function withCapturedOutput(): { repo: string; memory: Memory; run: (body: string, evidence: "captured" | "asserted") => string } {
  const repo = initRepo({ branch: "fix/double-charge" });
  writeFile(repo, "src/gateway.ts", "export const retries = 3;\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "gateway");
  const config = claudeConfigDir();
  installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
  const memory = openMemory({ cwd: repo, host: "claude-code", home: tempDir(), claudeConfigDir: config });
  onCleanup(() => {
    memory.close();
  });
  memory.bootstrap({ importChoice: "current_project" });
  const output = memory.recall({ query: "retries 504 idempotency key charged twice" }).items.find((i) => i.attribution === "direct_observation" && i.source !== null);
  if (output === undefined) throw new Error("the fixture's test output was not imported");
  const run = (body: string, evidence: "captured" | "asserted"): string =>
    memory.record({
      kind: "evidence",
      body,
      attribution: "direct_observation",
      ...(evidence === "captured" ? { supportedBy: [output.recordId] } : {}),
      testRun: { command: "npm test -- gateway", outcome: "failed", exitCode: 1 },
    }).recordId;
  return { repo, memory, run };
}
