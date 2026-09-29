import { spawn } from "node:child_process";
import { join } from "node:path";
import { CLI, NO_NETWORK } from "../mcp/harness.js";

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The built CLI with only the environment a test names, so no key leaks in from the developer's
 * shell. Asynchronous, so a localhost stub in the test process can answer it. `guard` preloads
 * the no-network guard logging to that file (with `DEBRIEF_NETWORK_ALLOW` from `env`).
 */
export function debrief(env: Record<string, string>, cwd: string, home: string, ...args: string[]): Promise<CliRun> {
  return run({ env, cwd, home, args });
}

export function run(options: { env: Record<string, string>; cwd: string; home: string; args: string[]; stdin?: string; guard?: string }): Promise<CliRun> {
  const child = spawn(process.execPath, [...(options.guard === undefined ? [] : ["--import", NO_NETWORK]), CLI, ...options.args], {
    cwd: options.cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      DEBRIEF_HOME: options.home,
      CLAUDE_CONFIG_DIR: join(options.home, "no-claude-config"),
      CODEX_HOME: join(options.home, "no-codex-home"),
      ...(options.guard === undefined ? {} : { DEBRIEF_NETWORK_LOG: options.guard }),
      ...options.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.stdin.end(options.stdin ?? "");
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
