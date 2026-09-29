import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../helpers.js";
import { hostGate, hostSkipBanner, readHostSkips } from "../host-skips.js";
import { resolveClaude } from "./claude.js";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * How the driven host tests pick their host binary, and what they do when it drifted from the pin.
 * The hosts here are small executable scripts that print a version: real processes, so the
 * `--version` probe runs exactly as it does against Claude Code itself.
 */

/** An executable that reports `version` the way `claude --version` does. */
function fakeHost(path: string, version: string): string {
  writeFileSync(path, `#!/bin/sh\necho "${version} (Claude Code)"\n`);
  chmodSync(path, 0o755);
  return path;
}

function machine(installed: string, kept: string[]): { bin: string; versionsDir: string } {
  const root = tempDir("debrief-host-pins-");
  const versionsDir = join(root, "versions");
  mkdirSync(versionsDir);
  for (const version of kept) fakeHost(join(versionsDir, version), version);
  return { bin: fakeHost(join(root, "claude"), installed), versionsDir };
}

describe("resolving the pinned Claude Code", () => {
  test("V1: when the installed claude auto-updated past the pin, the native installer's kept copy of the pinned build is used", () => {
    const { bin, versionsDir } = machine("2.1.284", ["2.1.283", "2.1.284"]);

    expect(resolveClaude({ bin, env: {}, versionsDir, pinned: "2.1.283" })).toEqual({ bin: join(versionsDir, "2.1.283"), skip: null });
    // The installed build is used as is when it is the pinned one.
    expect(resolveClaude({ bin, env: {}, versionsDir, pinned: "2.1.284" })).toEqual({ bin, skip: null });
  });

  test("V2: when neither the installed claude nor a kept copy is the pinned build, the skip names the installed version, the pin and both fixes", () => {
    const { bin, versionsDir } = machine("2.1.285", ["2.1.282", "2.1.285"]);

    const resolved = resolveClaude({ bin, env: {}, versionsDir, pinned: "2.1.283" });
    expect(resolved.bin).toBe(bin);
    expect(resolved.skip).toContain(`${bin} is Claude Code 2.1.285`);
    expect(resolved.skip).toContain("pin 2.1.283");
    expect(resolved.skip).toContain(join(versionsDir, "2.1.283"));
    expect(resolved.skip).toContain("DEBRIEF_TEST_CLAUDE_BIN");
    expect(resolved.skip).toContain("CLAUDE_PINNED_VERSION");

    // An explicit DEBRIEF_TEST_CLAUDE_BIN is never swapped for a kept copy: it drifted, so the skip says so.
    const { bin: explicit, versionsDir: kept } = machine("2.1.284", ["2.1.283"]);
    const overridden = resolveClaude({ bin: "/nonexistent/claude", env: { DEBRIEF_TEST_CLAUDE_BIN: explicit }, versionsDir: kept, pinned: "2.1.283" });
    expect(overridden.bin).toBe(explicit);
    expect(overridden.skip).toContain(`${explicit} is Claude Code 2.1.284`);

    // No binary at all.
    expect(resolveClaude({ bin: "/nonexistent/claude", env: {}, versionsDir: kept.replace(/versions$/, "none"), pinned: "2.1.283" }).skip).toContain("no Claude Code binary at /nonexistent/claude");
  });
});

describe("host suites that cannot run", () => {
  test("V3: with DEBRIEF_REQUIRE_HOSTS=1, a missing Claude Code or Codex fails collection with the reason instead of skipping", () => {
    // A real vitest run of two real host suites, with no global setup (nothing to build: collection fails first).
    const config = join(tempDir("debrief-require-hosts-"), "vitest.config.mjs");
    writeFileSync(config, `export default { test: { include: ["tests/mcp/claude-connection.test.ts", "tests/mcp/codex-connection.test.ts"] } };\n`);
    const vitest = (require: Record<string, string>): { code: number | null; output: string } => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && key !== "DEBRIEF_REQUIRE_HOSTS"));
      const run = spawnSync(process.execPath, [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--root", ROOT, "--config", config], {
        env: { ...env, DEBRIEF_TEST_CLAUDE_BIN: "/nonexistent/claude", DEBRIEF_TEST_CODEX_BIN: "/nonexistent/codex", ...require },
        encoding: "utf8",
        timeout: 60_000,
      });
      return { code: run.status, output: run.stdout + run.stderr };
    };

    const skipped = vitest({});
    expect(skipped.code, skipped.output).toBe(0);
    expect(skipped.output).toMatch(/skipped/);

    const required = vitest({ DEBRIEF_REQUIRE_HOSTS: "1" });
    expect(required.code, required.output).not.toBe(0);
    expect(required.output).toContain("no Claude Code binary at /nonexistent/claude");
    expect(required.output).toContain("no Codex binary at /nonexistent/codex");
    expect(required.output).toContain("DEBRIEF_REQUIRE_HOSTS=1");
    expect(required.output).toMatch(/Test Files {2}2 failed/);
  });

  test("V4: a run that skipped host suites ends with a banner naming each one and why", () => {
    const dir = tempDir("debrief-host-skips-");
    expect(hostSkipBanner(readHostSkips(dir))).toBe("");

    expect(hostGate("claude code plugin tests", null, { env: {}, dir })).toBeNull();
    expect(hostGate("claude code plugin tests", "claude is Claude Code 2.1.285", { env: {}, dir })).toBe("claude is Claude Code 2.1.285");
    hostGate("codex connection tests", "codex is codex-cli 0.150.0", { env: {}, dir });

    const banner = hostSkipBanner(readHostSkips(dir));
    expect(banner).toContain("2 HOST SUITES SKIPPED");
    expect(banner).toContain("claude code plugin tests: claude is Claude Code 2.1.285");
    expect(banner).toContain("codex connection tests: codex is codex-cli 0.150.0");
    expect(banner).toContain("DEBRIEF_REQUIRE_HOSTS=1");
  });
});
