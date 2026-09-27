import { spawnSync } from "node:child_process";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, claudeTurn, installTranscript } from "../import/fixtures.js";
import { CLI } from "../mcp/harness.js";

interface Env {
  repo: string;
  home: string;
  config: string;
}

/** Runs `memchor hook stop` as Claude Code would: payload on stdin, cwd = the project. */
function stopHook(env: Env, stdin: string, home = env.home) {
  const started = performance.now();
  const run = spawnSync(process.execPath, [CLI, "hook", "stop", "--host", "claude-code"], {
    cwd: env.repo,
    input: stdin,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, MEMCHOR_HOME: home, CLAUDE_CONFIG_DIR: env.config },
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr, ms: performance.now() - started };
}

function payload(env: Env, transcriptPath: string, sessionId: string, stopHookActive = false): string {
  return JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath, cwd: env.repo, permission_mode: "default", hook_event_name: "Stop", stop_hook_active: stopHookActive, last_assistant_message: "done" });
}

function open(env: Env): Memory {
  const memory = openMemory({ cwd: env.repo, home: env.home, host: "claude-code", claudeConfigDir: env.config });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

function approvedRepo(): Env {
  const env = { repo: initRepo({ branch: "fix/double-charge" }), home: tempDir(), config: claudeConfigDir() };
  const memory = open(env);
  memory.bootstrap({ importChoice: "current_project" });
  memory.close();
  return env;
}

describe("memchor hook stop (Claude Code payload on stdin)", () => {
  test("imports the session's transcript and tells the user what it saved", () => {
    const env = approvedRepo();
    const session = installTranscript(env.config, "2.1.281/basic.jsonl", { cwd: env.repo });
    const run = stopHook(env, payload(env, session.path, session.sessionId));
    expect(run).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(run.stdout)).toEqual({ systemMessage: expect.stringMatching(/^◪ memchor · saved turn \(\d+ events\)$/) as unknown });
    expect(stopHook(env, payload(env, session.path, session.sessionId))).toMatchObject({ code: 0, stdout: "", stderr: "" });
    const memory = open(env);
    expect(memory.recall({ query: "idempotency key per order" }).items.some((i) => i.excerpt.includes("idempotency key per order"))).toBe(true);
    expect(memory.status().hookFailures).toEqual([]);
  });

  test("without consent it imports nothing, prints nothing and records no failure", () => {
    const env = { repo: initRepo(), home: tempDir(), config: claudeConfigDir() };
    const session = installTranscript(env.config, "2.1.281/basic.jsonl", { cwd: env.repo });
    expect(stopHook(env, payload(env, session.path, session.sessionId))).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(open(env).status().hookFailures).toEqual([]);
  });

  test("a payload it cannot use fails open: exit 0, a capture failure on record, and the user told when the path was wrong", () => {
    const env = approvedRepo();
    const outside = join(tempDir(), "5e550000-0000-4000-8000-0000000000d1.jsonl");
    writeFileSync(outside, "{}\n");
    for (const stdin of ["not json", JSON.stringify({ hook_event_name: "Stop" })]) expect(stopHook(env, stdin)).toMatchObject({ code: 0, stdout: "" });
    const wrongPath = stopHook(env, payload(env, outside, "5e550000-0000-4000-8000-0000000000d1"));
    expect(wrongPath.code).toBe(0);
    expect(JSON.parse(wrongPath.stdout)).toEqual({ systemMessage: "◪ memchor · ⚠ turn not saved (not_a_transcript): memchor diag status" });
    expect(open(env).status().hookFailures.map((f) => [f.host, f.event, f.code])).toEqual([
      ["claude-code", "stop", "invalid_input"],
      ["claude-code", "stop", "invalid_input"],
      ["claude-code", "stop", "not_a_transcript"],
    ]);
  });

  test("a host without driven hook evidence (Codex, until it is pinned) is refused, and nothing is imported", () => {
    const env = approvedRepo();
    const session = installTranscript(env.config, "2.1.281/basic.jsonl", { cwd: env.repo });
    const run = spawnSync(process.execPath, [CLI, "hook", "stop", "--host", "codex"], {
      cwd: env.repo,
      input: payload(env, session.path, session.sessionId),
      encoding: "utf8",
      env: { ...process.env, MEMCHOR_HOME: env.home, CLAUDE_CONFIG_DIR: env.config },
    });
    expect(run).toMatchObject({ status: 0, stdout: "" });
    expect(run.stderr).toMatch(/--host must be one of claude-code \(got codex\)/);
    expect(open(env).status().hookFailures.map((f) => [f.host, f.code])).toEqual([["codex", "invalid_input"]]);
  });

  test("unusable storage still exits 0 at once, records the failure, and tells the user and stderr why", () => {
    const env = approvedRepo();
    const session = installTranscript(env.config, "2.1.281/basic.jsonl", { cwd: env.repo });
    const dbPath = open(env).status().storage.dbPath ?? "";
    for (const suffix of ["-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
    writeFileSync(dbPath, "this is not a SQLite database, and it is long enough to have a header".repeat(20));
    const run = stopHook(env, payload(env, session.path, session.sessionId));
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ systemMessage: expect.stringMatching(/^◪ memchor · ⚠ turn not saved \(storage_\w+\): memchor diag status$/) as unknown });
    expect(run.stderr).toMatch(/^memchor hook stop: storage_/);
    expect(run.ms).toBeLessThan(5_000);
    expect(open(env).status().hookFailures.map((f) => f.code)).toEqual([expect.stringMatching(/^storage_/)]);
  });
});

