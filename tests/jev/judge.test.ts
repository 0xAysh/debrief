import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { git, initRepo, tempDir } from "../helpers.js";
import { claudeConfigDir, claudeTurn, installTranscript } from "../import/fixtures.js";
import { type ServerHandle, spawnServer } from "../mcp/harness.js";
import { run } from "./cli.js";
import { type JevStub, startJevStub, type StubReply } from "./stub.js";

/**
 * Jev judgments as Debrief runs them: the built CLI and MCP server as child processes, TypeSafe's
 * API as a localhost stub, every process under the no-network guard. The guard's allowlist is the
 * stub alone (or nothing), so an empty guard log proves nothing else was contacted.
 */

const KEY = "test-key-judge";
const RETRY = "export function retryDelay(attempt: number): number {\n  return 100 * 2 ** attempt;\n}\n";
const RETRY_CHANGED = "export function retryDelay(attempt: number): number {\n  return 100 * 3 ** attempt;\n}\n";
const CLAIM = "retryDelay doubles the delay on every attempt, starting at 100 ms.";

interface Rig {
  repo: string;
  home: string;
  stub: JevStub;
  /** The guard's log for every process this test starts; empty means nothing but the allowlist was contacted. */
  guard: string;
  /** Environment for Debrief processes: key, the stub's endpoint and the guard's allowlist (each optional). */
  env: Record<string, string>;
}

async function rig(options: { key?: boolean; allow?: boolean } = {}): Promise<Rig> {
  const stub = await startJevStub();
  const repo = initRepo();
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/retry.ts"), RETRY);
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "retry");
  const home = tempDir();
  const env: Record<string, string> = {
    DEBRIEF_JEV_ENDPOINT: stub.url,
    ...(options.key === false ? {} : { TYPESAFE_API_KEY: KEY }),
    ...(options.allow === false ? {} : { DEBRIEF_NETWORK_ALLOW: stub.hostPort }),
  };
  return { repo, home, stub, guard: join(tempDir(), "network.log"), env };
}

/** `debrief jev enable --yes` under the guard, allowed to reach the stub (the enable step's one request). */
async function enable(r: Rig): Promise<void> {
  const enabled = await run({ env: { TYPESAFE_API_KEY: KEY, DEBRIEF_JEV_ENDPOINT: r.stub.url, DEBRIEF_NETWORK_ALLOW: r.stub.hostPort }, cwd: r.repo, home: r.home, args: ["jev", "enable", "--yes"], guard: r.guard });
  expect(enabled.code, enabled.stderr).toBe(0);
}

function server(r: Rig, extra: { host?: string; claudeConfigDir?: string } = {}): Promise<ServerHandle> {
  return spawnServer({ cwd: r.repo, home: r.home, host: extra.host ?? "codex", networkLog: r.guard, env: r.env, ...(extra.claudeConfigDir === undefined ? {} : { claudeConfigDir: extra.claudeConfigDir }) });
}

function guardLog(r: Rig): string {
  return existsSync(r.guard) ? readFileSync(r.guard, "utf8") : "";
}

interface Item {
  recordId: string;
  freshness: string;
  warning: string | null;
  judgment?: { verdict: string; probability: number; model: string };
}

async function recallItem(s: ServerHandle, recordId: string): Promise<{ item: Item; notice: string | null; line: string }> {
  const pack = await s.ok<{ items: Item[]; notice: string | null }>("memory_recall", { query: "retryDelay" });
  const compact = await s.ok<{ items: string[] }>("memory_recall", { query: "retryDelay", mode: "compact" });
  const item = pack.items.find((i) => i.recordId === recordId);
  if (item === undefined) throw new Error(`${recordId} was not recalled`);
  return { item, notice: pack.notice, line: compact.items.find((l) => l.startsWith(recordId)) ?? "" };
}

/** Recalls until the item carries a verdict (the stub answers before Debrief has saved it). */
async function recallJudged(s: ServerHandle, recordId: string): Promise<{ item: Item; notice: string | null; line: string }> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const recalled = await recallItem(s, recordId);
    if (recalled.item.judgment !== undefined) return recalled;
    if (Date.now() > deadline) throw new Error(`${recordId} got no verdict`);
    await sleep(50);
  }
}

async function recordClaim(s: ServerHandle, body = CLAIM, path = "src/retry.ts"): Promise<string> {
  const written = await s.ok<{ recordId: string }>("memory_record", { kind: "decision", title: "retryDelay backoff", body, attribution: "agent_inference", externalRefs: [{ kind: "code", locator: path, lines: [1, 3] }] });
  return written.recordId;
}

