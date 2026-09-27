import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, installTranscript } from "../import/fixtures.js";
import { CLI } from "../mcp/harness.js";

interface Env {
  repo: string;
  home: string;
  config: string;
}

/** Runs `memchor hook stop --import` as Claude Code would: payload on stdin, cwd = the project. */
function stopHook(env: Env, stdin: string, home = env.home) {
  const started = performance.now();
  const run = spawnSync(process.execPath, [CLI, "hook", "stop", "--import", "--host", "claude-code"], {
    cwd: env.repo,
    input: stdin,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, MEMCHOR_HOME: home, CLAUDE_CONFIG_DIR: env.config },
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr, ms: performance.now() - started };
}

function payload(env: Env, transcriptPath: string, sessionId: string): string {
  return JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath, cwd: env.repo, permission_mode: "default", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "done" });
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

describe("memchor hook stop --import (Claude Code payload on stdin)", () => {
  test("imports the session's transcript and prints nothing", () => {
    const env = approvedRepo();
    const session = installTranscript(env.config, "2.1.281/basic.jsonl", { cwd: env.repo });
    const run = stopHook(env, payload(env, session.path, session.sessionId));
    expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
    const memory = open(env);
    expect(memory.recall({ query: "idempotency key per order" }).items.some((i) => i.excerpt.includes("idempotency key per order"))).toBe(true);
    expect(memory.status().captureFailures).toEqual([]);
  });

  test("without consent it imports nothing, prints nothing and records no failure", () => {
    const env = { repo: initRepo(), home: tempDir(), config: claudeConfigDir() };
    const session = installTranscript(env.config, "2.1.281/basic.jsonl", { cwd: env.repo });
    expect(stopHook(env, payload(env, session.path, session.sessionId))).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(open(env).status().captureFailures).toEqual([]);
  });

  test("a payload it cannot use fails open: exit 0, empty stdout, and a capture failure on record", () => {
    const env = approvedRepo();
    const outside = join(tempDir(), "5e550000-0000-4000-8000-0000000000d1.jsonl");
    writeFileSync(outside, "{}\n");
    for (const stdin of ["not json", JSON.stringify({ hook_event_name: "Stop" }), payload(env, outside, "5e550000-0000-4000-8000-0000000000d1")]) {
      expect(stopHook(env, stdin)).toMatchObject({ code: 0, stdout: "" });
    }
    expect(open(env).status().captureFailures.map((f) => [f.host, f.event, f.code])).toEqual([
      ["claude-code", "stop", "invalid_input"],
      ["claude-code", "stop", "invalid_input"],
      ["claude-code", "stop", "not_a_transcript"],
    ]);
  });

  test("unusable storage still exits 0 at once with empty stdout, records the failure and says why on stderr", () => {
    const env = approvedRepo();
    const session = installTranscript(env.config, "2.1.281/basic.jsonl", { cwd: env.repo });
    const dbPath = open(env).status().storage.dbPath ?? "";
    for (const suffix of ["-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
    writeFileSync(dbPath, "this is not a SQLite database, and it is long enough to have a header".repeat(20));
    const run = stopHook(env, payload(env, session.path, session.sessionId));
    expect(run).toMatchObject({ code: 0, stdout: "" });
    expect(run.stderr).toMatch(/^memchor hook stop: storage_/);
    expect(run.ms).toBeLessThan(5_000);
    expect(open(env).status().captureFailures.map((f) => f.code)).toEqual([expect.stringMatching(/^storage_/)]);
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
    expect(open(env).status().captureFailures.map((f) => [f.event, f.code])).toEqual([["session-start", "invalid_input"]]);
  });
});
