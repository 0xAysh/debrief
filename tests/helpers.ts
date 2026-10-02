import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach } from "vitest";
import { DebriefError } from "../src/errors.js";

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/**
 * A fresh temporary directory, removed after the current test. Its real path as Git and the hosts
 * report it: on Windows `tmpdir()` can be an 8.3 short name (`C:\Users\RUNNER~1\…`), which only
 * the native realpath expands.
 */
export function tempDir(prefix = "debrief-test-"): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => {
    // Windows refuses to delete a file a process still holds open, for a moment after it exits too.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return dir;
}

/** Registers a teardown callback (e.g. closing a Memory, or awaiting a server's exit) for the current test. */
export function onCleanup(fn: () => unknown): void {
  cleanups.push(fn);
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Debrief Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Debrief Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** `git init` a repository with one commit on `branch`. */
export function initRepo(options: { branch?: string; commit?: boolean } = {}): string {
  const dir = tempDir("debrief-repo-");
  git(dir, "init", "--quiet", `--initial-branch=${options.branch ?? "main"}`);
  if (options.commit ?? true) {
    writeFileSync(join(dir, "README.md"), "# fixture\n");
    git(dir, "add", "README.md");
    git(dir, "commit", "--quiet", "-m", "initial");
  }
  return dir;
}

/**
 * `npm <args>` as `[file, argv]` for spawn: the npm running this test run (`npm test` and `npx` set
 * npm_execpath) under this node, since Windows cannot spawn `npm.cmd` without a shell.
 */
export function npmCommand(args: string[]): [string, string[]] {
  const cli = process.env["npm_execpath"];
  return cli !== undefined && /\.c?js$/.test(cli) ? [process.execPath, [cli, ...args]] : ["npm", args];
}

/** Every path under `root` (excluding `.git`, `/`-separated on every platform) with its size and mtime, for "nothing was written" checks. */
export function snapshotTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        walk(full);
      } else {
        const st = statSync(full);
        out.push(`${relative(root, full).split(sep).join("/")}:${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Runs `fn` and returns the DebriefError it throws; fails the test if it does not throw one. */
export function catchDebriefError(fn: () => unknown): DebriefError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DebriefError) return error;
    throw error;
  }
  throw new Error("expected a DebriefError but the call succeeded");
}