describe("memchor hook stop: the stale-checkpoint nudge", () => {
  test("the fifth turn of work without a checkpoint blocks the stop once with the reason; a stop already continued never blocks", () => {
    const env = approvedRepo();
    const sessionId = "5e550000-0000-4000-8000-0000000000d2";
    const { path } = installTranscript(env.config, "", { cwd: env.repo, sessionId, content: "" });
    let after: string | null = null;
    const stops: { stdout: string }[] = [];
    for (let n = 1; n <= 5; n++) {
      const turn = claudeTurn({ cwd: env.repo, sessionId, n, at: new Date(Date.now() - 3_600_000 + n * 1_000), prompt: `Step ${n}.`, command: "npm test", after });
      after = turn.last;
      appendFileSync(path, turn.lines);
      stops.push(stopHook(env, payload(env, path, sessionId)));
    }
    expect(stops.slice(0, 4).map((stop) => (JSON.parse(stop.stdout) as { decision?: string }).decision)).toEqual([undefined, undefined, undefined, undefined]);
    expect(JSON.parse(stops[4]?.stdout ?? "")).toEqual({
      decision: "block",
      reason: expect.stringMatching(/^Memchor: 5 turns since the last checkpoint \(none yet\), with files changed or commands run\./) as unknown,
      systemMessage: expect.stringMatching(/^◪ memchor · saved turn/) as unknown,
    });
    expect(stopHook(env, payload(env, path, sessionId, true))).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });
});

