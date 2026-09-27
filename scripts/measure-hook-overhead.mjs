#!/usr/bin/env node
/**
 * Hook overhead as Claude Code pays it (#32): each `memchor hook <event>` run the way the plugin
 * runs it, `sh -c "memchor hook …"` with the host's payload on stdin, process start included.
 * The `memchor` command comes from `npm pack` of this checkout, installed offline into a
 * temporary prefix (as `npm install -g` would). Hooks are interleaved round-robin so load on the
 * machine spreads evenly, and the report records that load: numbers from a busy machine are not
 * evidence. Timings are observations, never pass/fail thresholds.
 *
 *   npm run measure:hooks -- [--runs 30] [--compare <entry.js>]
 *
 * `--compare` also times `node <entry.js> hook …` next to `node <installed dist/memchor.mjs> hook …`,
 * e.g. the unbundled `dist/cli.js`, so the two differ only in what Node loads.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, platform, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openMemory } from "../dist/memory.js";

const { values } = parseArgs({ options: { runs: { type: "string", default: "30" }, compare: { type: "string" } } });
const RUNS = Number(values.runs);
const ROOT = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "memchor-hook-overhead-"));
try {
  const before = machine();
  const rows = measure();
  process.stdout.write(report(rows, before, machine()));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

function measure() {
  const packed = execFileSync("npm", ["pack", "--pack-destination", scratch, "--silent"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").at(-1);
  const prefix = join(scratch, "prefix");
  execFileSync("npm", ["install", "--global", "--prefix", prefix, "--offline", "--no-audit", "--no-fund", join(scratch, packed)], { stdio: "ignore" });
  const installedCli = join(prefix, "lib", "node_modules", "memchor", "dist", "memchor.mjs");

  // A repository with a checkpoint and approved history, and one real transcript for Stop.
  const repo = join(scratch, "repo");
  const home = join(scratch, "memchor");
  const config = join(scratch, "claude");
  mkdirSync(repo);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.email=m@example.invalid", "-c", "user.name=m", "commit", "--quiet", "--allow-empty", "-m", "init"]);
  const session = "5e550000-0000-4000-8000-00000000a001";
  const project = join(config, "projects", repo.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const transcript = join(project, `${session}.jsonl`);
  const fixture = readFileSync(join(ROOT, "tests/import/fixtures/claude-code/2.1.281/basic.jsonl"), "utf8");
  writeFileSync(transcript, fixture.replaceAll("{{CWD}}", repo).replaceAll("{{SESSION}}", session));
  const memory = openMemory({ cwd: repo, home, host: "claude-code", claudeConfigDir: config });
  memory.bootstrap({ importChoice: "current_project" });
  memory.checkpoint({ expectedRevision: 0, goal: "Measure hook overhead", status: "Measuring", nextSteps: ["Read the report"] });
  memory.close();

  const base = { session_id: session, transcript_path: transcript, cwd: repo, permission_mode: "default" };
  const hooks = {
    "session-start": { ...base, hook_event_name: "SessionStart", source: "startup" },
    "subagent-start": { ...base, hook_event_name: "SubagentStart", agent_id: "a0123456789abcdef", agent_type: "general-purpose" },
    "user-prompt-submit": { ...base, hook_event_name: "UserPromptSubmit", prompt: "Fix the retry loop." },
    "pre-tool-use": { ...base, hook_event_name: "PreToolUse", tool_name: "mcp__plugin_memchor_memchor__memory_recall", tool_input: { query: "retry" }, tool_use_id: "toolu_01" },
    stop: { ...base, hook_event_name: "Stop", stop_hook_active: false },
  };
  const variants = {
    "memchor (PATH)": (event) => `memchor hook ${event} --host claude-code`,
    ...(values.compare === undefined
      ? {}
      : { "node dist/memchor.mjs": (event) => `'${process.execPath}' '${installedCli}' hook ${event} --host claude-code`, [`node ${values.compare}`]: (event) => `'${process.execPath}' '${resolve(values.compare)}' hook ${event} --host claude-code` }),
  };
  // Each Node process notes its own CPU time and how long it ran from start to exit: on a busy
  // machine these hold still while wall time does not.
  const preload = join(scratch, "timing.mjs");
  const timing = join(scratch, "timing.log");
  writeFileSync(preload, 'import { writeFileSync } from "node:fs";\nprocess.on("exit", () => { const c = process.cpuUsage(); writeFileSync(process.env.MEMCHOR_TIMING_LOG, `${(c.user + c.system) / 1000} ${performance.now()}`); });\n');
  const env = { ...process.env, PATH: `${join(prefix, "bin")}:${process.env.PATH}`, MEMCHOR_HOME: home, CLAUDE_CONFIG_DIR: config, NODE_OPTIONS: `--import=${preload}`, MEMCHOR_TIMING_LOG: timing };
  const run = (command, stdin) => {
    const started = process.hrtime.bigint();
    const done = spawnSync("/bin/sh", ["-c", command], { cwd: repo, env, input: stdin, encoding: "utf8" });
    const wall = Number(process.hrtime.bigint() - started) / 1e6;
    if (done.status !== 0 || done.stderr !== "") throw new Error(`${command}: exit ${done.status}: ${done.stderr}`);
    const [cpu, inProcess] = readFileSync(timing, "utf8").split(" ").map(Number);
    return { wall, cpu, inProcess };
  };

  const cells = [["floor: node -e 0", "-", () => `'${process.execPath}' -e 0`, ""]];
  for (const [variant, command] of Object.entries(variants)) for (const [event, payload] of Object.entries(hooks)) cells.push([variant, event, () => command(event), JSON.stringify(payload)]);
  const samples = new Map(cells.map(([variant, event]) => [`${variant}|${event}`, []]));
  for (const [, , command, stdin] of cells) for (let i = 0; i < 3; i++) run(command(), stdin);
  for (let i = 0; i < RUNS; i++) for (const [variant, event, command, stdin] of cells) samples.get(`${variant}|${event}`).push(run(command(), stdin));
  return cells.map(([variant, event]) => {
    const runs = samples.get(`${variant}|${event}`);
    return { variant, event, wall: stats(runs.map((r) => r.wall)), inProcess: stats(runs.map((r) => r.inProcess)), cpu: stats(runs.map((r) => r.cpu)) };
  });
}

function stats(ms) {
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return `${Math.round(at(0.5))} / ${Math.round(at(0.95))}`;
}

function machine() {
  const swap = platform() === "darwin" ? spawnSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" }).stdout.trim() : "n/a";
  return { spec: `${cpus()[0]?.model ?? "unknown CPU"} × ${cpus().length}, ${Math.round(totalmem() / 2 ** 30)} GB, ${platform()} ${release()}, node ${process.version}`, load: `load average (1/5/15 min) ${loadavg().map((l) => l.toFixed(2)).join(" / ")} · swap ${swap}` };
}

function report(rows, before, after) {
  return [
    `# memchor hook overhead · ${RUNS} runs each, interleaved, after 3 warm-up runs`,
    `machine: ${before.spec}`,
    `before: ${before.load}`,
    `after:  ${after.load}`,
    "",
    "wall: spawn to exit as the host waits, process start included · in-process: Node start to exit · cpu: user + system. Each p50 / p95 ms.",
    "",
    "| command | hook | wall | in-process | cpu |",
    "|---|---|---:|---:|---:|",
    ...rows.map((r) => `| ${r.variant} | ${r.event} | ${r.wall} | ${r.inProcess} | ${r.cpu} |`),
    "",
  ].join("\n");
}
