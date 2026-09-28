import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory, type PackItem } from "../../src/memory.js";
import { git, initRepo, onCleanup, tempDir } from "../helpers.js";

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
});
