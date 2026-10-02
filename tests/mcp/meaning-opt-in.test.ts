import { spawnSync } from "node:child_process";
import { copyFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { MODEL } from "../../src/embedding/model.js";
import { type ContextPack, openMemory, type StatusResult } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { PAYMENTS_SERVICE } from "../memory/meaning-fixture.js";
import { childrenMatching } from "../processes.js";
import { CLI, type ServerHandle, spawnServer } from "./harness.js";

/**
 * Meaning search is opt-in (ADR 0001, decided on 2026-10-01): `DEBRIEF_MEANING_SEARCH=on` turns it
 * on; unset, or any other value, leaves it off, and then nothing of it runs.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const OFF = "meaning search: off (DEBRIEF_MEANING_SEARCH=on to enable)";
/** Three questions only meaning search answers on this fixture (M1), and one keywords answer too. */
const QUERIES = ["socket resets", "monetary precision rounding", "throughput ceiling", "gateway timeout retries"];

function modelProcess(pid: number): number[] {
  return childrenMatching(pid, "embedder.mjs").map((child) => child.pid);
}

function vectorsIn(path: string): number {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare("SELECT count(*) AS n FROM chunk_vectors").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** A copy of the bundle without the model's files (`node_modules` linked, so better-sqlite3 resolves). */
function bundleWithoutModel(): string {
  const dir = tempDir("debrief-no-model-");
  copyFileSync(CLI, join(dir, "debrief.mjs"));
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  return join(dir, "debrief.mjs");
}

/** `debrief status` in `repo`, with `DEBRIEF_MEANING_SEARCH` set to `setting` (or unset). */
function status(cli: string, repo: string, home: string, setting?: string): { code: number | null; stdout: string; problems: number } {
  const env = {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
    DEBRIEF_HOME: home,
    CLAUDE_CONFIG_DIR: join(home, "no-claude"),
    ...(setting === undefined ? {} : { DEBRIEF_MEANING_SEARCH: setting }),
  };
  const run = spawnSync(process.execPath, [cli, "status"], { cwd: repo, encoding: "utf8", env });
  return { code: run.status, stdout: run.stdout, problems: Number(/^✘ (\d+) problems?$/m.exec(run.stdout)?.[1] ?? 0) };
}

/** A pack as JSON, with the one thing two sessions of a workspace never share: the session id. */
const same = (pack: ContextPack): string => JSON.stringify({ ...pack, scope: { ...pack.scope, sessionId: "x" } });

async function seeded(server: ServerHandle): Promise<void> {
  await server.ok("memory_bootstrap", { importChoice: "none" });
  for (const record of PAYMENTS_SERVICE) await server.ok("memory_record", { kind: record.kind, body: record.body, attribution: "agent_inference" });
}

describe("meaning search is opt-in", () => {
  test("O1: unset, debrief mcp never starts the model, never writes a vector, and recalls exactly what keyword search recalls", async () => {
    const repo = initRepo();
    const home = tempDir();
    // Every call schedules the background fill, had there been one: records to embed, recalls with a query.
    const writer = await spawnServer({ cwd: repo, home, host: "claude-code" });
    await seeded(writer);
    const dbPath = (await writer.ok<StatusResult>("memory_status")).storage.dbPath ?? "";
    await writer.close();
    // A second session, so its scope resolves as the keyword-only session's below does.
    const server = await spawnServer({ cwd: repo, home, host: "claude-code" });
    const packs = [];
    for (const query of QUERIES) packs.push(await server.ok<ContextPack>("memory_recall", { query, maxTokens: 8_000 }));
    // Time for the fill to start (25 ms after a call) and the model to load.
    await new Promise((r) => setTimeout(r, 2_000));
    await server.ok("memory_status");
    expect(modelProcess(server.pid)).toEqual([]);
    expect(vectorsIn(dbPath)).toBe(0);
    await server.close();

    const keywords = openMemory({ cwd: repo, host: "claude-code", home });
    onCleanup(() => {
      keywords.close();
    });
    for (const [i, query] of QUERIES.entries()) expect(same(packs[i] as ContextPack), query).toBe(same(keywords.recall({ query, maxTokens: 8_000 })));
    // Not vacuous: meaning search answers the first three (M1), whose words match nothing here.
    expect(packs.map((pack) => pack.items.length > 0)).toEqual([false, false, false, true]);
  }, 60_000);

  test("O2: DEBRIEF_MEANING_SEARCH=on searches by meaning", async () => {
    const repo = initRepo();
    const home = tempDir();
    const server = await spawnServer({ cwd: repo, home, host: "claude-code", meaning: true });
    await server.ok("memory_bootstrap", { importChoice: "none" });
    for (const record of PAYMENTS_SERVICE.slice(0, 16)) await server.ok("memory_record", { kind: record.kind, body: record.body, attribution: "agent_inference" });
    for (const deadline = Date.now() + 60_000; ; ) {
      const { meaning } = await server.ok<StatusResult>("memory_status");
      if (meaning?.coverage?.percent === 100) break;
      expect(Date.now()).toBeLessThan(deadline);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(modelProcess(server.pid)).toHaveLength(1);
    const pack = await server.ok<ContextPack>("memory_recall", { query: "socket resets" });
    expect(pack.items[0]).toMatchObject({ why: "meaning only", excerpt: expect.stringMatching(/^ECONNRESET/) as unknown });
    await server.close();
  }, 60_000);

  test("O3: off, memory_status and debrief status say so and how to turn it on, and status has no problem with the model's files gone", async () => {
    const repo = initRepo();
    const home = tempDir();
    const server = await spawnServer({ cwd: repo, home, host: "claude-code" });
    await server.ok("memory_bootstrap", { importChoice: "none" });
    const { meaning } = await server.ok<StatusResult>("memory_status");
    expect(meaning).toEqual({ model: MODEL.id, state: "off", problem: null, coverage: null, filled: 0, notice: OFF });
    await server.close();

    const withModel = status(CLI, repo, home);
    const withoutModel = status(bundleWithoutModel(), repo, home);
    for (const run of [withModel, withoutModel]) expect(run.stdout).toMatch(/^ {2}meaning search · off \(DEBRIEF_MEANING_SEARCH=on to enable\)$/m);
    // The only problem here is the plugin, not installed in this sandbox: the model adds none.
    expect(withModel.stdout).toMatch(/^ {2}plugin {9}✘ not installed/m);
    expect([withModel.problems, withoutModel.problems]).toEqual([1, 1]);
    expect(withoutModel.code).toBe(withModel.code);

    // On, the same missing files are a problem (M19).
    const on = status(bundleWithoutModel(), repo, home, "on");
    expect(on.stdout).toMatch(/^ {2}meaning search ✘ snowflake-arctic-embed-xs@q8 failed to load: .*embedder\.mjs is missing; recall finds memory by its words only$/m);
    expect(on.problems).toBe(2);
    expect(on.code).toBe(1);
  }, 60_000);

  test("O4: any value but on leaves it off, and status names the value it did not recognise", async () => {
    const repo = initRepo();
    const home = tempDir();
    const server = await spawnServer({ cwd: repo, home, host: "claude-code", meaning: "true" });
    await seeded(server);
    await server.ok<ContextPack>("memory_recall", { query: "socket resets" });
    const { meaning, storage } = await server.ok<StatusResult>("memory_status");
    expect(meaning).toMatchObject({ state: "off", notice: 'meaning search: off (DEBRIEF_MEANING_SEARCH="true" is not recognised; DEBRIEF_MEANING_SEARCH=on to enable)' });
    await new Promise((r) => setTimeout(r, 1_000));
    expect(modelProcess(server.pid)).toEqual([]);
    expect(vectorsIn(storage.dbPath ?? "")).toBe(0);
    await server.close();

    for (const value of ["1", "ON", "yes", " on"]) {
      const run = status(CLI, repo, home, value);
      expect(run.stdout, value).toContain(`  meaning search · off (DEBRIEF_MEANING_SEARCH=${JSON.stringify(value)} is not recognised; DEBRIEF_MEANING_SEARCH=on to enable)\n`);
      expect(run.problems, value).toBe(1);
    }
    // Off and empty are what they say: off, with nothing unrecognised.
    for (const value of ["off", ""]) expect(status(CLI, repo, home, value).stdout, value).toMatch(/^ {2}meaning search · off \(DEBRIEF_MEANING_SEARCH=on to enable\)$/m);
  }, 60_000);
});
