import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../helpers.js";
import { resolveClaude } from "./claude.js";

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
