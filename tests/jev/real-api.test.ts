import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { git, initRepo, onCleanup, tempDir } from "../helpers.js";
import { JEV, writeJevConsent } from "../../src/judge/jev.js";
import { openMemory } from "../../src/memory.js";

/**
 * Jev itself (api.typesafe.ai, the pinned jev-1.13.0) judging the issue's scenarios. They run only
 * with a key: `TYPESAFE_API_KEY` in the environment, else in the repository's gitignored `.env`
 * (this checkout's, then the main checkout's when this is a linked worktree). Without one they are
 * skipped with the reason on stderr, like the driven host tests. The key is read, passed to
 * Debrief, and never printed.
 *
 * Each scenario costs one call (a few hundred input tokens, about $0.00002). J3 and J4 assert the
 * verdict; J5 is evidence only: it records what Jev answered, for the PR's results table
 * (tests/mcp/__artifacts__/jev/verdicts.json, git-ignored).
 */

function repositoryEnvFiles(): string[] {
  const root = resolve(import.meta.dirname, "../..");
  const files = [join(root, ".env")];
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    files.push(join(dirname(common), ".env"));
  } catch {
    // Not a Git checkout: only this directory's .env.
  }
  return [...new Set(files)];
}

function readKey(): string | null {
  const fromEnv = process.env["TYPESAFE_API_KEY"]?.trim();
  if (fromEnv !== undefined && fromEnv !== "" && fromEnv !== "replace-me") return fromEnv;
  for (const file of repositoryEnvFiles()) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
      const value = match?.[1]?.replace(/^(["'])(.*)\1$/, "$2") ?? "";
      if (value !== "" && value !== "replace-me") return value;
    }
  }
  return null;
}

const KEY = readKey();
const SKIP = KEY === null ? "no TYPESAFE_API_KEY in the environment or the repository's .env" : null;
if (SKIP !== null) process.stderr.write(`real Jev tests skipped: ${SKIP}\n`);

const RETRY = "export function retryDelay(attempt: number): number {\n  return 100 * 2 ** attempt;\n}\n";
const CLAIM = "retryDelay(attempt) returns 100 ms times 2^attempt: the delay doubles on every retry, starting at 100 ms.";

interface Verdict {
  scenario: string;
  freshness: string;
  verdict: string | null;
  probability: number | null;
  warningLifted: boolean;
  ms: number;
  /** As TypeSafe reported them (the ledger `debrief status` reads). */
  inputTokens: number;
  outputTokens: number;
}

/** One scenario: record `claim` about the file, apply `after`, recall, let Debrief ask Jev once, recall again. */
async function judge(scenario: string, after: string, options: { claim?: string; lines?: [number, number] | undefined } = {}): Promise<Verdict> {
  if (KEY === null) throw new Error("unreachable: skipped without a key");
  const repo = initRepo();
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/retry.ts"), RETRY);
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "retry");
  const home = tempDir();
  // Consent as `debrief jev enable` records it (its key check is tested against the stub in J2).
  writeJevConsent(home, { version: 1, enabled: true, endpoint: JEV.endpoint, model: JEV.model, consentedAt: new Date().toISOString(), excluded: [] });
  const memory = openMemory({ cwd: repo, host: "codex", home, jev: { endpoint: JEV.endpoint, apiKey: KEY } });
  onCleanup(() => {
    memory.close();
  });
  memory.bootstrap();
  const lines = "lines" in options ? options.lines : ([1, 3] as [number, number]);
  const { recordId } = memory.record({
    kind: "decision",
    title: "retryDelay backoff",
    body: options.claim ?? CLAIM,
    attribution: "agent_inference",
    externalRefs: [{ kind: "code", locator: "src/retry.ts", ...(lines === undefined ? {} : { lines }) }],
  });
  writeFileSync(join(repo, "src/retry.ts"), after);
  const item = () => memory.recall({ query: "retryDelay" }).items.find((i) => i.recordId === recordId);
  expect(item()?.freshness, scenario).toBe("stale");
  const started = performance.now();
  const step = await memory.judge();
  const ms = Math.round(performance.now() - started);
  expect(step, scenario).toMatchObject({ calls: 1, paused: false });
  const judged = item();
  const usage = memory.status().jev.total;
  expect(usage.calls, scenario).toBe(1);
  return {
    scenario,
    freshness: judged?.freshness ?? "?",
    verdict: judged?.judgment?.verdict ?? null,
    probability: judged?.judgment?.probability ?? null,
    warningLifted: judged?.warning?.includes("Read the current file") === false,
    ms,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

function keep(verdicts: Verdict[]): void {
  const dir = resolve(import.meta.dirname, "../mcp/__artifacts__/jev");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "verdicts.json");
  const previous = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Verdict[]) : [];
  const names = new Set(verdicts.map((v) => v.scenario));
  writeFileSync(file, JSON.stringify([...previous.filter((v) => !names.has(v.scenario)), ...verdicts], null, 2) + "\n");
  for (const v of verdicts) process.stderr.write(`jev verdict · ${v.scenario}: ${v.verdict ?? "none"} (${v.probability ?? "-"}), ${v.ms} ms, ${v.inputTokens} + ${v.outputTokens} tokens\n`);
}

describe.skipIf(SKIP !== null)(`real Jev (${JEV.model} at ${JEV.endpoint})`, () => {
  test("J3: a behaviour-preserving refactor still holds", async () => {
    const refactor = "const BASE_DELAY_MS = 100;\n\nexport function retryDelay(attempt: number): number {\n  const factor = Math.pow(2, attempt);\n  return BASE_DELAY_MS * factor;\n}\n";
    const verdict = await judge("behaviour-preserving refactor", refactor);
    keep([verdict]);
    expect(verdict).toMatchObject({ freshness: "stale", verdict: "still_holds" });
  });

  test("J4: a contradicting behaviour change is invalidated", async () => {
    const tripled = "export function retryDelay(attempt: number): number {\n  return 100 * 3 ** attempt;\n}\n";
    const verdict = await judge("contradicting behaviour change", tripled);
    keep([verdict]);
    expect(verdict).toMatchObject({ freshness: "stale", verdict: "invalidated", warningLifted: false });
  });

  test("J5 (evidence): a rename the memory mentions, and an unrelated edit in the same file", async () => {
    const renamed = "export function backoffDelay(attempt: number): number {\n  return 100 * 2 ** attempt;\n}\n";
    // The memory cites no lines here, so any edit to the file makes it stale (the whole-file rule).
    const unrelated = `${RETRY}\nexport function jitter(ms: number): number {\n  return ms + Math.floor(Math.random() * 10);\n}\n`;
    const verdicts = [await judge("rename the memory mentions", renamed), await judge("unrelated edit in the same file", unrelated, { lines: undefined })];
    keep(verdicts);
    for (const verdict of verdicts) expect(verdict.verdict, verdict.scenario).not.toBeNull();
  });
});
