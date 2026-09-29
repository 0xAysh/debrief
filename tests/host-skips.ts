import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inject } from "vitest";

/**
 * What the driven host suites do when their host is missing or not the pinned build. A skip used
 * to be one stderr line lost in the run's output, so `npm test` went green while testing less.
 * Now every skip is recorded and the run ends with a banner naming each one (`tests/global-setup.ts`),
 * and DEBRIEF_REQUIRE_HOSTS=1 turns a skip into a failure at collection, for runs that must drive
 * the real hosts (a release, a pin bump).
 */

declare module "vitest" {
  export interface ProvidedContext {
    /** Where each test file records a host skip; the global setup's teardown reads it back. Absent when a run has no global setup. */
    hostSkipDir?: string;
  }
}

export interface HostSkip {
  suite: string;
  reason: string;
}

/**
 * Called at the top of a host test file with its host's skip reason (null when the host is there).
 * Returns the reason for `describe.skipIf`; throws it instead under DEBRIEF_REQUIRE_HOSTS=1, which
 * fails the file's collection. `options` exist for the tests of this function.
 */
export function hostGate(suite: string, reason: string | null, options: { env?: NodeJS.ProcessEnv; dir?: string } = {}): string | null {
  if (reason === null) return null;
  if ((options.env ?? process.env)["DEBRIEF_REQUIRE_HOSTS"] === "1") throw new Error(`${suite} cannot run: ${reason} (DEBRIEF_REQUIRE_HOSTS=1 makes this a failure, not a skip)`);
  process.stderr.write(`${suite} skipped: ${reason}\n`);
  // Outside a vitest run with the global setup (a bare `vitest --config …`), there is nowhere to record.
  const dir = options.dir ?? inject("hostSkipDir");
  if (dir !== undefined) writeFileSync(join(dir, `${randomUUID()}.json`), JSON.stringify({ suite, reason } satisfies HostSkip));
  return reason;
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
    "!! DEBRIEF_REQUIRE_HOSTS=1 makes these failures instead (see docs/development.md).",
    rule,
    "",
  ].join("\n");
}
