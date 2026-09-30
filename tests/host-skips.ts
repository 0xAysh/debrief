import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject } from "vitest";
import type { TestProject } from "vitest/node";

/**
 * What the driven host suites do when their host is missing or not the pinned build. A skip used
 * to be one stderr line lost in the run's output, so `npm test` went green while testing less.
 * Now every skip is recorded and the run ends with a banner naming each one, and
 * DEBRIEF_REQUIRE_HOSTS turns a required host's skip into a failure at collection, for runs that
 * must drive the real hosts (a release, a pin bump). `1` requires Claude Code, the host Debrief
 * supports; otherwise the value lists the required hosts (`claude,codex`).
 */

declare module "vitest" {
  export interface ProvidedContext {
    /** Where each test file records a host skip; the global setup's teardown reads it back. Absent when a run has no global setup. */
    hostSkipDir?: string;
  }
}

export type Host = "claude" | "codex";

export interface HostSkip {
  suite: string;
  reason: string;
}

/** The hosts a DEBRIEF_REQUIRE_HOSTS value requires. */
function requiredHosts(value: string | undefined): string[] {
  if (value === undefined || value === "") return [];
  if (value === "1") return ["claude"];
  return value.split(",").map((host) => host.trim());
}

/**
 * Called at the top of a host test file with its host and that host's skip reason (null when the
 * host is there). Returns the reason for `describe.skipIf`; throws it instead when
 * DEBRIEF_REQUIRE_HOSTS requires the host, which fails the file's collection. `options` exist for
 * the tests of this function.
 */
export function hostGate(suite: string, host: Host, reason: string | null, options: { env?: NodeJS.ProcessEnv; dir?: string } = {}): string | null {
  if (reason === null) return null;
  const required = (options.env ?? process.env)["DEBRIEF_REQUIRE_HOSTS"];
  if (requiredHosts(required).includes(host)) throw new Error(`${suite} cannot run: ${reason} (DEBRIEF_REQUIRE_HOSTS=${required} makes this a failure, not a skip)`);
  process.stderr.write(`${suite} skipped: ${reason}\n`);
  // Outside a vitest run with the global setup (a bare `vitest --config …`), there is nowhere to record.
  const dir = options.dir ?? inject("hostSkipDir");
  if (dir !== undefined) writeFileSync(join(dir, `${randomUUID()}.json`), JSON.stringify({ suite, reason } satisfies HostSkip));
  return reason;
}

/**
 * The global setup's part in host skips: a directory for the test files to record them in, and a
 * teardown that runs after the reporter's summary and prints the banner, so a green run that
 * tested less says so last.
 */
export function recordHostSkips(project: TestProject): () => void {
  const hostSkipDir = mkdtempSync(join(tmpdir(), "debrief-host-skips-"));
  project.provide("hostSkipDir", hostSkipDir);
  return () => {
    process.stderr.write(hostSkipBanner(readHostSkips(hostSkipDir)));
    rmSync(hostSkipDir, { recursive: true, force: true });
  };
}

export function readHostSkips(dir: string): HostSkip[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as HostSkip)
    .sort((a, b) => a.suite.localeCompare(b.suite));
}

/** The end-of-run banner: empty when every host suite ran. */
export function hostSkipBanner(skips: HostSkip[]): string {
  if (skips.length === 0) return "";
  const rule = "!".repeat(78);
  return [
    "",
    rule,
    `!! ${skips.length} HOST SUITE${skips.length === 1 ? "" : "S"} SKIPPED: this run did not drive the real host${skips.length === 1 ? "" : "s"} they cover`,
    rule,
    ...skips.map((skip) => `  - ${skip.suite}: ${skip.reason}`),
    rule,
    "!! DEBRIEF_REQUIRE_HOSTS=1 makes the Claude Code skips failures instead,",
    "!! DEBRIEF_REQUIRE_HOSTS=claude,codex the Codex ones too (see docs/development.md).",
    rule,
    "",
  ].join("\n");
}