async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

describe("Jev judges changed memory in the MCP server's background", () => {
  test("J13, J11, J7: with consent a stale memory is judged once per pair of versions, with the pinned model, and only the Jev host is contacted", async () => {
    const r = await rig();
    await enable(r);
    const s = await server(r);
    await s.ok("memory_bootstrap");
    const id = await recordClaim(s);
    writeFileSync(join(r.repo, "src/retry.ts"), RETRY_CHANGED);

    // Recall never waits: the first pack has no verdict, and the re-read warning.
    const first = await recallItem(s, id);
    expect(first.item.freshness).toBe("stale");
    expect(first.item.judgment).toBeUndefined();
    expect(first.item.warning).toMatch(/Read the current file/);
    expect(first.line).toMatch(/· stale\]/);

    await r.stub.waitForJudgments(1);
    const judged = await recallJudged(s, id);
    expect(judged.item.freshness).toBe("stale");
    expect(judged.item.judgment).toEqual({ verdict: "still_holds", probability: 0.95, model: "jev-1.13.0" });
    expect(judged.line).toMatch(/· stale · still holds \(0\.95\)\]/);

    // J11: the request names the pinned model, never the alias, and carries the key.
    const [request] = r.stub.judgments();
    expect((request?.body as { model: string }).model).toBe("jev-1.13.0");
    expect(request?.raw).not.toContain("jev-latest");
    expect(request?.key).toBe(KEY);
    const state = (request?.body as { state: Record<string, unknown> }).state;
    expect(state["memory"]).toContain(CLAIM);
    expect(state["file"]).toBe("src/retry.ts");
    expect(state["diff"]).toContain("-  return 100 * 2 ** attempt;");
    expect(state["diff"]).toContain("+  return 100 * 3 ** attempt;");

    // J7: the same pair of versions is never asked again, by this process or another.
    for (let i = 0; i < 3; i++) await recallItem(s, id);
    await sleep(500);
    expect(r.stub.judgments()).toHaveLength(1);
    await s.close();
    const again = await server(r);
    await again.ok("memory_bootstrap");
    expect((await recallItem(again, id)).item.judgment).toMatchObject({ verdict: "still_holds" });
    await sleep(500);
    expect(r.stub.judgments()).toHaveLength(1);

    // A further edit is a new pair of versions: a new question.
    writeFileSync(join(r.repo, "src/retry.ts"), RETRY_CHANGED.replace("100 * 3", "250 * 3"));
    expect((await recallItem(again, id)).item.judgment).toBeUndefined();
    await r.stub.waitForJudgments(2);
    await recallJudged(again, id);
    expect(r.stub.judgments()).toHaveLength(2);

    // J13: the enable step and the judgments are the only connections, all to the Jev host.
    expect(guardLog(r)).toBe("");
    expect(r.stub.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /v1/models", "POST /v1/systemone", "POST /v1/systemone"]);
  });

  test("J1: without a key, without consent, or in an opted-out repository, TypeSafe is never contacted", async () => {
    // The guard allows nothing: any connection at all would be logged.
    for (const setup of ["no consent", "no key", "opted out"] as const) {
      const r = await rig({ allow: false, key: setup !== "no key" });
      if (setup !== "no consent") await enable(r);
      if (setup === "opted out") expect((await run({ env: r.env, cwd: r.repo, home: r.home, args: ["jev", "disable", "--here"], guard: r.guard })).code).toBe(0);
      const before = r.stub.requests.length;
      const s = await server(r);
      await s.ok("memory_bootstrap");
      const id = await recordClaim(s);
      writeFileSync(join(r.repo, "src/retry.ts"), RETRY_CHANGED);
      const recalled = await recallItem(s, id);
      expect(recalled.item.freshness, setup).toBe("stale");
      expect(recalled.item.judgment, setup).toBeUndefined();
      await sleep(1_000);
      expect((await recallItem(s, id)).item.judgment, setup).toBeUndefined();
      expect(guardLog(r), setup).toBe("");
      expect(r.stub.requests.length, setup).toBe(before);
      await s.close();
    }
  });

  test("J8: a timeout, a 429 or an error: recall still succeeds, with no label and a notice", async () => {
    const failures: [string, StubReply, RegExp][] = [
      ["429", { status: 429, headers: { "retry-after": "120" }, json: { error: "rate limited" } }, /rate limit/],
      ["error", { status: 500, json: { error: "boom" } }, /could not be reached|error/],
      ["timeout", { delayMs: 4_500 }, /did not answer/],
    ];
    for (const [name, reply, notice] of failures) {
      const r = await rig();
      await enable(r);
      r.stub.answer = () => reply;
      const s = await server(r);
      await s.ok("memory_bootstrap");
      const id = await recordClaim(s);
      writeFileSync(join(r.repo, "src/retry.ts"), RETRY_CHANGED);
      await recallItem(s, id);
      await until(() => r.stub.judgments().length === 1, `the ${name} request`);
      // The client gives up after its timeout (3 s); the stub answers later, into a closed request.
      if (name === "timeout") await sleep(3_300);
      else await sleep(200);
      const after = await recallItem(s, id);
      expect(after.item.freshness, name).toBe("stale");
      expect(after.item.judgment, name).toBeUndefined();
      expect(after.item.warning, name).toMatch(/Read the current file/);
      expect(after.notice, name).toMatch(/Jev/);
      expect(after.notice, name).toMatch(notice);
      // Paused, not retried in a loop.
      await sleep(500);
      expect(r.stub.judgments(), name).toHaveLength(1);
      expect(guardLog(r), name).toBe("");
      await s.close();
    }
  });

  test("J9: private sessions, sensitive paths, withheld output and redacted text never appear in a request", async () => {
    const r = await rig();
    await enable(r);
    writeFileSync(join(r.repo, "src/other.ts"), "export const other = 1;\nexport const two = 2;\nexport const three = 3;\n");
    mkdirSync(join(r.repo, "config"));
    writeFileSync(join(r.repo, "config/.env.local"), "A=1\nB=2\nC=3\n");
    writeFileSync(join(r.repo, "src/token.ts"), "export const name = 'x';\nexport const a = 1;\nexport const b = 2;\n");
    git(r.repo, "add", ".");
    git(r.repo, "commit", "--quiet", "-m", "more");

    // A session marked private: what it wrote is forgotten, and never sent.
    const secret = await server(r);
    await secret.ok("memory_bootstrap");
    await recordClaim(secret, "PRIVATE-SESSION-CLAIM retryDelay grows by powers of two.");
    await secret.ok("memory_manage", { action: "private_session" });
    await secret.close();

    // Written in one session, recalled in another: marking the reader private later forgets nothing of these.
    const writer = await server(r);
    await writer.ok("memory_bootstrap");
    const plain = await recordClaim(writer);
    const tagged = await recordClaim(writer, "retryDelay keeps <private>hunter2-PRIVATE-TAG</private> doubling.");
    const credential = await recordClaim(writer, "retryDelay reads AKIAABCDEFGHIJKLMNOP to sign requests.");
    const withheld = await recordClaim(writer, "retryDelay output: [output withheld by Debrief: the call touched a sensitive path]");
    const sensitive = await recordClaim(writer, "SENSITIVE-PATH-CLAIM retryDelay settings live in the env file.", "config/.env.local");
    const secretDiff = await recordClaim(writer, "SECRET-DIFF-CLAIM retryDelay names the token module.", "src/token.ts");
    await writer.close();
    const s = await server(r);
    await s.ok("memory_bootstrap");
    writeFileSync(join(r.repo, "src/retry.ts"), RETRY_CHANGED);
    writeFileSync(join(r.repo, "config/.env.local"), "A=9\nB=9\nC=9\n");
    writeFileSync(join(r.repo, "src/token.ts"), "export const name = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';\nexport const a = 1;\nexport const b = 2;\n");

    for (const id of [plain, tagged, credential, withheld, sensitive, secretDiff]) await recallItem(s, id).catch(() => null);
    await s.ok("memory_recall", { maxTokens: 8_000 });
    await r.stub.waitForJudgments(1);
    await recallJudged(s, plain);
    await sleep(1_000);
    // Only the plain claim was sent.
    const bodies = r.stub.judgments().map((q) => q.raw);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(CLAIM);
    for (const forbidden of ["PRIVATE-SESSION-CLAIM", "hunter2", "PRIVATE-TAG", "[private]", "AKIA", "withheld", "SENSITIVE-PATH-CLAIM", ".env", "SECRET-DIFF-CLAIM", "ghp_", "[redacted"]) {
      for (const body of bodies) expect(body).not.toContain(forbidden);
    }

    // While this session is private, nothing at all is sent: a further edit makes a new pair of versions for the plain claim.
    await s.ok("memory_manage", { action: "private_session" });
    writeFileSync(join(r.repo, "src/retry.ts"), RETRY_CHANGED.replace("100 * 3", "7 * 3"));
    expect((await recallItem(s, plain)).item.judgment).toBeUndefined();
    await sleep(1_000);
    expect(r.stub.judgments()).toHaveLength(1);
    expect(guardLog(r)).toBe("");
  });

  test("J14: references with no old text (observed dirty, or imported from a transcript) get no verdict and no call", async () => {
    const r = await rig();
    await enable(r);
    // Dirty when observed: the commit does not hold what Debrief saw, so there is no diff to send.
    writeFileSync(join(r.repo, "src/retry.ts"), RETRY.replace("100", "150"));
    const config = claudeConfigDir();
    const sessionId = "5e550000-0000-4000-8000-000000000a14";
    installTranscript(config, "", { cwd: r.repo, sessionId, content: claudeTurn({ cwd: r.repo, sessionId, n: 1, at: new Date("2026-09-28T10:00:00Z"), prompt: "tune retryDelay", edit: join(r.repo, "src/retry.ts") }).lines });
    const s = await server(r, { host: "claude-code", claudeConfigDir: config });
    await s.ok("memory_bootstrap", { importChoice: "current_project" });
    const dirty = await recordClaim(s);
    writeFileSync(join(r.repo, "src/retry.ts"), RETRY_CHANGED);

    const pack = await s.ok<{ items: Item[] }>("memory_recall", { maxTokens: 8_000 });
    const dirtyItem = pack.items.find((i) => i.recordId === dirty);
    expect(dirtyItem?.freshness).toBe("stale");
    const importedWithRefs = pack.items.filter((i) => i.recordId !== dirty && JSON.stringify(i).includes("src/retry.ts"));
    expect(importedWithRefs.length).toBeGreaterThan(0);
    await sleep(1_000);
    const again = await s.ok<{ items: Item[] }>("memory_recall", { maxTokens: 8_000 });
    expect(again.items.filter((i) => i.judgment !== undefined)).toEqual([]);
    expect(r.stub.judgments()).toEqual([]);
    expect(guardLog(r)).toBe("");
  });

  test("J10: hooks never call Jev, even with a key and consent; they show a verdict already cached", async () => {
    const r = await rig();
    await enable(r);
    writeFileSync(join(r.repo, "src/base.ts"), "export const BASE = 100;\nexport const CAP = 5;\n");
    git(r.repo, "add", ".");
    git(r.repo, "commit", "--quiet", "-m", "base");
    const s = await server(r, { host: "claude-code" });
    await s.ok("memory_bootstrap", { importChoice: "none" });
    const judged = await recordClaim(s);
    // Stale too, but no query the server answers matches it: only the hooks' packs include it.
    await s.ok("memory_record", { kind: "note", title: "backoff base", body: "The backoff base constant is 100 ms.", attribution: "agent_inference", externalRefs: [{ kind: "code", locator: "src/base.ts", lines: [1, 1] }] });
    writeFileSync(join(r.repo, "src/retry.ts"), RETRY_CHANGED);
    writeFileSync(join(r.repo, "src/base.ts"), "export const BASE = 250;\nexport const CAP = 5;\n");
    await recallItem(s, judged);
    await r.stub.waitForJudgments(1);
    await recallJudged(s, judged);
    await s.close();

    const sessionId = "5e550000-0000-4000-8000-000000000a10";
    const payload = (event: string, extra: object = {}) => JSON.stringify({ session_id: sessionId, transcript_path: join(r.home, "no-claude-config", "projects", "x", `${sessionId}.jsonl`), cwd: r.repo, hook_event_name: event, ...extra });
    const hooks: [string, string][] = [
      ["session-start", payload("SessionStart", { source: "startup" })],
      ["subagent-start", payload("SubagentStart", { agent_id: "a1", agent_type: "general-purpose" })],
      ["user-prompt-submit", payload("UserPromptSubmit", { prompt: "from now on, always explain retryDelay" })],
      ["pre-tool-use", payload("PreToolUse", { tool_name: "mcp__debrief__memory_recall", tool_input: { query: "retryDelay" }, tool_use_id: "toolu_j10" })],
      ["stop", payload("Stop", { stop_hook_active: false })],
    ];
    let context = "";
    for (const [event, stdin] of hooks) {
      const ran = await run({ env: r.env, cwd: r.repo, home: r.home, args: ["hook", event, "--host", "claude-code"], stdin, guard: r.guard });
      expect(ran.code, `${event}: ${ran.stderr}`).toBe(0);
      if (event === "session-start") context = ran.stdout;
    }
    await sleep(1_000);
    expect(context).toMatch(/\[note · now · claude-code · stale\] backoff base/);
    expect(context).toMatch(/stale · still holds \(0\.95\)/);
    expect(r.stub.judgments()).toHaveLength(1);
    expect(guardLog(r)).toBe("");
  });
});
