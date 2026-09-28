import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory, type PackItem } from "../../src/memory.js";
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
});

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
