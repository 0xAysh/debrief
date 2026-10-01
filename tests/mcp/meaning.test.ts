import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { MODEL } from "../../src/embedding/model.js";
import { type ContextPack, type MeaningStatus, openMemory, type StatusResult } from "../../src/memory.js";
import { textHash } from "../../src/retrieval/vectors.js";
import { initRepo, tempDir } from "../helpers.js";
import { alive, childrenMatching, rssMb } from "../processes.js";
import { claudeConfigDir, claudeTurn, installTranscript } from "../import/fixtures.js";
import { PAYMENTS_SERVICE } from "../memory/meaning-fixture.js";
import { CLI, NO_NETWORK, type ServerHandle, spawnServer } from "./harness.js";

/**
 * Meaning search in the MCP server, as Claude Code runs it (#51): `node dist/debrief.mjs mcp`, the
 * model in its own process, the background fill between calls, real SIGKILLs, and the hooks, which
 * never load the model.
 */

const ROOT = resolve(import.meta.dirname, "../..");

async function meaningServer(cwd: string, home: string, options: Partial<Parameters<typeof spawnServer>[0]> = {}): Promise<ServerHandle> {
  return spawnServer({ cwd, home, host: "claude-code", meaning: true, ...options });
}

async function meaningOf(server: ServerHandle): Promise<MeaningStatus> {
  const status = await server.ok<StatusResult>("memory_status");
  if (status.meaning === null) throw new Error("the server has no model");
  return status.meaning;
}

