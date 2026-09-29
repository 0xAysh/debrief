import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { hostSkipBanner, readHostSkips } from "./host-skips.js";

/**
 * Seam (b) spawns the real `dist/debrief.mjs` (the bundle the package ships), so build it once
 * before any test file runs. The teardown, which runs after the reporter's summary, prints the
 * banner of host suites that were skipped, so a green run that tested less says so last.
 */
export default function setup(project: TestProject): () => void {
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });
  execFileSync(process.execPath, ["scripts/bundle.mjs"], { stdio: "inherit" });
  const hostSkipDir = mkdtempSync(join(tmpdir(), "debrief-host-skips-"));
  project.provide("hostSkipDir", hostSkipDir);
  return () => {
    process.stderr.write(hostSkipBanner(readHostSkips(hostSkipDir)));
    rmSync(hostSkipDir, { recursive: true, force: true });
  };
}