describe("memchor hook session-start (Claude Code payload on stdin)", () => {
  function sessionStartHook(env: Env, stdin: string) {
    const run = spawnSync(process.execPath, [CLI, "hook", "session-start", "--host", "claude-code"], {
      cwd: env.repo,
      input: stdin,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, MEMCHOR_HOME: env.home, CLAUDE_CONFIG_DIR: env.config },
    });
    return { code: run.status, stdout: run.stdout, stderr: run.stderr };
  }
  const start = (env: Env, sessionId: string) => JSON.stringify({ session_id: sessionId, transcript_path: join(env.config, "projects", "x", `${sessionId}.jsonl`), cwd: env.repo, hook_event_name: "SessionStart", source: "startup" });

  test("prints Claude Code's SessionStart JSON: context for the model, a notice for the user", () => {
    const env = approvedRepo();
    const memory = open(env);
    memory.checkpoint({ expectedRevision: 0, goal: "Stop double charges", status: "Key drafted", nextSteps: ["Wire the key into charge()"] });
    memory.close();
    const run = sessionStartHook(env, start(env, "5e550000-0000-4000-8000-0000000000e1"));
    expect(run).toMatchObject({ code: 0, stderr: "" });
    const output = JSON.parse(run.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string }; systemMessage: string };
    expect(Object.keys(output).sort()).toEqual(["hookSpecificOutput", "systemMessage"]);
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput.additionalContext).toContain("Wire the key into charge()");
    expect(output.systemMessage).toMatch(/^◪ memchor · checkpoint r1 loaded/);
  });

  test("the session it binds carries Claude Code's session id", () => {
    const env = approvedRepo();
    sessionStartHook(env, start(env, "5e550000-0000-4000-8000-0000000000e2"));
    const db = new Database(open(env).status().storage.dbPath ?? "", { readonly: true });
    try {
      expect(db.prepare("SELECT host, host_session_id FROM sessions WHERE host_session_id IS NOT NULL").all()).toEqual([{ host: "claude-code", host_session_id: "5e550000-0000-4000-8000-0000000000e2" }]);
    } finally {
      db.close();
    }
  });

  test("a payload it cannot use prints nothing and records the failure", () => {
    const env = approvedRepo();
    expect(sessionStartHook(env, "{}")).toMatchObject({ code: 0, stdout: "" });
    expect(open(env).status().hookFailures.map((f) => [f.event, f.code])).toEqual([["session-start", "invalid_input"]]);
  });
});

/** Runs `memchor hook <event> --host claude-code` with a payload on stdin, as Claude Code would. */
function hook(env: Env, args: string[], payload: object) {
  const run = spawnSync(process.execPath, [CLI, "hook", ...args, "--host", "claude-code"], {
    cwd: env.repo,
    input: JSON.stringify({ session_id: "5e550000-0000-4000-8000-0000000000f1", transcript_path: join(env.config, "projects", "x", "5e550000-0000-4000-8000-0000000000f1.jsonl"), cwd: env.repo, permission_mode: "default", ...payload }),
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, MEMCHOR_HOME: env.home, CLAUDE_CONFIG_DIR: env.config },
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe("memchor hook user-prompt-submit (Claude Code payload on stdin)", () => {
  test("lasting-preference wording adds one line of context for the agent; anything else prints nothing", () => {
    const env = approvedRepo();
    const hinted = hook(env, ["user-prompt-submit"], { hook_event_name: "UserPromptSubmit", prompt: "From now on, use pnpm." });
    expect(hinted).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(hinted.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: expect.stringMatching(/^Memchor: the user's wording may state a lasting preference\. [^\n]+$/) as unknown },
    });
    expect(hook(env, ["user-prompt-submit"], { hook_event_name: "UserPromptSubmit", prompt: "Fix the retry loop." })).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(open(env).status().hookFailures).toEqual([]);
  });
});

describe("memchor hook pre-tool-use (Claude Code payload on stdin)", () => {
  const call = (tool_name: string, tool_input: object) => ({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "toolu_01" });

  test("a read-only Memchor call is allowed, a recall with a notice for the user; a write prints nothing", () => {
    const env = approvedRepo();
    expect(JSON.parse(hook(env, ["pre-tool-use"], call("mcp__memchor__memory_read", { recordId: "rec_0123456789abcdef0123456789abcdef" })).stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
    expect(JSON.parse(hook(env, ["pre-tool-use"], call("mcp__memchor__memory_recall", { query: "retry policy" })).stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      systemMessage: "◪ memchor · recalling: retry policy",
    });
    expect(hook(env, ["pre-tool-use"], call("mcp__memchor__memory_record", { kind: "note", body: "x", attribution: "agent_inference" }))).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(open(env).status().hookFailures).toEqual([]);
  });
});
