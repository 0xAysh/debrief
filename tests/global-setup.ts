import { execFileSync } from "node:child_process";
import type { TestProject } from "vitest/node";
import { recordHostSkips } from "./host-skips.js";

/**
 * Seam (b) spawns the real `dist/debrief.mjs` (the bundle the package ships), so build it once
 * before any test file runs. The teardown prints the banner of host suites that were skipped.
 */
export default function setup(project: TestProject): () => void {
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });
  execFileSync(process.execPath, ["scripts/bundle.mjs"], { stdio: "inherit" });
  return recordHostSkips(project);
}
