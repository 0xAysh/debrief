import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { initRepo, tempDir } from "../helpers.js";
import { hostGate } from "../host-skips.js";
import { CLAUDE_PINNED_VERSION, claude, claudeAsync, claudeEnv, claudeSandbox, claudeSkipReason, debriefAddArgs, sessionToolTraffic, startStubMessages } from "../mcp/claude.js";
import { type HookEvent, type HookOutput, type HookRecord, type HookRegistration, hookRig, sanitize } from "./hook-rig.js";

/**
 * Seam ② for #29: how the real Claude Code invokes command hooks and what it does with their
 * output, pinned by driving `claude -p` against a localhost stub model. Hooks are registered with
 * `--settings <file>` (hooks in that file load and run; no settings.json in CLAUDE_CONFIG_DIR is
 * needed). What reaches the model is read from the stub's raw request bodies. Every run's
 * sanitized payloads go to the git-ignored `__artifacts__/` as evidence for the support matrix.
 */

const SKIP = hostGate("claude code hook tests", "claude", claudeSkipReason());

const ARTIFACT = join(import.meta.dirname, "__artifacts__", `claude-${CLAUDE_PINNED_VERSION}-payloads.json`);
const evidence: Record<string, unknown> = { claudeCode: CLAUDE_PINNED_VERSION, mode: "claude -p", registration: "--settings <file> with a top-level hooks object" };

const STUB_KEY = "sk-ant-stub-000";

interface Session {
  repo: string;
  env: (port: number) => NodeJS.ProcessEnv;
  placeholders: [string, string][];
  sandbox: ReturnType<typeof claudeSandbox>;
}

/** A sandboxed Claude Code with debrief registered in user scope, in a fresh repository. */
function session(): Session {
  const sandbox = claudeSandbox();
  const repo = initRepo({ branch: "feat/hooks" });
  const debriefHome = tempDir();
  const added = claude(claudeEnv(sandbox), repo, ...debriefAddArgs({ debriefHome, networkLog: join(tempDir(), "network.log") }));
  expect(added.code, added.stderr).toBe(0);
  return {
    repo,
    sandbox,
    env: (port) => claudeEnv(sandbox, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: STUB_KEY }),
    placeholders: [
      [sandbox.configDir, "<claude-config>"],
      [sandbox.home, "<claude-home>"],
      [repo, "<repo>"],
      [debriefHome, "<debrief-home>"],
      // Claude Code names the project directory after the repository path with every / replaced.
      [repo.replaceAll("/", "-"), "<repo-slug>"],
    ],
  };
}

/** One `claude -p` run with hooks registered for `events`, each printing `outputs[event]`. */
async function drive(
  s: Session,
  options: { events: Partial<Record<HookEvent, HookRegistration>>; outputs?: Partial<Record<HookEvent, HookOutput>>; calls?: { tool: string; input: Record<string, unknown> }[]; reply?: string; prompt?: string; format?: string[] },
) {
  const rig = hookRig();
  const settings = rig.settings(options.events);
  rig.outputs(options.outputs ?? {});
  const stub = await startStubMessages({ calls: options.calls ?? [], reply: options.reply ?? "Done." });
  const started = Date.now();
  const run = await claudeAsync(s.env(stub.port), s.repo, "-p", options.prompt ?? "Hello hooks.", ...(options.format ?? ["--output-format", "json"]), "--settings", settings);
  const elapsedMs = Date.now() - started;
  expect(run.code, run.stderr).toBe(0);
  const placeholders: [string, string][] = [...s.placeholders, [rig.dir, "<hook-dir>"]];
  return { rig, stub, run, started, elapsedMs, placeholders };
}

function only(records: HookRecord[], event: HookEvent): HookRecord[] {
  return records.filter((r) => r.event === event);
}

function payload(record: HookRecord | undefined): Record<string, unknown> {
  expect(record?.payload, "the hook got JSON on stdin").toBeTypeOf("object");
  return record?.payload ?? {};
}

/** Every message of a Messages request with its content flattened to text. */
function messages(request: Record<string, unknown> | undefined): { role: string; text: string }[] {
  const list = (request?.["messages"] ?? []) as { role: string; content: string | { type: string; text?: string; content?: unknown }[] }[];
  return list.map((m) => ({
    role: m.role,
    text: typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? (typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""))).join("\n"),
  }));
}

