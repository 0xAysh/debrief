import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { CLAUDE_PINNED_VERSION, claudeAsync, claudeEnv, claudeSandbox, claudeSkipReason, startStubMessages } from "../mcp/claude.js";
import { CLI, NO_NETWORK } from "../mcp/harness.js";

/**
 * Seam ② for #29 with Memchor's own hooks: the real Claude Code runs `memchor hook
 * session-start` and `memchor hook stop --import`, registered with `--settings`, against a
 * localhost stub model. What the model received is read from the stub's request bodies.
 */

const SKIP = claudeSkipReason();

function hooksSettings(memchorHome: string): string {
  const memchor = (args: string) => `MEMCHOR_HOME='${memchorHome}' '${process.execPath}' --import '${NO_NETWORK}' '${CLI}' hook ${args} --host claude-code`;
  const path = join(tempDir(), "settings.json");
  writeFileSync(
    path,
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: memchor("session-start") }] }],
        Stop: [{ hooks: [{ type: "command", command: memchor("stop --import") }] }],
      },
    }),
  );
  return path;
}

describe.skipIf(SKIP !== null)(`Memchor's hooks in the real Claude Code ${CLAUDE_PINNED_VERSION}`, () => {
  test("the model starts with the checkpoint in context without any tool call, and the turn is captured when it stops", async () => {
    const sandbox = claudeSandbox();
    const repo = initRepo({ branch: "fix/double-charge" });
    const memchorHome = tempDir();
    const setup = openMemory({ cwd: repo, home: memchorHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      setup.close();
    });
    setup.bootstrap({ importChoice: "current_project" });
    setup.checkpoint({ expectedRevision: 0, goal: "Stop double charges", status: "Key drafted", nextSteps: ["SYNTHETIC-NEXT wire the idempotency key into charge()"] });
    setup.close();

    const stub = await startStubMessages({ calls: [], reply: "SYNTHETIC-REPLY the key goes into charge()." });
    const run = await claudeAsync(
      claudeEnv(sandbox, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: "sk-ant-stub-000" }),
      repo,
      "-p",
      "SYNTHETIC-PROMPT where did we leave the double-charge fix?",
      "--output-format",
      "json",
      "--settings",
      hooksSettings(memchorHome),
    );
    expect(run.code, run.stderr).toBe(0);

    const first = JSON.stringify(stub.requests[0] ?? {});
    expect(first).toContain("SessionStart hook additional context: ");
    expect(first).toContain("SYNTHETIC-NEXT wire the idempotency key into charge()");
    expect(first).toContain("Memchor is local working memory shared by the coding agents in this repository.");
    // The notice is for the user only.
    expect(JSON.stringify(stub.requests)).not.toContain("◪ memchor");
    expect(stub.offeredTools.flat().filter((t) => t.startsWith("mcp__"))).toEqual([]);

    const after = openMemory({ cwd: repo, home: memchorHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
    onCleanup(() => {
      after.close();
    });
    const texts = after.recall({ query: "SYNTHETIC-PROMPT double-charge", maxTokens: 8_000 }).items.map((i) => i.excerpt);
    expect(texts.some((t) => t.includes("SYNTHETIC-PROMPT where did we leave the double-charge fix?"))).toBe(true);
    expect(after.status().captureFailures).toEqual([]);
  });
});
