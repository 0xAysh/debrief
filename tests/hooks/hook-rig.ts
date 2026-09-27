import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "../helpers.js";

/**
 * A command hook for driven Claude Code hook tests: a tiny Node script that appends what the host
 * gave it (event, argv, stdin JSON, and the transcript at `transcript_path` as it stood when the
 * hook ran) to a JSON-lines log, then prints whatever stdout the test configured for that event.
 * It notes its start in `<log>.started` first, so a hook killed mid-run still leaves a trace.
 */
const HOOK_SCRIPT = `import { appendFileSync, existsSync, readFileSync } from "node:fs";
const [, , log, config, event] = process.argv;
const started = Date.now();
appendFileSync(log + ".started", JSON.stringify({ event, started }) + "\\n");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const outputs = existsSync(config) ? JSON.parse(readFileSync(config, "utf8")) : {};
const mine = outputs[event] ?? {};
let payload = null;
try { payload = JSON.parse(input); } catch {}
const path = payload === null ? undefined : payload.transcript_path;
let transcript = { exists: false, bytes: 0, lines: [] };
if (typeof path === "string" && existsSync(path)) {
  const text = readFileSync(path, "utf8");
  transcript = { exists: true, bytes: Buffer.byteLength(text), lines: text.split("\\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return line; } }) };
}
if (mine.sleepMs) await new Promise((resolve) => setTimeout(resolve, mine.sleepMs));
appendFileSync(log, JSON.stringify({ event, argv: process.argv.slice(2), payload, raw: payload === null ? input : undefined, transcript, started, finished: Date.now() }) + "\\n");
const out = payload !== null && payload.stop_hook_active === true && mine.stdoutWhenActive !== undefined ? mine.stdoutWhenActive : mine.stdout;
if (out) process.stdout.write(out);
`;

export type HookEvent = "SessionStart" | "UserPromptSubmit" | "Stop" | "PreToolUse";

export interface HookOutput {
  /** Printed on stdout, verbatim (JSON or plain text). */
  stdout?: string;
  /** Printed instead of `stdout` when the payload has `stop_hook_active: true`. */
  stdoutWhenActive?: string;
  /** Waits this long after reading stdin and before logging. */
  sleepMs?: number;
}

export interface HookRegistration {
  matcher?: string;
  async?: boolean;
  timeout?: number;
  /** The shell notes the spawn in `<log>.spawned` before Node boots, for hooks that may be killed early. */
  markSpawn?: boolean;
  /** Runs this shell command instead of the rig's script (nothing is logged). */
  command?: string;
}

export interface HookRecord {
  event: HookEvent;
  argv: string[];
  payload: Record<string, unknown> | null;
  raw?: string;
  transcript: { exists: boolean; bytes: number; lines: unknown[] };
  started: number;
  finished: number;
}

export interface HookRig {
  dir: string;
  script: string;
  log: string;
  /** Writes a Claude Code settings file whose `hooks` run the rig's script for each event. */
  settings(events: Partial<Record<HookEvent, HookRegistration>>, file?: string): string;
  /** What the script prints per event, from now on. */
  outputs(outputs: Partial<Record<HookEvent, HookOutput>>): void;
  records(): HookRecord[];
  /** Every hook script that started, finished or not. */
  starts(): { event: HookEvent; started: number }[];
  /** Events whose `markSpawn` shell ran. */
  spawned(): string[];
}

export function hookRig(): HookRig {
  const dir = tempDir("memchor-hooks-");
  const script = join(dir, "hook.mjs");
  const log = join(dir, "hooks.log");
  const config = join(dir, "outputs.json");
  writeFileSync(script, HOOK_SCRIPT);
  return {
    dir,
    script,
    log,
    settings(events, file = join(dir, "settings.json")) {
      const hooks: Record<string, unknown[]> = {};
      for (const [event, registration] of Object.entries(events)) {
        const run = registration.command ?? `${process.execPath} ${script} ${log} ${config} ${event}`;
        const handler = { type: "command", command: registration.markSpawn === true ? `echo ${event} >> ${log}.spawned; ${run}` : run, ...(registration.async === undefined ? {} : { async: registration.async }), ...(registration.timeout === undefined ? {} : { timeout: registration.timeout }) };
        hooks[event] = [{ ...(registration.matcher === undefined ? {} : { matcher: registration.matcher }), hooks: [handler] }];
      }
      writeFileSync(file, JSON.stringify({ hooks }, null, 2));
      return file;
    },
    outputs(outputs) {
      writeFileSync(config, JSON.stringify(outputs));
    },
    records: () => jsonLines<HookRecord>(log),
    starts: () => jsonLines<{ event: HookEvent; started: number }>(`${log}.started`),
    spawned: () => (existsSync(`${log}.spawned`) ? readFileSync(`${log}.spawned`, "utf8").split("\n").filter(Boolean) : []),
  };
}

function jsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/**
 * A JSON-safe copy of `value` with every given path replaced by its label (longest first), the
 * temp root by `<tmp>`, the Node binary by `<node>` and the home directory by `<home>`: evidence
 * holds only the synthetic session, never machine paths.
 */
export function sanitize(value: unknown, placeholders: [path: string, label: string][] = []): unknown {
  let text = JSON.stringify(value);
  const all: [string, string][] = [...placeholders, [process.execPath, "<node>"], [realpathSync(tmpdir()), "<tmp>"], [tmpdir(), "<tmp>"], [homedir(), "<home>"]];
  for (const [path, label] of all.sort((a, b) => b[0].length - a[0].length)) text = text.replaceAll(path, label);
  return JSON.parse(text) as unknown;
}
