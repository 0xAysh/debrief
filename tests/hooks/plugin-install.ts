import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { expect } from "vitest";
import { tempDir } from "../helpers.js";
import { claude, claudeEnv, type ClaudeSandbox } from "../mcp/claude.js";

/**
 * Debrief as a user installs it: the command from `npm pack` of this checkout (installed offline,
 * as `npm install -g` would), and the plugin from this repository's marketplace in the real Claude Code.
 */

export const ROOT = resolve(import.meta.dirname, "../..");
export const PLUGIN_TOOL = "mcp__plugin_debrief_debrief__";
export const STUB_KEY = "sk-ant-stub-000";

/** `npm pack` of this checkout, installed with `npm install --global --prefix` from npm's cache; returns the prefix's bin directory. */
export function installPackedDebrief(): string {
  const dir = tempDir("debrief-pack-");
  const packed = spawnSync("npm", ["pack", "--pack-destination", dir, "--silent"], { cwd: ROOT, encoding: "utf8" });
  expect(packed.status, packed.stderr).toBe(0);
  const tarball = join(dir, packed.stdout.trim().split("\n").at(-1) ?? "");
  const installed = spawnSync("npm", ["install", "--global", "--prefix", join(dir, "prefix"), "--offline", "--no-audit", "--no-fund", tarball], { encoding: "utf8", timeout: 120_000 });
  expect(installed.status, `offline install from npm's cache failed (run npm ci once): ${installed.stderr}`).toBe(0);
  return join(dir, "prefix", "bin");
}

/** PATH with `bin` first (null: with no debrief at all), and the node that runs these tests. */
export function pathWith(bin: string | null): string {
  const rest = (process.env["PATH"] ?? "").split(delimiter).filter((d) => d !== "" && !existsSync(join(d, "debrief")));
  return [...(bin === null ? [] : [bin]), dirname(process.execPath), ...rest].join(delimiter);
}

export function installPlugin(sandbox: ClaudeSandbox, path: string): void {
  const env = claudeEnv(sandbox, { PATH: path });
  const added = claude(env, ROOT, "plugin", "marketplace", "add", ROOT);
  expect(added.code, added.stdout + added.stderr).toBe(0);
  const installed = claude(env, ROOT, "plugin", "install", "debrief@debrief");
  expect(installed.code, installed.stdout + installed.stderr).toBe(0);
}

export interface StreamEvent {
  type: string;
  subtype?: string;
  content?: string;
  hook_event?: string;
  output?: string;
  exit_code?: number;
}

export function streamEvents(stdout: string): StreamEvent[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StreamEvent);
}
