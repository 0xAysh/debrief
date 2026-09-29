import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { openMemory } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { hostGate } from "../host-skips.js";
import { installPackedDebrief, installPlugin, pathWith, PLUGIN_TOOL, STUB_KEY } from "../hooks/plugin-install.js";
import { CLAUDE_PINNED_VERSION, claudeAsync, claudeEnv, claudeSandbox, claudeSkipReason, claudeStream, firstUserText, sessionToolTraffic, startStubMessages } from "../mcp/claude.js";
import { NO_NETWORK } from "../mcp/harness.js";

/**
 * #23's Claude-only acceptance scenario, as a user gets it: `npm pack` installed as the `debrief`
 * command, the plugin installed from this repository's marketplace into the real Claude Code, a
 * clean profile, and a localhost stub model (seam ②). Session 1 is killed mid-turn without a
 * checkpoint; session 2 starts knowing where things stand and hands work to a sub-agent that
 * starts with the same memory; session 3 recalls the sub-agent's finding; "don't remember this
 * session", compaction and resume behave.
 */

const SKIP = hostGate("claude code acceptance test", claudeSkipReason());

const networkLogs: string[] = [];

// Every Debrief process (hooks, MCP server, status) runs with the no-network guard; hooks fail open, so each log must stay empty.
afterEach(() => {
  for (const log of networkLogs.splice(0)) expect(existsSync(log) ? readFileSync(log, "utf8") : "", log).toBe("");
});

/** The request that sends a tool's result back, when that result contains `marker` (Claude Code may append system messages after it). */
const toolResultWith =
  (marker: string) =>
  (request: Record<string, unknown>): boolean => {
    const last = ((request["messages"] ?? []) as { role: string; content: unknown }[]).findLast((m) => m.role === "user");
    return last?.role === "user" && Array.isArray(last.content) && (last.content as { type: string }[]).some((b) => b.type === "tool_result" && JSON.stringify(b).includes(marker));
  };

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => { reject(new Error(what)); }, ms)));
  return Promise.race([promise, timeout]).finally(() => { clearTimeout(timer); });
}

async function until(ready: () => boolean): Promise<void> {
  while (!ready()) await new Promise((resolve) => setTimeout(resolve, 25));
}

