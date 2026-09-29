import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { tempDir } from "../helpers.js";

/**
 * `streamJson` (what `claudeStream` drives `claude -p` with) against a small host that answers
 * stream-json: each prompt gets a result, and the first is followed by one nobody asked for. The
 * driver runs in its own `node` process with a kill timeout, because the bug this pins spun the
 * event loop forever: a test in this worker could never time out of it.
 */

const STREAM_JSON = pathToFileURL(join(import.meta.dirname, "stream-json.ts")).href;

function fakeHost(): string {
  const path = join(tempDir("debrief-stream-host-"), "host");
  writeFileSync(
    path,
    `#!${process.execPath}
let first = true;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const text = JSON.parse(line).message.content;
  const out = [{ type: "system", subtype: "init" }, { type: "result", result: text }];
  if (first) out.push({ type: "result", result: "unsolicited" });
  first = false;
  // One write, so the prompt's result and the unsolicited one reach the reader together.
  process.stdout.write(out.map((m) => JSON.stringify(m) + "\\n").join(""));
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

test("V6: a result nobody waits for does not hang the stream, and later prompts still get their own results", () => {
  const driver = `
import { streamJson } from ${JSON.stringify(STREAM_JSON)};
const stream = streamJson(${JSON.stringify(fakeHost())}, [], { cwd: process.cwd(), env: process.env, timeoutMs: 5000 });
const first = await stream.send("first");
stream.post("posted");
const second = await stream.send("second");
const run = await stream.end();
process.stdout.write(JSON.stringify({ first: first.result, second: second.result, code: run.code }));
`;
  const run = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", driver], { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });

  expect(run.signal, `the driver hung and was killed; stderr: ${run.stderr}`).toBeNull();
  expect(run.status, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual({ first: "first", second: "second", code: 0 });
});
