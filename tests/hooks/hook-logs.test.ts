import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory } from "../../src/memory.js";
import { initRepo, tempDir } from "../helpers.js";
import { claudeConfigDir } from "../import/fixtures.js";
import { CLI } from "../mcp/harness.js";

/** Payload content no diagnostic may repeat: a marker Debrief never writes, and a token shaped like a real secret. */
const MARKER = "Q7XK-payload-content";
const SECRET = "ghp_Q7XKa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

/** Every text file under the home except workspace databases (memory itself, not a diagnostic). */
function diagnostics(home: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (!/\.sqlite(-wal|-shm)?$/.test(name)) files.set(relative(home, path), readFileSync(path, "utf8"));
    }
  };
  walk(home);
  return files;
}

describe("hook logs never repeat the payload", () => {
  test("payloads a hook cannot use leave no trace of their content in the failure log, run records or stderr", () => {
    const repo = initRepo({ branch: "fix/double-charge" });
    const home = tempDir();
    const config = claudeConfigDir();
    const setup = openMemory({ cwd: repo, home, host: "claude-code", claudeConfigDir: config });
    setup.bootstrap({ importChoice: "current_project" });
    setup.close();

    const content = `${MARKER} ${SECRET}`;
    const cases: [event: string, stdin: string][] = [];
    for (const event of ["stop", "session-start", "subagent-start", "user-prompt-submit", "pre-tool-use"]) {
      // Not JSON, with the content where a parser's error message would quote it.
      cases.push([event, `${MARKER} {"prompt": "${SECRET}"`]);
      // JSON of the wrong shape, with the content in every field a hook reads.
      cases.push([event, JSON.stringify({ session_id: { id: content }, transcript_path: 42, prompt: { text: content }, tool_name: [content], hook_event_name: content })]);
    }
    const stderr: string[] = [];
    for (const [event, stdin] of cases) {
      const run = spawnSync(process.execPath, [CLI, "hook", event, "--host", "claude-code"], {
        cwd: repo,
        input: stdin,
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, DEBRIEF_HOME: home, CLAUDE_CONFIG_DIR: config },
      });
      expect(run.status, `${event}: ${run.stderr}`).toBe(0);
      stderr.push(run.stderr);
    }

    const logs = diagnostics(home);
    // The failures were recorded (so the check below is not vacuous)...
    expect([...logs.keys()]).toEqual(expect.arrayContaining(["hook-failures.jsonl", "hook-runs/claude-code.stop.json"]));
    expect(logs.get("hook-failures.jsonl")?.trim().split("\n")).toHaveLength(cases.length);
    // ...without any of the payload's content.
    for (const [file, text] of [...logs, ...stderr.map((text, i): [string, string] => [`stderr of case ${i}`, text])]) {
      expect(text, file).not.toContain("Q7XK");
    }
  });
});
