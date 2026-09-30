import { spawn, spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { initRepo, tempDir } from "../helpers.js";
import { openMemory } from "../../src/memory.js";
import { claudeConfigDir, codexHome, installCodexRollout, installTranscript } from "../import/fixtures.js";
import { CLI, spawnServer } from "./harness.js";

function debrief(cwd: string, home: string, ...args: string[]) {
  return debriefWith({}, cwd, home, ...args);
}

function debriefWith(env: Record<string, string>, cwd: string, home: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", DEBRIEF_HOME: home, CLAUDE_CONFIG_DIR: process.env["CLAUDE_CONFIG_DIR"] ?? "", CODEX_HOME: process.env["CODEX_HOME"] ?? "", ...env },
    encoding: "utf8",
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe("debrief CLI", () => {
  test("diag commands inspect the same memory the MCP server wrote", async () => {
    const repo = initRepo();
    const home = tempDir();
    const server = await spawnServer({ cwd: repo, home, host: "codex" });
    await server.ok("memory_record", { kind: "decision", title: "Use WAL", body: "Share one SQLite file across processes via WAL.", attribution: "user_direction" });
    await server.ok("memory_checkpoint", { expectedRevision: 0, goal: "storage", status: "decided" });
    await server.close();

    const status = debrief(repo, home, "diag", "status");
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ runtime: { supported: true }, counts: { records: 2, checkpoints: 1 } });

    const records = debrief(repo, home, "diag", "records");
    expect(records.code).toBe(0);
    expect(records.stdout).toMatch(/checkpoint r1/);
    expect(records.stdout).toMatch(/decision {2}user_direction {2}unreviewed {2}Use WAL/);

    expect(JSON.parse(debrief(repo, home, "diag", "reindex").stdout)).toEqual({ records: 2, chunks: 4 });
    const integrity = debrief(repo, home, "diag", "integrity");
    expect(integrity.code).toBe(0);
    expect(JSON.parse(integrity.stdout)).toMatchObject({ exists: true, schemaVersion: 9, ok: true, sqlite: ["ok"], searchIndex: "ok", foreignKeyViolations: 0 });
  });

  test("diag status is read-only: the first real bootstrap afterwards still creates the workstream", async () => {
    const repo = initRepo();
    const home = tempDir();
    const status = debrief(repo, home, "diag", "status");
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ scope: { workstreamId: null }, storage: { schemaVersion: null } });
    const integrity = debrief(repo, home, "diag", "integrity");
    expect(JSON.parse(integrity.stdout)).toMatchObject({ exists: false });

    const server = await spawnServer({ cwd: repo, home, host: "codex" });
    expect(await server.ok("memory_bootstrap")).toMatchObject({ created: { workspace: true, workstream: true } });
  });

  test("diag consent and diag import manage Codex history with --host codex, reading $CODEX_HOME", () => {
    const repo = initRepo();
    const home = tempDir();
    const codex = codexHome();
    installCodexRollout(codex, "0.142.5/basic.jsonl", { cwd: repo });
    const env = { CODEX_HOME: codex };

    const asked = debriefWith(env, repo, home, "diag", "consent", "--host", "codex");
    expect(asked.code).toBe(0);
    expect(JSON.parse(asked.stdout)).toMatchObject({ consent: null, state: "consent_required", transcripts: { found: 1, currentProject: 1 }, transcriptsRoot: codex });
    expect(JSON.parse(debriefWith(env, repo, home, "diag", "consent", "--host", "codex", "--set", "current_project").stdout)).toMatchObject({ consent: { choice: "current_project" } });
    // Codex's decision is its own: Claude Code's is still unanswered.
    expect(JSON.parse(debrief(repo, home, "diag", "consent").stdout)).toMatchObject({ consent: null });

    const imported = debriefWith(env, repo, home, "diag", "import", "--host", "codex");
    expect(imported.code).toBe(0);
    expect(JSON.parse(imported.stdout)).toMatchObject({ import: { host: "codex", state: "complete", problem: null, currentProject: { complete: 1, counters: { records: 8 } } } });
  });

  test("diag demo runs the tracer flow against DEBRIEF_HOME and prints the recalled pack", () => {
    const repo = initRepo();
    const home = tempDir();
    const first = debrief(repo, home, "diag", "demo");
    expect(first.code).toBe(0);
    const pack = JSON.parse(first.stdout) as { checkpoint: { revision: number; citations: unknown[] }; items: { kind: string; citations: unknown[] }[]; empty: boolean };
    expect(pack.empty).toBe(false);
    expect(pack.checkpoint.revision).toBe(1);
    expect(pack.checkpoint.citations).toHaveLength(2);
    expect(pack.items.find((item) => item.kind === "decision")?.citations).toHaveLength(1);
    expect(first.stderr).toContain(home);

    // Re-running publishes the next revision rather than conflicting.
    expect((JSON.parse(debrief(repo, home, "diag", "demo").stdout) as { checkpoint: { revision: number } }).checkpoint.revision).toBe(2);
  });

  test("errors are envelopes on stderr with a non-zero exit; usage errors exit 64", () => {
    const outside = debrief(tempDir("debrief-plain-"), tempDir(), "diag", "records");
    expect(outside.code).toBe(2);
    const [headline = "", ...envelope] = outside.stderr.split("\n");
    expect(headline).toMatch(/^debrief: Debrief could not resolve a Git worktree/);
    expect(JSON.parse(envelope.join("\n"))).toMatchObject({ error: { code: "scope_unresolved" } });
    expect(debrief(initRepo(), tempDir(), "mcp", "--host", "not-a-host").code).toBe(64);
    expect(debrief(initRepo(), tempDir(), "bogus").code).toBe(64);
  });

  test("transcript commands accept only a host whose transcripts Debrief can import", () => {
    const repo = initRepo();
    const home = tempDir();
    for (const host of ["bogus", "pi", "unknown"]) {
      for (const subcommand of ["consent", "import"]) {
        const run = debrief(repo, home, "diag", subcommand, "--host", host);
        expect(run.code).toBe(64);
        expect(run.stderr).toContain(`debrief: --host must be one of claude-code, codex (got ${host})`);
      }
    }
    const codex = debrief(repo, home, "diag", "consent", "--host", "codex");
    expect(codex.code).toBe(0);
    expect(JSON.parse(codex.stdout)).toMatchObject({ consent: null });
  });

  test("the MCP server closes and exits cleanly on SIGTERM", async () => {
    const child = spawn(process.execPath, [CLI, "mcp"], {
      cwd: initRepo(),
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", DEBRIEF_HOME: tempDir(), CLAUDE_CONFIG_DIR: process.env["CLAUDE_CONFIG_DIR"] ?? "", CODEX_HOME: process.env["CODEX_HOME"] ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise<void>((resolve) => child.stderr.on("data", (chunk: Buffer) => {
        if (/ready/.test(chunk.toString())) resolve();
      }));
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  });
});