async function until<T>(what: string, probe: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Whether the model's process runs under `pid` (the server). */
function modelProcess(pid: number): number[] {
  return childrenMatching(pid, "embedder.mjs").map((entry) => entry.pid);
}

function readDb<T>(path: string, read: (db: Database.Database) => T): T {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const vectorsIn = (path: string): number => readDb(path, (db) => (db.prepare("SELECT count(*) AS n FROM chunk_vectors").get() as { n: number }).n);

async function record(server: ServerHandle, bodies: readonly string[]): Promise<void> {
  for (const body of bodies) await server.ok("memory_record", { kind: "note", body, attribution: "agent_inference" });
}

/** A copy of the bundle without the model's files (`node_modules` linked, so better-sqlite3 resolves). */
function bundleWithoutModel(): string {
  const dir = tempDir("debrief-no-model-");
  copyFileSync(CLI, join(dir, "debrief.mjs"));
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "junction");
  return join(dir, "debrief.mjs");
}

describe("meaning search in the MCP server", () => {
  test("M8: a new record is found by keyword at once and by meaning once filled; a recall during the fill does not wait for it", async () => {
    const repo = initRepo();
    const home = tempDir();
    const server = await meaningServer(repo, home);
    await server.ok("memory_bootstrap", { importChoice: "none" });
    await record(server, PAYMENTS_SERVICE.map((r) => r.body));

    // The backlog is filling in the background: a recall answers at once, with what is covered so far.
    const started = performance.now();
    const during = await server.ok<ContextPack>("memory_recall", { query: "ledger reconciliation payouts" });
    const took = performance.now() - started;
    const after = await meaningOf(server);
    expect(during.notice ?? "").toMatch(/meaning search covers \d+% of memory$/);
    expect(after.coverage?.percent).toBeLessThan(100);
    expect(took).toBeLessThan(2_000);

    await until("full coverage", () => meaningOf(server), (m) => m.coverage?.percent === 100);
    const body = "Legacy-plan merchants are billed through Chargify until March.";
    const { recordId } = await server.ok<{ recordId: string }>("memory_record", { kind: "decision", body, attribution: "user_direction" });
    const byWord = await server.ok<ContextPack>("memory_recall", { query: "Chargify" });
    expect(byWord.items[0]).toMatchObject({ recordId, excerpt: body });
    expect(byWord.items[0]?.why).toBeUndefined();
    await until("the new record's vector", () => meaningOf(server), (m) => m.coverage?.embedded === PAYMENTS_SERVICE.length + 1);
    const found = await server.ok<ContextPack>("memory_recall", { query: "subscription invoicing vendor" });
    expect(found.items.slice(0, 3).map((i) => i.recordId)).toContain(recordId);
    expect(found.items.find((i) => i.recordId === recordId)?.why).toBe("meaning");
    await server.close();
  });

  test("M9: a schema-9 database with imported history migrates to 10, fills in the background, and its old records are found by meaning", async () => {
    const repo = initRepo();
    const home = tempDir();
    const config = claudeConfigDir();
    const sessionId = "0d1e2f30-0000-4000-8000-000000000951";
    let after: string | null = null;
    let lines = "";
    PAYMENTS_SERVICE.slice(0, 30).forEach((r, n) => {
      const turn = claudeTurn({ cwd: repo, sessionId, n: n + 1, at: new Date(Date.UTC(2026, 8, 20, 9, n)), prompt: r.body, after });
      lines += turn.lines;
      after = turn.last;
    });
    installTranscript(config, "", { cwd: repo, sessionId, content: lines });
    const env = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", DEBRIEF_HOME: home, CLAUDE_CONFIG_DIR: config };
    for (const args of [["diag", "consent", "--set", "current_project"], ["diag", "import"]]) {
      const run = spawnSync(process.execPath, [CLI, ...args, "--host", "claude-code"], { cwd: repo, env, encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
    }
    const dbPath = join(home, "workspaces", readDirOne(join(home, "workspaces")), "memory.sqlite");
    // Back to schema 9, as the previous Debrief left it: no vectors, no text hashes.
    const db = new Database(dbPath);
    db.exec(`DROP TABLE vector_fill; DROP TABLE chunk_vectors; DROP INDEX chunks_text_hash; ALTER TABLE chunks DROP COLUMN text_hash; PRAGMA user_version = 9;`);
    const records = (db.prepare("SELECT count(*) AS n FROM records").get() as { n: number }).n;
    db.close();
    expect(records).toBe(60);

    const server = await meaningServer(repo, home, { claudeConfigDir: config });
    await server.ok("memory_bootstrap");
    expect(readDb(dbPath, (raw) => raw.pragma("user_version", { simple: true }))).toBe(10);
    const filled = await until("the backfill", () => meaningOf(server), (m) => m.coverage?.percent === 100);
    expect(filled.coverage?.chunks).toBeGreaterThanOrEqual(60);
    const pack = await server.ok<ContextPack>("memory_recall", { query: "monetary precision rounding" });
    const answer = pack.items.slice(0, 5).find((item) => item.excerpt.includes("integer minor units"));
    expect(answer).toMatchObject({ why: "meaning", source: { transcriptId: sessionId } });
    await server.close();
  });

  test("M10: SIGKILL mid-fill loses nothing and repeats nothing; one vector per text, shared by identical chunks", async () => {
    const repo = initRepo();
    const home = tempDir();
    const first = await meaningServer(repo, home);
    await first.ok("memory_bootstrap", { importChoice: "none" });
    const dbPath = (await first.ok<StatusResult>("memory_status")).storage.dbPath ?? "";
    const backlog = [...PAYMENTS_SERVICE.map((r) => r.body), ...Array.from({ length: 60 }, (_, i) => `Payout batch ${i} settled with ${i * 3} transfers and no failures in region ${i % 7}.`)];
    const copies = Array.from({ length: 10 }, () => "The same retry warning was logged again by the payouts worker.");
    await record(first, [...backlog, ...copies]);
    const distinct = backlog.length + 1;

    // Killed once some vectors are stored and others are not.
    const atKill = await until("a partial fill", () => vectorsIn(dbPath), (n) => n >= 16, 60_000);
    const embedderPids = modelProcess(first.pid);
    expect(embedderPids).toHaveLength(1);
    process.kill(first.pid, "SIGKILL");
    await until("the killed server's model process to exit with it", () => embedderPids.filter(alive), (running) => running.length === 0, 10_000);
    const stored = vectorsIn(dbPath);
    expect(atKill).toBeLessThan(distinct);
    expect(stored).toBeLessThan(distinct);

    const second = await meaningServer(repo, home);
    await second.ok("memory_bootstrap");
    const done = await until("the resumed fill", () => meaningOf(second), (m) => m.coverage?.percent === 100);
    // Exactly the texts without a stored vector were embedded: nothing committed was embedded again.
    expect(done.filled).toBe(distinct - stored);
    readDb(dbPath, (db) => {
      const counts = db.prepare("SELECT count(*) AS vectors, count(DISTINCT text_hash) AS texts FROM chunk_vectors WHERE model = ?").get(MODEL.id) as { vectors: number; texts: number };
      expect(counts).toEqual({ vectors: distinct, texts: distinct });
      expect((db.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n).toBe(backlog.length + copies.length);
      expect(db.prepare("SELECT count(*) AS n FROM chunk_vectors WHERE text_hash = ?").get(textHash(copies[0] ?? ""))).toEqual({ n: 1 });
    });
    await second.close();
  });

  test("M12: one server per workspace fills; when it is killed, another takes over", async () => {
    const repo = initRepo();
    const home = tempDir();
    // A backlog written by a process without the model (as hooks and imports write it).
    // Long texts (about 600 bytes each), so the fill takes seconds, not a moment.
    const review = (i: number): string => `Payout review ${i}: ${Array.from({ length: 6 }, (_, k) => PAYMENTS_SERVICE[(i + k * 7) % PAYMENTS_SERVICE.length]?.body).join(" ")}`;
    const backlog = [...PAYMENTS_SERVICE.map((r) => r.body), ...Array.from({ length: 300 }, (_, i) => review(i))];
    const writer = openMemory({ cwd: repo, host: "claude-code", home });
    writer.bootstrap({ importChoice: "none" });
    for (const body of backlog) writer.record({ kind: "note", body, attribution: "agent_inference" });
    const dbPath = writer.status().storage.dbPath ?? "";
    writer.close();
    const servers = [await meaningServer(repo, home), await meaningServer(repo, home), await meaningServer(repo, home)];
    const lease = (): { pid: number } | undefined => readDb(dbPath, (db) => db.prepare("SELECT pid FROM vector_fill WHERE id = 1").get() as { pid: number } | undefined);
    // Every server is called: each one would fill if it could.
    await Promise.all(servers.map((server) => server.ok("memory_bootstrap")));

    const holder = (await until("a filler", lease, (row) => row !== undefined))?.pid;
    const filler = servers.find((s) => s.pid === holder);
    expect(filler).toBeDefined();
    // The filler takes the lease, then starts the model for its first batch.
    await until("the filler's model", () => modelProcess(holder ?? 0), (pids) => pids.length > 0, 30_000);
    for (let sample = 0; sample < 10; sample++) {
      // Only the filler has the model loaded: nobody else recalled with a query, and nobody else fills.
      expect(servers.filter((s) => modelProcess(s.pid).length > 0).map((s) => s.pid)).toEqual([holder]);
      expect(lease()?.pid).toBe(holder);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(vectorsIn(dbPath)).toBeLessThan(backlog.length);
    process.kill(holder ?? 0, "SIGKILL");

    const rest = servers.filter((s) => s.pid !== holder);
    for (const server of rest) await server.ok("memory_status");
    const next = (await until("another filler", lease, (row) => row !== undefined && row.pid !== holder, 30_000))?.pid;
    expect(rest.map((s) => s.pid)).toContain(next);
    const survivor = rest.find((s) => s.pid === next) as ServerHandle;
    // 350 long texts: seconds on a laptop, minutes on a shared 3-core CI runner.
    await until("the fill to finish", () => meaningOf(survivor), (m) => m.coverage?.percent === 100, 240_000);
    expect(rest.filter((s) => modelProcess(s.pid).length > 0).map((s) => s.pid)).toEqual([next]);
    for (const server of rest) await server.close();
  }, 300_000);

  test("M14: hooks never load the model: without its files, every hook prints exactly what it prints with them", () => {
    const repo = initRepo();
    const homes = [tempDir(), tempDir()];
    const config = claudeConfigDir();
    const session = "0d1e2f30-0000-4000-8000-000000000a14";
    const transcript = installTranscript(config, "", {
      cwd: repo,
      sessionId: session,
      content: claudeTurn({ cwd: repo, sessionId: session, n: 1, at: new Date(Date.UTC(2026, 8, 30, 9)), prompt: "Keep amounts as integer minor units." }).lines,
    });
    const stripped = bundleWithoutModel();
    expect(existsSync(join(resolve(stripped, ".."), "embedder.mjs"))).toBe(false);
    const run = (cli: string, home: string, event: string, payload: object): { code: number | null; stdout: string; stderr: string } => {
      const result = spawnSync(process.execPath, [cli, "hook", event, "--host", "claude-code"], {
        cwd: repo,
        input: JSON.stringify({ session_id: session, cwd: repo, transcript_path: transcript.path, ...payload }),
        encoding: "utf8",
        env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", DEBRIEF_HOME: home, CLAUDE_CONFIG_DIR: config },
      });
      return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    const events: [string, object][] = [
      ["session-start", { hook_event_name: "SessionStart", source: "startup" }],
      ["user-prompt-submit", { hook_event_name: "UserPromptSubmit", prompt: "From now on, always use integer minor units for money." }],
      ["pre-tool-use", { hook_event_name: "PreToolUse", tool_name: "mcp__debrief__memory_recall", tool_input: { query: "monetary precision" }, tool_use_id: "toolu_a14" }],
      ["subagent-start", { hook_event_name: "SubagentStart", agent_id: "agent-a14", agent_type: "general-purpose" }],
      ["stop", { hook_event_name: "Stop", stop_hook_active: false }],
    ];
    for (const [event, payload] of events) {
      const [withModel, without] = [run(CLI, homes[0] ?? "", event, payload), run(stripped, homes[1] ?? "", event, payload)];
      expect(without, event).toEqual(withModel);
      expect(without.code, event).toBe(0);
      expect(without.stderr, event).toBe("");
    }
    const failures = (home: string): string => (existsSync(join(home, "hook-failures.jsonl")) ? readFileSync(join(home, "hook-failures.jsonl"), "utf8") : "");
    expect(failures(homes[1] ?? "")).toBe("");
  });

  test("M17: loading the model and filling open no connection, and delete-data leaves no vector behind", async () => {
    const repo = initRepo();
    const home = tempDir();
    const networkLog = join(tempDir(), "network.log");
    const server = await meaningServer(repo, home, { networkLog });
    await server.ok("memory_bootstrap", { importChoice: "none" });
    await record(server, PAYMENTS_SERVICE.slice(0, 20).map((r) => r.body));
    await server.ok<ContextPack>("memory_recall", { query: "socket resets" });
    await until("full coverage", () => meaningOf(server), (m) => m.coverage?.percent === 100);
    expect(modelProcess(server.pid)).toHaveLength(1);
    const dbPath = (await server.ok<StatusResult>("memory_status")).storage.dbPath ?? "";
    expect(vectorsIn(dbPath)).toBe(20);
    await server.close();

    // `debrief status` loads the model too, under the same guard.
    const status = spawnSync(process.execPath, ["--import", NO_NETWORK, CLI, "status"], {
      cwd: repo,
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", DEBRIEF_HOME: home, CLAUDE_CONFIG_DIR: join(home, "no-claude"), DEBRIEF_NETWORK_LOG: networkLog },
    });
    expect(status.stdout).toMatch(/^ {2}meaning search ✔ snowflake-arctic-embed-xs@q8 loads; all of this repository's memory is searchable by meaning$/m);
    expect(existsSync(networkLog) ? readFileSync(networkLog, "utf8") : "").toBe("");

    const deleted = spawnSync(process.execPath, [CLI, "delete-data", "--yes"], { cwd: repo, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", DEBRIEF_HOME: home } });
    expect(deleted.status, deleted.stderr).toBe(0);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(join(home, "workspaces"))).toBe(false);
  });

  test("M19: debrief status reports the model and this repository's coverage, and a model that fails to load is a problem", async () => {
    const repo = initRepo();
    const home = tempDir();
    const server = await meaningServer(repo, home);
    await server.ok("memory_bootstrap", { importChoice: "none" });
    await record(server, PAYMENTS_SERVICE.slice(0, 4).map((r) => r.body));
    await until("full coverage", () => meaningOf(server), (m) => m.coverage?.percent === 100);
    expect(await meaningOf(server)).toEqual({ model: MODEL.id, state: "loaded", problem: null, coverage: { chunks: 4, embedded: 4, percent: 100 }, filled: 4 });
    await server.close();
    const env = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", DEBRIEF_HOME: home, CLAUDE_CONFIG_DIR: join(home, "no-claude") };
    const status = (cli: string): { code: number | null; stdout: string } => {
      const run = spawnSync(process.execPath, [cli, "status"], { cwd: repo, encoding: "utf8", env });
      return { code: run.status, stdout: run.stdout };
    };
    const problems = (stdout: string): number => Number(/^✘ (\d+) problems?$/m.exec(stdout)?.[1] ?? 0);
    const working = status(CLI);
    expect(working.stdout).toMatch(/^ {2}meaning search ✔ snowflake-arctic-embed-xs@q8 loads; all of this repository's memory is searchable by meaning$/m);
    const broken = status(bundleWithoutModel());
    expect(broken.code).toBe(1);
    expect(broken.stdout).toMatch(/^ {2}meaning search ✘ snowflake-arctic-embed-xs@q8 failed to load: .*embedder\.mjs is missing; recall finds memory by its words only$/m);
    expect(problems(broken.stdout)).toBe(problems(working.stdout) + 1);
  });

  test("M20: the model loads only when needed, unloads when idle, gives its memory back, and the next recall loads it again", async () => {
    const repo = initRepo();
    const home = tempDir();
    const server = await meaningServer(repo, home, { embedderIdleMs: 3_000 });
    // Nothing to embed and no recall with a query: the model never loads.
    await server.ok("memory_bootstrap", { importChoice: "none" });
    await server.ok("memory_recall");
    await server.ok("memory_status");
    await new Promise((r) => setTimeout(r, 500));
    expect(modelProcess(server.pid)).toEqual([]);
    expect(await meaningOf(server)).toMatchObject({ state: "unloaded", coverage: { chunks: 0, embedded: 0, percent: 100 } });
    const idle = rssMb(server.pid);

    // Records to embed load it, and the same process answers recalls with a query.
    await record(server, PAYMENTS_SERVICE.slice(0, 16).map((r) => r.body));
    await until("full coverage", () => meaningOf(server), (m) => m.coverage?.percent === 100);
    expect((await server.ok<ContextPack>("memory_recall", { query: "socket resets" })).items[0]?.excerpt).toMatch(/ECONNRESET/);
    const [model] = modelProcess(server.pid);
    expect(model).toBeDefined();
    expect((await meaningOf(server)).state).toBe("loaded");
    const withModel = { server: rssMb(server.pid), model: rssMb(model ?? 0) };

    // Idle: the model's process exits, and the server is back near where it was before the model loaded.
    await until("the idle unload", () => modelProcess(server.pid), (pids) => pids.length === 0, 15_000);
    expect((await meaningOf(server)).state).toBe("unloaded");
    const unloaded = rssMb(server.pid);
    process.stderr.write(`M20 RSS (MB): server before load ${idle.toFixed(0)}, server with model ${withModel.server.toFixed(0)} + model process ${withModel.model.toFixed(0)}, server after unload ${unloaded.toFixed(0)}\n`);
    expect(unloaded - idle).toBeLessThan(50);

    const again = await server.ok<ContextPack>("memory_recall", { query: "socket resets" });
    expect(again.items[0]?.why).toBe("meaning");
    expect(again.items[0]?.excerpt).toMatch(/ECONNRESET/);
    expect(modelProcess(server.pid)).toHaveLength(1);
    await server.close();
  }, 60_000);
});

function readDirOne(dir: string): string {
  const entries = readdirSync(dir);
  if (entries.length !== 1) throw new Error(`expected one entry in ${dir}, found ${entries.length}`);
  return entries[0] ?? "";
}
