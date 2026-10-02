import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory } from "../../src/memory.js";
import { initRepo, snapshotTree, tempDir } from "../helpers.js";
import { CLI } from "./harness.js";

/**
 * Seam ① for #23: `debrief delete-data`, the built CLI, against a home that real use filled
 * (two repositories' memory, the import choice, the hooks' logs).
 */

const ON_PTY = resolve(import.meta.dirname, "on-pty.py");
/** Python with its pty module, which drives the CLI on a terminal; Windows has no pty (on-pty.py is POSIX only). */
const PYTHON = spawnSync("python3", ["-c", "import pty"]).status === 0 ? "python3" : null;
if (PYTHON === null) process.stderr.write("delete-data terminal tests skipped: python3 (for a pty) is not on PATH or has no pty module (Windows)\n");

function env(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", DEBRIEF_HOME: home, CLAUDE_CONFIG_DIR: process.env["CLAUDE_CONFIG_DIR"] ?? "", CODEX_HOME: process.env["CODEX_HOME"] ?? "" };
}

/** Without a terminal: stdin is a pipe, as in a script. */
function debrief(cwd: string, home: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [CLI, ...args], { cwd, env: env(home), encoding: "utf8", input: "" });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** On a terminal, answering the confirmation with `answer`. */
function debriefOnTerminal(cwd: string, home: string, answer: string, ...args: string[]) {
  const run = spawnSync(PYTHON ?? "python3", [ON_PTY, answer, process.execPath, CLI, ...args], { cwd, env: env(home), encoding: "utf8", timeout: 30_000 });
  return { code: run.status, shown: run.stdout.replaceAll("\r\n", "\n"), stderr: run.stderr };
}

/** A home as two repositories' sessions leave it: their memory, the import choice, the hooks' run notes and failure log. */
function usedHome(): { home: string; repo: string } {
  const home = tempDir();
  const repo = initRepo();
  for (const cwd of [repo, initRepo()]) {
    const memory = openMemory({ cwd, home, host: "claude-code" });
    memory.bootstrap({ importChoice: "none" });
    memory.record({ kind: "note", body: "SYNTHETIC-NOTE the retry budget is three", attribution: "agent_inference" });
    memory.close();
    const hook = spawnSync(process.execPath, [CLI, "hook", "stop", "--host", "claude-code"], { cwd, env: env(home), input: "not json" });
    expect(hook.status).toBe(0);
  }
  expect(readdirSync(home).sort()).toEqual(expect.arrayContaining(["consent.json", "hook-failures.jsonl", "hook-runs", "registry.json", "workspaces"]));
  return { home, repo };
}

describe("debrief delete-data", () => {
  test("without a terminal it deletes nothing unless --yes is passed, and says so", () => {
    const { home, repo } = usedHome();
    const before = snapshotTree(home);
    const run = debrief(repo, home, "delete-data");
    expect(run.code).toBe(64);
    expect(run.stderr).toContain("debrief: delete-data asks for confirmation on a terminal; pass --yes to delete without asking");
    expect(snapshotTree(home)).toEqual(before);
  });

  test("with --yes it shows what it deletes, deletes it, and the next use starts with no memory", () => {
    const { home, repo } = usedHome();
    const run = debrief(repo, home, "delete-data", "--yes");
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`  path          ${home}\n`);
    expect(run.stdout).toMatch(/^ {2}size {10}\d+(\.\d)? (KB|MB)$/m);
    expect(run.stdout).toContain("  workspaces    2\n");
    expect(run.stdout).toContain("This does not uninstall Debrief: run /plugin uninstall debrief@debrief in Claude Code, then npm uninstall -g debrief-cli.");
    expect(run.stdout).toContain(`Deleted Debrief's data from ${home}.`);
    expect(existsSync(home)).toBe(false);

    const status = debrief(repo, home, "diag", "status");
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ scope: { workstreamId: null }, storage: { schemaVersion: null } });
  });

  test.skipIf(PYTHON === null)("on a terminal it deletes only when the user types delete", () => {
    const { home, repo } = usedHome();
    const before = snapshotTree(home);
    // "\u0004" is Ctrl-D: the terminal closes the input before any answer.
    for (const answer of ["yes", "Delete", "", "\u0004"]) {
      const refused = debriefOnTerminal(repo, home, answer, "delete-data");
      expect(refused.code, refused.shown + refused.stderr).toBe(1);
      expect(refused.shown).toContain("  workspaces    2\n");
      expect(refused.shown).toContain("Type delete to confirm: ");
      expect(refused.shown).toContain("Nothing was deleted.");
      expect(snapshotTree(home)).toEqual(before);
    }

    const confirmed = debriefOnTerminal(repo, home, "delete", "delete-data");
    expect(confirmed.code, confirmed.shown + confirmed.stderr).toBe(0);
    expect(confirmed.shown).toContain(`Deleted Debrief's data from ${home}.`);
    expect(existsSync(home)).toBe(false);
  });

  test("a DEBRIEF_HOME that also holds files Debrief did not create: only Debrief's own are deleted", () => {
    const { home, repo } = usedHome();
    writeFileSync(join(home, "notes.txt"), "mine\n");
    mkdirSync(join(home, "photos"));
    writeFileSync(join(home, "photos", "cat.jpg"), "not a photo\n");

    const run = debrief(repo, home, "delete-data", "--yes");
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`Deleted Debrief's data from ${home}.`);
    expect(run.stdout).toContain("Kept 2 entries Debrief did not create: notes.txt, photos");
    expect(existsSync(join(home, "notes.txt")) && existsSync(join(home, "photos", "cat.jpg"))).toBe(true);
    expect(readdirSync(home).sort()).toEqual(["notes.txt", "photos"]);
    expect(snapshotTree(home).map((entry) => entry.split(":")[0])).toEqual(["notes.txt", "photos/cat.jpg"]);
  });

  test("a home that is a symbolic link to a directory: the data in it is deleted, the link and the directory are left", () => {
    const { home: real, repo } = usedHome();
    const link = join(tempDir(), "debrief-link");
    symlinkSync(real, link);
    const run = debrief(repo, link, "delete-data", "--yes");
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("  workspaces    2\n");
    expect(run.stdout).toContain(`Deleted Debrief's data from ${link}.`);
    expect(readdirSync(real)).toEqual([]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test("with no data there is nothing to delete, and nothing is created", () => {
    const repo = initRepo();
    const missing = join(tempDir(), "never-used");
    const none = debrief(repo, missing, "delete-data");
    expect(none.code, none.stderr).toBe(0);
    expect(none.stdout).toBe(`No Debrief data at ${missing}.\n`);
    expect(existsSync(missing)).toBe(false);

    const empty = tempDir();
    expect(debrief(repo, empty, "delete-data").stdout).toBe(`No Debrief data at ${empty}.\n`);
    expect(existsSync(empty)).toBe(true);
  });
});
