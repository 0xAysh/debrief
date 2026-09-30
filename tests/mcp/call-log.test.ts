import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { type ContextPack, type Memory, openMemory, type ReadResult } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, installTranscript } from "../import/fixtures.js";
import { CLI, type ServerHandle, spawnServer, type ToolOutcome } from "./harness.js";

/**
 * The call log (#69): one row per memory tool call and per hook run but PreToolUse, driven through
 * the real MCP server and hook processes (C1–C7) and the memory module (C8).
 */

interface Env {
  repo: string;
  home: string;
  config: string;
}

interface Row {
  id: number;
  at: string;
  host: string;
  session_id: string | null;
  host_session_id: string | null;
  tool_use_id: string | null;
  source: "tool" | "hook";
  name: string;
  outcome: string;
  query: string | null;
  params: Record<string, unknown>;
  returned: { id: string; kind: string | null; freshness: string | null; position: number }[];
  bytes: number;
  tokens: number;
  omitted: Record<string, number>;
  empty: number | null;
  continued: number;
  continues: number;
  ms: number;
  stages: Record<string, number>;
  erased: string | null;
}

const SESSION = "5e550000-0000-4000-8000-0000000000a1";
const OTHER_SESSION = "5e550000-0000-4000-8000-0000000000a2";

function open(e: Env, hostSessionId?: string): Memory {
  const memory = openMemory({ cwd: e.repo, home: e.home, host: "claude-code", claudeConfigDir: e.config, ...(hostSessionId === undefined ? {} : { hostSessionId }) });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

/** A repository whose workspace exists, with transcript import declined. */
function env(): Env {
  const e = { repo: initRepo({ branch: "main" }), home: tempDir(), config: claudeConfigDir() };
  const memory = open(e);
  memory.bootstrap({ importChoice: "none" });
  memory.close();
  return e;
}

function dbPath(e: Env): string {
  const memory = open(e);
  const path = memory.status().storage.dbPath ?? "";
  memory.close();
  return path;
}

function rows(e: Env): Row[] {
  const db = new Database(dbPath(e), { readonly: true });
  try {
    return (db.prepare("SELECT * FROM call_log ORDER BY id").all() as Record<string, string>[]).map(
      (row) =>
        ({
          ...row,
          params: JSON.parse(row["params"] ?? "{}") as unknown,
          returned: JSON.parse(row["returned"] ?? "[]") as unknown,
          omitted: JSON.parse(row["omitted"] ?? "{}") as unknown,
          stages: JSON.parse(row["stages"] ?? "{}") as unknown,
        }) as unknown as Row,
    );
  } finally {
    db.close();
  }
}

/** Notes written by another session, `count` of them, long enough that small budgets page. */
function seed(e: Env, count: number, words = "widget"): string[] {
  const memory = open(e);
  const ids = Array.from({ length: count }, (_, i) => memory.record({ kind: "note", body: `${words} fact ${i}: ${"the gateway retries a 504 ".repeat(8)}`, attribution: "agent_inference" }).recordId);
  memory.close();
  return ids;
}

async function server(e: Env, options: Partial<Parameters<typeof spawnServer>[0]> = {}): Promise<ServerHandle> {
  return spawnServer({ cwd: e.repo, home: e.home, host: "claude-code", claudeConfigDir: e.config, ...options });
}

/** Runs `debrief hook <event> --host claude-code` with a payload on stdin, as Claude Code would. */
function hook(e: Env, event: string, payload: object): { code: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [CLI, "hook", event, "--host", "claude-code"], {
    cwd: e.repo,
    input: JSON.stringify({ session_id: SESSION, cwd: e.repo, ...payload }),
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, DEBRIEF_HOME: e.home, CLAUDE_CONFIG_DIR: e.config },
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** A tool call as Claude Code makes it: its PreToolUse hook notes the session, then the call carries the tool-use id. */
async function hostCall(handle: ServerHandle, e: Env, n: number, tool: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const toolUseId = `toolu_call${n}`;
  hook(e, "pre-tool-use", { hook_event_name: "PreToolUse", tool_name: `mcp__debrief__${tool}`, tool_input: args, tool_use_id: toolUseId });
  return handle.call(tool, args, { "claudecode/toolUseId": toolUseId });
}

const idOf = (line: string): string => line.split(" ")[0] ?? "";
const contextOf = (stdout: string): string => (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;

describe("the call log: one row per call", () => {
  test("C1: every memory tool call writes one row naming the tool, the host session and the host's tool-use id; a failed call too, with its code", async () => {
    const e = env();
    const handle = await server(e);
    let n = 0;
    const call = (tool: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> => hostCall(handle, e, ++n, tool, args);

    await call("memory_bootstrap");
    const recordId = (await call("memory_record", { kind: "note", body: "The retry loop lives in gateway.ts.", attribution: "agent_inference" })).structured["recordId"] as string;
    await call("memory_recall", { query: "retry loop" });
    await call("memory_read", { recordId });
    await call("memory_checkpoint", { expectedRevision: 0, goal: "Fix the retries", status: "Found the loop" });
    await call("memory_manage", { action: "inspect", recordId });
    await call("memory_status");
    expect((await call("memory_read", { recordId: `rec_${"0".repeat(32)}` })).isError).toBe(true);

    const logged = rows(e);
    const tools = ["memory_bootstrap", "memory_record", "memory_recall", "memory_read", "memory_checkpoint", "memory_manage", "memory_status", "memory_read"];
    expect(logged.map((row) => [row.source, row.name, row.outcome, row.tool_use_id, row.host_session_id])).toEqual(
      tools.map((tool, i) => ["tool", tool, i === tools.length - 1 ? "not_found" : "ok", `toolu_call${i + 1}`, SESSION]),
    );
    expect(new Set(logged.map((row) => row.session_id))).toEqual(new Set([expect.stringMatching(/^ses_[0-9a-f]{32}$/) as unknown]));
  });

  test("C2: a recall's row holds the query, the ids returned in order with kind, freshness and position, the bytes the host got, omissions and continuations", async () => {
    const e = env();
    seed(e, 12);
    const handle = await server(e);
    const first = await handle.call("memory_recall", { query: "widget", maxBytes: 3_000 });
    const next = await handle.call("memory_recall", { continuation: first.structured["continuation"], maxBytes: 3_000 });
    const compact = await handle.call("memory_recall", { query: "widget", mode: "compact" });
    const none = await handle.call("memory_recall", { query: "pangolin" });

    const [paged, continued, indexed, empty] = rows(e);
    const pack = first.structured as unknown as ContextPack;
    expect(paged).toMatchObject({ name: "memory_recall", query: "widget", params: { maxBytes: 3_000 }, empty: 0, continued: 0, continues: 1 });
    expect(paged?.bytes).toBe(Buffer.byteLength(first.text, "utf8"));
    expect(paged?.tokens).toBe(Math.ceil(Buffer.byteLength(first.text, "utf8") / 4));
    expect(paged?.returned).toEqual(pack.items.map((item, position) => ({ id: item.recordId, kind: item.kind, freshness: item.freshness, position })));
    expect(paged?.omitted).toEqual(Object.fromEntries(pack.omissions.map((omission) => [omission.reason, omission.count])));
    expect(paged?.omitted["budget"]).toBeGreaterThan(0);

    expect(continued).toMatchObject({ query: null, continued: 1 });
    expect(continued?.returned.map((r) => r.id)).toEqual((next.structured as unknown as ContextPack).items.map((item) => item.recordId));

    // Compact items are text: the row still has their ids, in order.
    expect(indexed?.params).toMatchObject({ mode: "compact" });
    expect(indexed?.returned.map((r) => r.id)).toEqual((compact.structured["items"] as string[]).map(idOf));
    expect(indexed?.returned.every((r) => r.kind === "note" && typeof r.freshness === "string")).toBe(true);

    expect(empty).toMatchObject({ query: "pangolin", empty: 1, returned: [] });
    expect(empty?.bytes).toBe(Buffer.byteLength(none.text, "utf8"));
  });

  test("C3: a read's row holds the record read, `around`, and the timeline records returned, nearest-first order kept as the host sees it", async () => {
    const e = env();
    const ids = seed(e, 5);
    const handle = await server(e);
    const middle = ids[2] ?? "";
    const read = (await handle.call("memory_read", { recordId: middle, around: 2 })).structured as unknown as ReadResult;

    const [row] = rows(e);
    expect(row).toMatchObject({ name: "memory_read", params: { recordId: middle, around: 2 } });
    expect(row?.returned[0]).toEqual({ id: middle, kind: "note", freshness: read.freshness, position: 0 });
    const timeline = [...(read.timeline?.before ?? []), ...(read.timeline?.after ?? [])].map(idOf);
    expect(timeline.length).toBeGreaterThan(0);
    expect(row?.returned.slice(1).map((r) => r.id)).toEqual(timeline);
  });

  test("C4: record and checkpoint rows hold the kind, the size of what was written and the id written, never its text", async () => {
    const e = env();
    const handle = await server(e);
    const body = "Quokka vault note: rotate the staging keys every Friday.";
    const recorded = await handle.ok<{ recordId: string }>("memory_record", { kind: "decision", body, attribution: "user_direction" });
    const goal = "Quokka goal: rotate keys";
    const status = "Quokka status: staging done";
    const checkpoint = await handle.ok<{ recordId: string }>("memory_checkpoint", { expectedRevision: 0, goal, status });

    const [record, published] = rows(e);
    expect(record).toMatchObject({ name: "memory_record", params: { kind: "decision", attribution: "user_direction", textBytes: Buffer.byteLength(body) } });
    expect(record?.returned).toEqual([{ id: recorded.recordId, kind: "decision", freshness: null, position: 0 }]);
    expect(published).toMatchObject({ name: "memory_checkpoint", params: { expectedRevision: 0, textBytes: Buffer.byteLength(goal) + Buffer.byteLength(status) } });
    expect(published?.returned).toEqual([{ id: checkpoint.recordId, kind: "checkpoint", freshness: null, position: 0 }]);
    expect(JSON.stringify(rows(e)).toLowerCase()).not.toContain("quokka");
  });

  test("C5: start hooks log only the records their context shows, with its size; Stop logs outcome and time; UserPromptSubmit and PreToolUse log nothing", () => {
    const e = env();
    const memory = open(e);
    // With import approved, Stop's capture opens the database; logging never opens one itself.
    memory.bootstrap({ importChoice: "current_project" });
    const checkpoint = memory.checkpoint({ expectedRevision: 0, goal: "Fix the double charge", status: "Found the retry loop" }).recordId;
    memory.close();
    const notes = seed(e, 60);
    const transcript = installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: e.repo, sessionId: SESSION });

    const start = hook(e, "session-start", { hook_event_name: "SessionStart", source: "startup" });
    const subagent = hook(e, "subagent-start", { hook_event_name: "SubagentStart", agent_id: "a0000000000000001", agent_type: "general-purpose" });
    const prompt = hook(e, "user-prompt-submit", { hook_event_name: "UserPromptSubmit", prompt: "Fix the retry loop." });
    const stop = hook(e, "stop", { hook_event_name: "Stop", transcript_path: transcript.path, stop_hook_active: false });
    const pre = hook(e, "pre-tool-use", { hook_event_name: "PreToolUse", tool_name: "mcp__debrief__memory_recall", tool_input: { query: "x" }, tool_use_id: "toolu_pre" });
    for (const run of [start, subagent, prompt, stop, pre]) expect(run).toMatchObject({ code: 0, stderr: "" });

    const logged = rows(e);
    expect(logged.map((row) => [row.source, row.name, row.outcome, row.host_session_id])).toEqual([
      ["hook", "session-start", "ok", SESSION],
      ["hook", "subagent-start", "ok", SESSION],
      ["hook", "stop", "ok", SESSION],
    ]);
    for (const row of logged) expect(row.ms).toBeGreaterThan(0);
    const [started, subagentStarted, stopped] = logged;
    expect(stopped?.bytes).toBe(Buffer.byteLength(stop.stdout));
    for (const [row, run] of [
      [started, start],
      [subagentStarted, subagent],
    ] as const) {
      expect(row?.bytes).toBe(Buffer.byteLength(run.stdout));
      expect(row?.returned[0]).toMatchObject({ id: checkpoint, kind: "checkpoint", position: 0 });
      // The items listed, exactly: those the character cap cut are not among them.
      const listed = [...contextOf(run.stdout).matchAll(/\((rec_[0-9a-f]{32})\)/g)].map((match) => match[1]);
      const items = row?.returned.filter((r) => r.kind === "note").map((r) => r.id) ?? [];
      expect(items).toEqual(listed);
      expect(items.length).toBeGreaterThan(0);
      expect(items.length).toBeLessThan(notes.length);
    }
  });

  test("C6: a recall's stages (rank, load, freshness, pack) are each timed and fit in its total; time spent waiting on the user is not counted", async () => {
    const e = env();
    seed(e, 12);
    const handle = await server(e, {
      elicitation: {
        capability: {},
        respond: async () => {
          await sleep(500);
          return { action: "decline" };
        },
      },
    });
    await handle.ok("memory_recall", { query: "widget" });
    await handle.ok("memory_record", { kind: "preference", body: "Use pnpm, not npm.", attribution: "user_direction" });

    const [recall, preference] = rows(e);
    expect(Object.keys(recall?.stages ?? {}).sort()).toEqual(["freshness", "load", "pack", "rank"]);
    for (const ms of Object.values(recall?.stages ?? {})) expect(ms).toBeGreaterThanOrEqual(0);
    expect(Object.values(recall?.stages ?? {}).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(recall?.ms ?? 0);
    expect(preference?.name).toBe("memory_record");
    expect(preference?.ms).toBeLessThan(500);
  });

  test("C7: without the log table, calls return what they did and hooks print what they did", async () => {
    const e = env();
    seed(e, 3);
    const handle = await server(e);
    const before = await handle.call("memory_recall", { query: "widget" });
    const startPayload = { hook_event_name: "SessionStart", source: "startup" };
    const startBefore = hook(e, "session-start", startPayload);
    const promptBefore = hook(e, "user-prompt-submit", { hook_event_name: "UserPromptSubmit", prompt: "From now on, use pnpm." });
    const db = new Database(dbPath(e));
    db.exec("DROP TABLE call_log");
    db.close();

    const after = await handle.call("memory_recall", { query: "widget" });
    expect(after.isError).toBe(false);
    expect(after.structured["items"]).toEqual(before.structured["items"]);
    expect(hook(e, "user-prompt-submit", { hook_event_name: "UserPromptSubmit", prompt: "From now on, use pnpm." })).toEqual(promptBefore);
    const startAfter = hook(e, "session-start", startPayload);
    expect(startAfter).toMatchObject({ code: 0, stderr: "" });
    // The context is the same; the user's notice now also reports the logging failures, which are on record, not lost.
    expect(contextOf(startAfter.stdout)).toEqual(contextOf(startBefore.stdout));
    const memory = open(e);
    expect(memory.status().hookFailures.map((failure) => [failure.event, failure.code])).toEqual([
      ["memory_recall", "call_log_failed"],
      ["session-start", "call_log_failed"],
    ]);
  });
});

describe("the call log forgets what it must", () => {
  const Q = "quokka rotation schedule";
  const OTHER = "pangolin backlog";

  /** A session that recorded one note and recalled twice (once returning it), each call logged as the transport logs it. */
  function scenario(): { e: Env; memory: Memory; recordId: string } {
    const e = env();
    const memory = open(e, SESSION);
    memory.bootstrap();
    const recordId = memory.record({ kind: "note", body: "Quokka keys rotate on a schedule.", attribution: "agent_inference" }).recordId;
    memory.noteCall({ source: "tool", name: "memory_record", args: { kind: "note" }, result: { recordId, kind: "note" }, ms: 1, bytes: 10 });
    for (const query of [Q, OTHER]) memory.noteCall({ source: "tool", name: "memory_recall", args: { query }, result: memory.recall({ query }), ms: 1, bytes: 10 });
    return { e, memory, recordId };
  }

  function forget(memory: Memory, recordId: string): void {
    const preview = memory.manage({ action: "forget_preview", recordIds: [recordId] });
    if (preview.action !== "forget_preview") throw new Error("unreachable");
    memory.manage({ action: "forget", confirmToken: preview.confirmToken, reason: "The user asked to forget it.", attribution: "user_direction" });
  }

  test("C8a: forgetting a record blanks the query of the rows that returned or wrote it; their ids stay, other rows are untouched", () => {
    const { e, memory, recordId } = scenario();
    expect(rows(e).map((row) => [row.name, row.query, row.returned.map((r) => r.id)])).toEqual([
      ["memory_record", null, [recordId]],
      ["memory_recall", Q, [recordId]],
      ["memory_recall", OTHER, []],
    ]);

    forget(memory, recordId);

    expect(rows(e).map((row) => [row.query, row.erased, row.returned.map((r) => r.id)])).toEqual([
      [null, "forgotten", [recordId]],
      [null, "forgotten", [recordId]],
      [OTHER, null, []],
    ]);
  });

  test("C8b: a private session blanks every row of the host session, a resumed earlier session's and later calls' included; another session's rows stay", () => {
    const { e, memory } = scenario();
    // A Stop during the session: its capture opens the database without binding a session, so its row names only the host session.
    memory.bootstrap({ importChoice: "current_project" });
    memory.close();
    const transcript = installTranscript(e.config, "2.1.281/basic.jsonl", { cwd: e.repo, sessionId: SESSION });
    const stopRun = open(e);
    stopRun.endTurn({ transcriptPath: transcript.path });
    stopRun.noteCall({ source: "hook", name: "stop", ms: 1, bytes: 0, hostSessionId: SESSION });
    stopRun.close();
    const other = open(e, OTHER_SESSION);
    other.noteCall({ source: "tool", name: "memory_recall", args: { query: OTHER }, result: other.recall({ query: OTHER }), ms: 1, bytes: 10 });
    const resumed = open(e, SESSION);
    resumed.noteCall({ source: "tool", name: "memory_recall", args: { query: Q }, result: resumed.recall({ query: Q }), ms: 1, bytes: 10 });

    resumed.manage({ action: "private_session" });
    resumed.noteCall({ source: "tool", name: "memory_recall", args: { query: Q }, result: resumed.recall({ query: Q }), ms: 1, bytes: 10 });

    const logged = rows(e);
    expect(logged.find((row) => row.name === "stop")).toMatchObject({ session_id: null, host_session_id: SESSION });
    const mine = logged.filter((row) => row.host_session_id === SESSION);
    expect(mine.length).toBe(6);
    for (const row of mine) expect(row).toMatchObject({ query: null, params: {}, returned: [], erased: "private" });
    expect(logged.filter((row) => row.host_session_id === OTHER_SESSION).map((row) => [row.query, row.erased])).toEqual([[OTHER, null]]);
  });

  test("C8c: a restored older copy of the database blanks them again, after a forget and after a private mark", () => {
    for (const change of ["forget", "private"] as const) {
      const { e, memory, recordId } = scenario();
      memory.close();
      const path = dbPath(e);
      const backup = join(tempDir(), "backup.sqlite");
      copyFileSync(path, backup);
      const again = open(e, SESSION);
      if (change === "forget") forget(again, recordId);
      else again.manage({ action: "private_session" });
      again.close();
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) rmSync(path + suffix);
      copyFileSync(backup, path);

      // The first use of the restored copy replays the ledger into it.
      const restored = open(e);
      restored.recall();
      restored.close();

      expect(rows(e).map((row) => row.query), change).toEqual(change === "forget" ? [null, null, OTHER] : [null, null, null]);
    }
  });
});