describe("debrief import (Claude Code history)", () => {
  function claudeHistory() {
    const repo = initRepo();
    const home = tempDir();
    const config = claudeConfigDir();
    installTranscript(config, "2.1.281/basic.jsonl", { cwd: repo });
    const run = (...args: string[]) => debriefWith({ CLAUDE_CONFIG_DIR: config }, repo, home, "import", ...args);
    const recalled = () => {
      const memory = openMemory({ cwd: repo, home, host: "claude-code", claudeConfigDir: config });
      try {
        return memory.recall({ maxTokens: 8_000 }).items.length;
      } finally {
        memory.close();
      }
    };
    return { run, recalled };
  }

  test("before the user has chosen, it puts the question and imports nothing", () => {
    const { run, recalled } = claudeHistory();
    const asked = run();
    expect(asked.code).toBe(1);
    expect(asked.stdout).toMatch(/^debrief import · Claude Code$/m);
    expect(asked.stdout).toMatch(/^Debrief found 1 local Claude Code session/m);
    expect(asked.stdout).not.toMatch(/memory_bootstrap|^1\. All projects/m);
    expect(asked.stdout).toMatch(/^Answer with debrief import --set all\|current_project\|none$/m);
    expect(recalled()).toBe(0);
  });

  test("--set records the choice and imports what it approves, to completion; running it again adds nothing", () => {
    const { run, recalled } = claudeHistory();
    const first = run("--set", "current_project");
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/^ {2}choice {7}current_project$/m);
    expect(first.stdout).toMatch(/^ {2}this project 1 of 1 transcripts imported, \d+ records$/m);
    const records = recalled();
    expect(records).toBeGreaterThan(0);
    const again = run();
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/^ {2}choice {7}current_project$/m);
    expect(recalled()).toBe(records);
  });

  test("--set none declines: nothing is imported, and the choice is kept", () => {
    const { run, recalled } = claudeHistory();
    expect(run("--set", "none").code).toBe(0);
    const later = run();
    expect(later.code).toBe(0);
    expect(later.stdout).toMatch(/^ {2}choice {7}none: no transcripts are imported$/m);
    expect(recalled()).toBe(0);
  });

  test("an unknown choice is a usage error", () => {
    const { run } = claudeHistory();
    const bad = run("--set", "everything");
    expect(bad.code).toBe(64);
    expect(bad.stderr).toMatch(/--set must be one of all, current_project, none/);
  });
});