function modelSaw(requests: Record<string, unknown>[], marker: string): boolean {
  return requests.some((r) => JSON.stringify(r).includes(marker));
}

/** A transcript as a hook saw it: size and line types only (the content is the whole prompt). */
function transcriptShape(record: HookRecord | undefined) {
  const lines = (record?.transcript.lines ?? []) as { type?: string; message?: { role?: string; content?: unknown } }[];
  return { exists: record?.transcript.exists ?? false, bytes: record?.transcript.bytes ?? 0, lineCount: lines.length, types: lines.map((l) => l.type ?? "?") };
}

function transcriptHas(record: HookRecord | undefined, role: string, text: string): boolean {
  const lines = (record?.transcript.lines ?? []) as { message?: { role?: string; content?: unknown } }[];
  return lines.some((l) => l.message?.role === role && JSON.stringify(l.message.content).includes(text));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe.skipIf(SKIP !== null)(`real Claude Code ${CLAUDE_PINNED_VERSION} command hooks`, () => {
  afterAll(() => {
    mkdirSync(join(import.meta.dirname, "__artifacts__"), { recursive: true });
    writeFileSync(ARTIFACT, `${JSON.stringify(evidence, null, 2)}\n`);
  });

  test("stdin payloads: SessionStart (source startup), UserPromptSubmit and Stop, and the transcript as Stop sees it", async () => {
    const s = session();
    const { rig, run, placeholders } = await drive(s, { events: { SessionStart: {}, UserPromptSubmit: {}, Stop: {} }, prompt: "Pin the payloads.", reply: "Payloads pinned." });
    const sessionId = (JSON.parse(run.stdout) as { session_id: string }).session_id;
    const records = rig.records();
    expect(records.map((r) => r.event)).toEqual(["SessionStart", "UserPromptSubmit", "Stop"]);
    const [start, prompt, stop] = records.map(payload) as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];

    const transcriptPath = join(s.sandbox.configDir, "projects", s.repo.replaceAll("/", "-"), `${sessionId}.jsonl`);
    const common = { session_id: sessionId, transcript_path: transcriptPath, cwd: s.repo };
    // No model, permission_mode, prompt_id or scratchpad_dir on a fresh -p SessionStart.
    expect(Object.keys(start).sort()).toEqual(["cwd", "hook_event_name", "session_id", "source", "transcript_path"]);
    expect(start).toEqual({ ...common, hook_event_name: "SessionStart", source: "startup" });
    expect(Object.keys(prompt).sort()).toEqual(["cwd", "hook_event_name", "permission_mode", "prompt", "prompt_id", "session_id", "transcript_path"]);
    expect(prompt).toMatchObject({ ...common, hook_event_name: "UserPromptSubmit", permission_mode: "default", prompt: "Pin the payloads." });
    expect(prompt["prompt_id"]).toMatch(/^[0-9a-f-]{36}$/);
    // `effort` arrives on Stop too, not only on tool events.
    expect(Object.keys(stop).sort()).toEqual([
      "background_tasks",
      "cwd",
      "effort",
      "hook_event_name",
      "last_assistant_message",
      "permission_mode",
      "prompt_id",
      "session_crons",
      "session_id",
      "stop_hook_active",
      "transcript_path",
    ]);
    expect(stop).toMatchObject({ ...common, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Payloads pinned.", background_tasks: [], session_crons: [], prompt_id: prompt["prompt_id"] });

    // The transcript file does not exist yet at SessionStart or UserPromptSubmit; by Stop it holds the turn.
    expect(records[0]?.transcript.exists).toBe(false);
    expect(records[1]?.transcript.exists).toBe(false);
    expect(records[2]?.transcript.exists).toBe(true);
    expect(transcriptHas(records[2], "user", "Pin the payloads.")).toBe(true);
    expect(transcriptHas(records[2], "assistant", "Payloads pinned.")).toBe(true);

    evidence["payloads"] = sanitize(
      { SessionStart: start, UserPromptSubmit: prompt, Stop: stop, transcriptAt: { SessionStart: transcriptShape(records[0]), UserPromptSubmit: transcriptShape(records[1]), Stop: transcriptShape(records[2]) } },
      [...placeholders, [sessionId, "<session>"], [String(prompt["prompt_id"]), "<prompt-id>"]],
    );
  }, 60_000);

  test("what reaches the model: SessionStart and UserPromptSubmit additionalContext and SessionStart plain stdout do; systemMessage does not", async () => {
    const s = session();
    const json = await drive(s, {
      events: { SessionStart: {}, UserPromptSubmit: {} },
      outputs: {
        SessionStart: { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "SS-CTX-7f1" }, systemMessage: "SS-SYSMSG-7f1" }) },
        UserPromptSubmit: { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "UPS-CTX-7f1" }, systemMessage: "UPS-SYSMSG-7f1" }) },
      },
    });
    const first = messages(json.stub.requests[0]);
    // Both contexts arrive in the first request, in a role:"system" message, each prefixed with its event.
    const withContext = first.filter((m) => m.text.includes("SS-CTX-7f1") || m.text.includes("UPS-CTX-7f1"));
    expect(withContext.map((m) => m.role)).toEqual(["system"]);
    expect(withContext[0]?.text).toContain("SessionStart hook additional context: SS-CTX-7f1");
    expect(withContext[0]?.text).toContain("UserPromptSubmit hook additional context: UPS-CTX-7f1");
    expect(modelSaw(json.stub.requests, "SYSMSG-7f1")).toBe(false);
    // Nor does systemMessage show in -p json output or on stderr.
    expect(json.run.stdout + json.run.stderr).not.toContain("SYSMSG-7f1");

    // Plain stdout, and systemMessage under --output-format stream-json --verbose.
    const plain = await drive(s, {
      events: { SessionStart: {}, UserPromptSubmit: {}, Stop: {} },
      outputs: {
        SessionStart: { stdout: "SS-PLAIN-7f1" },
        UserPromptSubmit: { stdout: JSON.stringify({ systemMessage: "UPS-SYSMSG-7f2" }) },
        Stop: { stdout: JSON.stringify({ systemMessage: "STOP-SYSMSG-7f2" }) },
      },
      format: ["--output-format", "stream-json", "--verbose"],
    });
    const plainContext = messages(plain.stub.requests[0]).filter((m) => m.text.includes("SS-PLAIN-7f1"));
    expect(plainContext.map((m) => m.role)).toEqual(["system"]);
    expect(plainContext[0]?.text).toContain("SessionStart:startup hook success: SS-PLAIN-7f1");
    expect(modelSaw(plain.stub.requests, "SYSMSG-7f2")).toBe(false);
    const events = plain.run.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; subtype?: string; content?: string; hook_event?: string; output?: string });
    const informational = events.filter((e) => e.type === "system" && e.subtype === "informational").map((e) => e.content);
    expect(informational).toEqual(["UserPromptSubmit says: UPS-SYSMSG-7f2", "Stop says: STOP-SYSMSG-7f2"]);
    const sessionStartResponse = events.find((e) => e.subtype === "hook_response" && e.hook_event === "SessionStart");
    expect(sessionStartResponse?.output).toBe("SS-PLAIN-7f1");

    evidence["modelSees"] = sanitize(
      {
        sessionStartAdditionalContext: { reachesModel: true, role: "system", prefix: "SessionStart hook additional context: " },
        userPromptSubmitAdditionalContext: { reachesModel: true, role: "system", prefix: "UserPromptSubmit hook additional context: ", sameMessageAsSessionStart: true },
        sessionStartPlainStdout: { reachesModel: true, role: "system", prefix: "SessionStart:startup hook success: " },
        systemMessage: { reachesModel: false, inJsonStdout: false, inStderr: false, streamJsonVerbose: informational },
        firstRequestRoles: first.map((m) => m.role),
      },
      plain.placeholders,
    );
  }, 90_000);

  test('Stop {"decision":"block"}: the model gets a follow-up request with the reason, and the next Stop has stop_hook_active true', async () => {
    const s = session();
    const { rig, stub, run, placeholders } = await drive(s, {
      events: { Stop: {} },
      outputs: { Stop: { stdout: JSON.stringify({ decision: "block", reason: "STOP-REASON-9c3" }), stdoutWhenActive: "" } },
      reply: "Finished.",
    });
    const stops = only(rig.records(), "Stop").map(payload);
    expect(stops.map((p) => p["stop_hook_active"])).toEqual([false, true]);
    expect(stub.requests).toHaveLength(2);
    const followUp = messages(stub.requests[1]);
    expect(messages(stub.requests[0]).some((m) => m.text.includes("STOP-REASON-9c3"))).toBe(false);
    // The reason arrives as a user message, and again inside a system message that also names the hook command.
    const withReason = followUp.filter((m) => m.text.includes("STOP-REASON-9c3"));
    expect(withReason.map((m) => m.role)).toEqual(["user", "system"]);
    expect(withReason[0]?.text).toBe("Stop hook feedback:\nSTOP-REASON-9c3");
    expect(withReason[1]?.text).toMatch(/^Stop hook blocking error from command: ".*hook\.mjs .* Stop": STOP-REASON-9c3/);
    expect((JSON.parse(run.stdout) as { result: string; num_turns: number }).result).toBe("Finished.");

    evidence["stopBlock"] = sanitize({ stopHookActive: stops.map((p) => p["stop_hook_active"]), followUpMessagesWithReason: withReason, requests: stub.requests.length }, placeholders);
  }, 60_000);

  test('PreToolUse permissionDecision "allow" runs an MCP tool in -p without --allowedTools; the matcher is an unanchored regex', async () => {
    const s = session();
    const calls = [{ tool: "memory_status", input: {} }];
    const allow = { PreToolUse: { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }) } };
    const outcome = (run: { stdout: string }) => {
      const result = JSON.parse(run.stdout) as { session_id: string; permission_denials: { tool_name: string }[] };
      const traffic = sessionToolTraffic(s.sandbox, result.session_id);
      return { sessionId: result.session_id, denied: result.permission_denials.map((d) => d.tool_name), ran: traffic.results[0]?.includes('"storage"') ?? false };
    };

    // Control: no hook, no --allowedTools: -p denies the call.
    const none = await drive(s, { events: {}, calls });
    expect(outcome(none.run)).toMatchObject({ denied: ["mcp__debrief__memory_status"], ran: false });

    const allowed = await drive(s, { events: { PreToolUse: { matcher: "mcp__debrief__.*" }, Stop: {} }, outputs: allow, calls });
    const allowedOutcome = outcome(allowed.run);
    expect(allowedOutcome).toMatchObject({ denied: [], ran: true });
    const pre = only(allowed.rig.records(), "PreToolUse");
    expect(pre).toHaveLength(1);
    const prePayload = payload(pre[0]);
    expect(Object.keys(prePayload).sort()).toEqual([
      "cwd",
      "effort",
      "hook_event_name",
      "mcp_server",
      "permission_mode",
      "prompt_id",
      "session_id",
      "tool_input",
      "tool_name",
      "tool_use_id",
      "transcript_path",
    ]);
    expect(prePayload).toMatchObject({
      session_id: allowedOutcome.sessionId,
      cwd: s.repo,
      hook_event_name: "PreToolUse",
      permission_mode: "default",
      tool_name: "mcp__debrief__memory_status",
      tool_input: {},
      mcp_server: { name: "debrief", source: "user" },
    });
    expect(prePayload["tool_use_id"]).toMatch(/^toolu_stub_\d+$/);
    expect(prePayload["effort"]).toEqual({ level: expect.any(String) as unknown });
    // After a tool turn the transcript at Stop exists and holds the prompt; whether it has caught up with the last lines is recorded, not asserted.
    const stop = only(allowed.rig.records(), "Stop")[0];
    expect(stop?.transcript.exists).toBe(true);
    expect(transcriptHas(stop, "user", "Hello hooks.")).toBe(true);

    // A bare server name is an exact match on the tool name: it never fires.
    const bare = await drive(s, { events: { PreToolUse: { matcher: "mcp__debrief" } }, outputs: allow, calls });
    expect(only(bare.rig.records(), "PreToolUse")).toHaveLength(0);
    expect(outcome(bare.run)).toMatchObject({ denied: ["mcp__debrief__memory_status"], ran: false });

    // The regex that would also cover a plugin-bundled server (mcp__plugin_debrief_debrief__*) still matches the user-scope name.
    const pluginForm = await drive(s, { events: { PreToolUse: { matcher: "mcp__(plugin_debrief_)?debrief__.*" } }, outputs: allow, calls });
    expect(only(pluginForm.rig.records(), "PreToolUse")).toHaveLength(1);
    expect(outcome(pluginForm.run)).toMatchObject({ denied: [], ran: true });

    evidence["preToolUse"] = sanitize(
      {
        payload: prePayload,
        noHook: { denied: outcome(none.run).denied },
        allow: { matcher: "mcp__debrief__.*", fired: true, ran: true, denied: [] },
        bareMatcher: { matcher: "mcp__debrief", fired: false, denied: ["mcp__debrief__memory_status"] },
        pluginRegex: { matcher: "mcp__(plugin_debrief_)?debrief__.*", fired: true, ran: true, pluginNameTested: false },
        transcriptAtStopAfterToolTurn: { ...transcriptShape(stop), hasToolResult: (stop?.transcript.lines ?? []).some((l) => JSON.stringify(l).includes('"tool_result"')), hasLastAssistantText: transcriptHas(stop, "assistant", "Done.") },
      },
      [...allowed.placeholders, [allowedOutcome.sessionId, "<session>"], [String(prePayload["prompt_id"]), "<prompt-id>"]],
    );
  }, 120_000);

  const ASYNC_SLEEP_MS = 6_000;
  test('"async": true on a Stop hook in -p: claude returns without waiting, and the hook is killed before it finishes', async () => {
    const s = session();
    const sync = await drive(s, { events: { Stop: {} }, outputs: { Stop: { sleepMs: 1500 } } });
    const debugFile = join(tempDir(), "debug.log");
    // Long enough that a slow teardown under load cannot outlast it, so "never finished" means killed.
    const asyncRun = await drive(s, { events: { Stop: { async: true, markSpawn: true } }, outputs: { Stop: { sleepMs: ASYNC_SLEEP_MS } }, format: ["--debug-file", debugFile] });
    const atExit = { spawned: asyncRun.rig.spawned().length, started: asyncRun.rig.starts().length, finished: asyncRun.rig.records().length };
    await new Promise((resolve) => setTimeout(resolve, ASYNC_SLEEP_MS + 1000));
    const after = { spawned: asyncRun.rig.spawned().length, started: asyncRun.rig.starts().length, finished: asyncRun.rig.records().length };
    const debug = readFileSync(debugFile, "utf8").split("\n");

    // Sync: claude waits out the hook's sleep.
    expect(sync.rig.records()).toHaveLength(1);
    expect(sync.elapsedMs).toBeGreaterThanOrEqual(1500);
    // Async: claude backgrounds the hook and exits without waiting for it...
    expect(debug.some((line) => line.includes("Hooks: Config-based async hook, backgrounding process"))).toBe(true);
    expect(debug.some((line) => /Hooks: Registering async hook async_hook_\d+ \(Stop\)/.test(line))).toBe(true);
    expect(asyncRun.elapsedMs).toBeLessThan(ASYNC_SLEEP_MS);
    // ...and the hook never completes, even after its whole sleep has passed. Whether it got as far as the shell or Node before
    // the teardown kill is a race (both observed), so only completion is asserted.
    expect(after.finished).toBe(0);

    evidence["async"] = sanitize(
      {
        sync: { claudeMs: sync.elapsedMs, hookRanMs: (sync.rig.records()[0]?.finished ?? 0) - (sync.rig.records()[0]?.started ?? 0) },
        async: { claudeMs: asyncRun.elapsedMs, atExit, afterSleep: after, verdict: "backgrounded, then killed at -p teardown before finishing; claude -p does not wait" },
        debugLines: debug.filter((line) => /async hook|killProcessTree|Shutting down/.test(line)).map((line) => line.replace(/^\S+ /, "")),
      },
      asyncRun.placeholders,
    );
  }, 60_000);

  test("overhead of no-op sync hooks on SessionStart, UserPromptSubmit and Stop (reported, not asserted)", async () => {
    const s = session();
    const bare: number[] = [];
    const shell: number[] = [];
    const node: number[] = [];
    const noop = { command: "true" };
    for (let i = 0; i < 3; i++) {
      bare.push((await drive(s, { events: {} })).elapsedMs);
      shell.push((await drive(s, { events: { SessionStart: noop, UserPromptSubmit: noop, Stop: noop } })).elapsedMs);
      const run = await drive(s, { events: { SessionStart: {}, UserPromptSubmit: {}, Stop: {} } });
      expect(run.rig.records()).toHaveLength(3);
      node.push(run.elapsedMs);
    }
    evidence["overhead"] = {
      runs: 3,
      hooks: ["SessionStart", "UserPromptSubmit", "Stop"],
      bareMs: bare,
      shellTrue: { command: "true", ms: shell, medianDeltaMs: median(shell) - median(bare) },
      nodeScript: { command: "node <script> (reads stdin, appends a log line)", ms: node, medianDeltaMs: median(node) - median(bare) },
    };
  }, 120_000);
});