describe.skipIf(SKIP !== null)(`acceptance: Debrief installed as a user installs it, in the real Claude Code ${CLAUDE_PINNED_VERSION}`, () => {
  test("a killed session, the next one knowing where things stand, a sub-agent, a later recall, a private session, compaction and resume", async () => {
    const bin = installPackedDebrief();
    const sandbox = claudeSandbox();
    installPlugin(sandbox, pathWith(bin));
    const repo = initRepo({ branch: "fix/double-charge" });
    const debriefHome = tempDir();
    const networkLog = join(tempDir(), "network.log");
    networkLogs.push(networkLog);
    // Claude Code passes its environment on to the hooks and the MCP server it starts, so every `debrief` it runs loads the guard.
    const guarded = { PATH: pathWith(bin), DEBRIEF_HOME: debriefHome, NODE_OPTIONS: `--import=${NO_NETWORK}`, DEBRIEF_NETWORK_LOG: networkLog };
    const probeLog = join(tempDir(), "probe.log");
    spawnSync("node", ["-e", "fetch('http://127.0.0.1:9').catch(() => {})"], { env: claudeEnv(sandbox, { ...guarded, DEBRIEF_NETWORK_LOG: probeLog }) });
    expect(readFileSync(probeLog, "utf8"), "the guard is loaded into node processes started with this environment").toBe("fetch\n");

    const env = (stub: { port: number }) => claudeEnv(sandbox, { ...guarded, ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: STUB_KEY });
    const debrief = (...args: string[]) => {
      const run = spawnSync(join(bin, "debrief"), args, { cwd: repo, encoding: "utf8", timeout: 60_000, env: claudeEnv(sandbox, guarded) });
      return { code: run.status, stdout: run.stdout, stderr: run.stderr };
    };
    const memory = () => {
      const opened = openMemory({ cwd: repo, home: debriefHome, host: "claude-code", claudeConfigDir: sandbox.configDir });
      onCleanup(() => {
        opened.close();
      });
      return opened;
    };
    const recalled = (query: string, marker: string) => {
      const opened = memory();
      try {
        return opened.recall({ query, maxTokens: 8_000 }).items.filter((i) => i.excerpt.includes(marker));
      } finally {
        opened.close();
      }
    };

    // The user answers the import question from the terminal, as the README says.
    const answered = debrief("import", "--set", "current_project");
    expect(answered.code, answered.stdout + answered.stderr).toBe(0);

    // Session 1: one turn completes; in the next, a command runs and Claude Code is killed while it
    // waits for the model. That turn's Stop hook never runs, and no checkpoint was ever written.
    const s1 = await startStubMessages({
      calls: [{ tool: "Bash", builtin: true, input: { command: "echo SYNTHETIC-S1-FINDING the gateway retries a 504 without an idempotency key", description: "look" }, when: "SYNTHETIC-S1-CRASH" }],
      reply: "SYNTHETIC-S1-REPLY looking.",
      mcpPrefix: PLUGIN_TOOL,
      hold: toolResultWith("SYNTHETIC-S1-FINDING"),
    });
    const one = claudeStream(env(s1), repo, "--allowedTools", "Bash");
    await one.send("SYNTHETIC-S1-START where do the double charges come from?");
    one.post("SYNTHETIC-S1-CRASH check the gateway retries");
    await within(s1.held, 90_000, "the killed turn's command never ran");
    // Claude Code writes its transcript ~0.1 s behind the model request; kill once the result is on disk, while it waits on the model.
    const transcripts = join(sandbox.configDir, "projects", repo.replaceAll("/", "-"));
    await within(until(() => readdirSync(transcripts).some((f) => f.endsWith(".jsonl") && readFileSync(join(transcripts, f), "utf8").includes('"tool_result"'))), 10_000, "the command's result never reached the transcript");
    const killed = await one.kill("SIGKILL");
    expect(killed.code, "killed, not exited").toBeNull();

    // Session 2 starts knowing where things stand, with no tool call: its first request already
    // carries the killed turn, read from the transcript. It hands the next step to a sub-agent.
    const delegated = "SYNTHETIC-S2-DELEGATED find where the retry budget is set";
    const fromSubagent = (request: Record<string, unknown>): boolean => firstUserText(request).includes(delegated);
    const s2 = await startStubMessages({
      calls: [
        { tool: "Agent", builtin: true, input: { description: "retry budget", prompt: delegated, subagent_type: "general-purpose" }, when: "SYNTHETIC-S2-PROMPT" },
        { tool: "Bash", builtin: true, input: { command: "echo SYNTHETIC-S2-SUB-FINDING the retry budget is set in src/retry.ts", description: "look" }, when: fromSubagent },
      ],
      reply: (request) => (fromSubagent(request) ? "SYNTHETIC-S2-REPORT the budget is set in src/retry.ts." : "SYNTHETIC-S2-REPLY on it."),
      mcpPrefix: PLUGIN_TOOL,
    });
    const two = await claudeAsync(env(s2), repo, "-p", "SYNTHETIC-S2-PROMPT carry on with the double-charge fix. Use a helper.", "--output-format", "json", "--allowedTools", "Bash");
    expect(two.code, two.stderr).toBe(0);
    const opening = JSON.stringify(s2.requests.find((r) => JSON.stringify(r).includes("SYNTHETIC-S2-PROMPT")) ?? {});
    expect(opening).toContain("SessionStart hook additional context: ");
    expect(opening).toMatch(/## Last session \(claude-code, ended [^)]*, without a checkpoint\)/);
    expect(opening).toContain("- SYNTHETIC-S1-CRASH check the gateway retries");
    expect(opening).toContain("echo SYNTHETIC-S1-FINDING the gateway retries a 504");
    expect(opening, "no tool had been called").not.toContain('"type":"tool_use"');
    expect(JSON.stringify(s2.requests), "notices are for the user only").not.toContain("◪ debrief");
    const subagentOpening = JSON.stringify(s2.requests.find(fromSubagent) ?? {});
    expect(subagentOpening).toContain("SubagentStart hook additional context: ");
    expect(subagentOpening, "the sub-agent starts with what the killed session found").toContain("SYNTHETIC-S1-FINDING");

    // Session 3 recalls what only the sub-agent's command found, and checkpoints.
    const s3 = await startStubMessages({
      calls: [
        { tool: "memory_recall", input: { query: "SYNTHETIC-S2-SUB-FINDING retry budget" } },
        { tool: "memory_checkpoint", input: { expectedRevision: 0, goal: "Stop double charges", status: "Cause and retry budget found", nextSteps: ["SYNTHETIC-NEXT-S3 put the idempotency key on the gateway retry"] } },
      ],
      reply: "SYNTHETIC-S3-REPLY checkpointed.",
      mcpPrefix: PLUGIN_TOOL,
    });
    const three = await claudeAsync(env(s3), repo, "-p", "SYNTHETIC-S3-PROMPT where is the retry budget set?", "--output-format", "json", "--allowedTools", `${PLUGIN_TOOL}memory_checkpoint`);
    expect(three.code, three.stderr).toBe(0);
    const traffic = sessionToolTraffic(sandbox, (JSON.parse(three.stdout) as { session_id: string }).session_id);
    expect(traffic.uses).toEqual([`${PLUGIN_TOOL}memory_recall`, `${PLUGIN_TOOL}memory_checkpoint`]);
    expect(traffic.results[0]).toContain("SYNTHETIC-S2-SUB-FINDING the retry budget is set in src/retry.ts");
    expect(traffic.results[1]).toContain('"revision":1');
    expect(recalled("SYNTHETIC-S2-SUB-FINDING retry budget", "SYNTHETIC-S2-SUB-FINDING").map((i) => [i.attribution, i.source?.agentType])).toEqual([["direct_observation", "general-purpose"]]);

    // Session 4: "don't remember this session" forgets it, turns the hooks captured included; the rest stays.
    const s4 = await startStubMessages({ calls: [{ tool: "memory_manage", input: { action: "private_session" }, when: "SYNTHETIC-S4-FORGET" }], reply: "SYNTHETIC-S4-REPLY ok.", mcpPrefix: PLUGIN_TOOL });
    const four = claudeStream(env(s4), repo, "--allowedTools", `${PLUGIN_TOOL}memory_manage`);
    await four.send("SYNTHETIC-S4-SECRET the staging password rotation");
    expect(recalled("SYNTHETIC-S4-SECRET staging", "SYNTHETIC-S4-SECRET"), "the turn was captured before the user asked to forget it").not.toEqual([]);
    await four.send("SYNTHETIC-S4-FORGET don't remember this session");
    const fourEnded = await four.end();
    expect(fourEnded.code, fourEnded.stderr).toBe(0);
    expect(recalled("SYNTHETIC-S4-SECRET SYNTHETIC-S4-FORGET staging", "SYNTHETIC-S4")).toEqual([]);
    expect(recalled("SYNTHETIC-S1-FINDING gateway", "SYNTHETIC-S1-FINDING")).not.toEqual([]);
    expect(recalled("SYNTHETIC-S2-SUB-FINDING retry budget", "SYNTHETIC-S2-SUB-FINDING")).not.toEqual([]);

    // Session 5: startup, compaction and resume each deliver the checkpoint as it is then, without a tool call.
    const s5 = await startStubMessages({ calls: [], reply: "SYNTHETIC-S5-REPLY ok.", mcpPrefix: PLUGIN_TOOL });
    const carried = (marker: string, next: string): boolean => {
      const request = JSON.stringify(s5.requests.find((r) => JSON.stringify(r).includes(marker)) ?? {});
      return request.includes("SessionStart hook additional context: ") && request.includes(next);
    };
    const checkpoint = (expectedRevision: number, next: string): void => {
      const opened = memory();
      opened.checkpoint({ expectedRevision, goal: "Stop double charges", status: "Key going in", nextSteps: [next] });
      opened.close();
    };
    const five = claudeStream(env(s5), repo);
    const first = await five.send("SYNTHETIC-S5-FIRST where were we?");
    expect(carried("SYNTHETIC-S5-FIRST", "SYNTHETIC-NEXT-S3 put the idempotency key on the gateway retry")).toBe(true);
    checkpoint(1, "SYNTHETIC-NEXT-COMPACT");
    await five.send("/compact");
    await five.send("SYNTHETIC-S5-AFTER-COMPACT go on");
    const fiveEnded = await five.end();
    expect(fiveEnded.code, fiveEnded.stderr).toBe(0);
    expect(carried("SYNTHETIC-S5-AFTER-COMPACT", "SYNTHETIC-NEXT-COMPACT")).toBe(true);
    checkpoint(2, "SYNTHETIC-NEXT-RESUME");
    const resumed = await claudeAsync(env(s5), repo, "-p", "--resume", String(first["session_id"]), "SYNTHETIC-S5-RESUMED go on", "--output-format", "json");
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(carried("SYNTHETIC-S5-RESUMED", "SYNTHETIC-NEXT-RESUME")).toBe(true);
    expect(s5.requests.filter((r) => JSON.stringify(r).includes('"type":"tool_use"'))).toEqual([]);

    // After all of it, nothing failed and status is healthy.
    const after = memory();
    expect(after.status().hookFailures).toEqual([]);
    after.close();
    const status = debrief("status");
    expect(status.code, status.stdout + status.stderr).toBe(0);
    expect(status.stdout).toMatch(/^✔ healthy$/m);
  }, 600_000);
});
