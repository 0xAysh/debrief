import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { initRepo, tempDir } from "../helpers.js";
import { hostGate } from "../host-skips.js";
import { CLAUDE_PINNED_VERSION, claude, claudeAsync, claudeEnv, claudeSandbox, claudeSkipReason, firstUserText, debriefAddArgs, type StubToolUse, startStubMessages } from "../mcp/claude.js";
import { type HookEvent, type HookOutput, type HookRecord, hookRig, sanitize } from "./hook-rig.js";

/**
 * Seam ② for #40: what the real Claude Code does around a sub-agent, pinned before Debrief
 * builds on it. The stub model answers the parent's first request with an `Agent` call and the
 * sub-agent's requests (recognised by their first user message, the prompt the parent gave)
 * with a `Bash` call and a Debrief recall. The rig logs every hook. Sanitized payloads go to the
 * git-ignored `__artifacts__/` as evidence.
 */

const SKIP = hostGate("claude code sub-agent tests", claudeSkipReason());

const ARTIFACT = join(import.meta.dirname, "__artifacts__", `claude-${CLAUDE_PINNED_VERSION}-subagents.json`);
const evidence: Record<string, unknown> = { claudeCode: CLAUDE_PINNED_VERSION, mode: "claude -p", registration: "--settings <file> with a top-level hooks object" };

const PARENT_PROMPT = "PARENT-PROMPT-4e0 find the retry budget with a helper";
const SUBAGENT_PROMPT = "SUBAGENT-PROMPT-4e0 look up the retry budget";
const ALL_EVENTS: HookEvent[] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStart", "SubagentStop"];
const ALLOW = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });

/** A request the sub-agent made: its conversation starts with the parent's prompt for it. */
const fromSubagent = (request: Record<string, unknown>): boolean => firstUserText(request).includes(SUBAGENT_PROMPT);

/** One `claude -p` run in which the parent spawns one general-purpose sub-agent that runs a command and a Debrief recall. */
async function spawnSubagent(options: { background: boolean; outputs: Partial<Record<HookEvent, HookOutput>> }) {
  const sandbox = claudeSandbox();
  const repo = initRepo({ branch: "feat/subagents" });
  const debriefHome = tempDir();
  const added = claude(claudeEnv(sandbox), repo, ...debriefAddArgs({ debriefHome, networkLog: join(tempDir(), "network.log") }));
  expect(added.code, added.stderr).toBe(0);
  const rig = hookRig();
  const settings = rig.settings(Object.fromEntries(ALL_EVENTS.map((event) => [event, {}])));
  rig.outputs(options.outputs);
  const calls: StubToolUse[] = [
    { tool: "Agent", builtin: true, input: { description: "retry budget", prompt: SUBAGENT_PROMPT, subagent_type: "general-purpose", ...(options.background ? {} : { run_in_background: false }) }, when: PARENT_PROMPT },
    { tool: "Bash", builtin: true, input: { command: "echo SUBAGENT-FINDING-4e0", description: "print the finding" }, when: fromSubagent },
    { tool: "memory_recall", input: { query: "retry budget" }, when: fromSubagent },
  ];
  const stub = await startStubMessages({ calls, reply: "REPLY-4e0 the budget is three." });
  const run = await claudeAsync(
    claudeEnv(sandbox, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: "sk-ant-stub-000" }),
    repo,
    "-p",
    PARENT_PROMPT,
    "--output-format",
    "json",
    "--settings",
    settings,
    // Bash is allowed outright, so only the Debrief call depends on the PreToolUse hook.
    "--allowedTools",
    "Bash",
  );
  expect(run.code, run.stderr).toBe(0);
  const sessionId = (JSON.parse(run.stdout) as { session_id: string }).session_id;
  const project = join(sandbox.configDir, "projects", repo.replaceAll("/", "-"));
  const placeholders: [string, string][] = [
    [sandbox.configDir, "<claude-config>"],
    [sandbox.home, "<claude-home>"],
    [repo, "<repo>"],
    [debriefHome, "<debrief-home>"],
    [repo.replaceAll("/", "-"), "<repo-slug>"],
    [rig.dir, "<hook-dir>"],
    [sessionId, "<session>"],
  ];
  return { rig, stub, run, sessionId, project, placeholders };
}

function payload(record: HookRecord | undefined): Record<string, unknown> {
  expect(record?.payload, "the hook got JSON on stdin").toBeTypeOf("object");
  return record?.payload ?? {};
}

type Line = { type?: string; isSidechain?: boolean; agentId?: string; sessionId?: string; origin?: unknown; message?: { role?: string; content?: unknown } };

function lines(path: string): Line[] {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Line);
}

/** The conversation entries of a transcript (user and assistant), as `role: text-or-block-types`. */
function conversation(entries: readonly Line[]): string[] {
  return entries
    .filter((l) => l.type === "user" || l.type === "assistant")
    .map((l) => {
      const content = l.message?.content;
      const shown = typeof content === "string" ? content : (content as { type: string; text?: string; name?: string }[]).map((b) => b.text ?? b.name ?? b.type).join("+");
      return `${l.type ?? "?"}: ${shown}`;
    });
}

describe.skipIf(SKIP !== null)(`real Claude Code ${CLAUDE_PINNED_VERSION} around a sub-agent`, () => {
  afterAll(() => {
    mkdirSync(join(import.meta.dirname, "__artifacts__"), { recursive: true });
    writeFileSync(ARTIFACT, `${JSON.stringify(evidence, null, 2)}\n`);
  });

  test("foreground: SubagentStart and SubagentStop payloads, the hooks that fire inside the sub-agent, and its transcript: where, and whether it is whole at each hook", async () => {
    const { rig, sessionId, project, placeholders } = await spawnSubagent({ background: false, outputs: { PreToolUse: { stdout: ALLOW } } });
    const records = rig.records();
    const seen = records.map((r) => `${r.event}${typeof r.payload?.["tool_name"] === "string" ? ` ${r.payload["tool_name"]}` : ""}${r.payload?.["agent_id"] === undefined ? "" : " (sub-agent)"}`);
    // Inside the sub-agent only tool hooks fire, marked with its agent_id; no SessionStart, UserPromptSubmit or Stop.
    expect(seen).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse Agent",
      "SubagentStart (sub-agent)",
      "PreToolUse Bash (sub-agent)",
      "PostToolUse Bash (sub-agent)",
      "PreToolUse mcp__debrief__memory_recall (sub-agent)",
      "PostToolUse mcp__debrief__memory_recall (sub-agent)",
      "SubagentStop (sub-agent)",
      "PostToolUse Agent",
      "Stop",
    ]);
    const start = payload(records.find((r) => r.event === "SubagentStart"));
    const stop = payload(records.find((r) => r.event === "SubagentStop"));
    const agentCall = payload(records.find((r) => r.event === "PreToolUse" && r.payload?.["tool_name"] === "Agent"));
    const agentId = String(start["agent_id"]);
    expect(agentId).toMatch(/^a[0-9a-f]{16}$/);
    const parentTranscript = join(project, `${sessionId}.jsonl`);
    const agentTranscript = join(project, sessionId, "subagents", `agent-${agentId}.jsonl`);
    // The parent's session and transcript, plus the sub-agent's id and type; no prompt, no agent_transcript_path.
    expect(Object.keys(start).sort()).toEqual(["agent_id", "agent_type", "cwd", "hook_event_name", "prompt_id", "session_id", "transcript_path"]);
    expect(start).toMatchObject({ session_id: sessionId, transcript_path: parentTranscript, agent_type: "general-purpose", hook_event_name: "SubagentStart", prompt_id: agentCall["prompt_id"] });
    expect(Object.keys(stop).sort()).toEqual([
      "agent_id",
      "agent_transcript_path",
      "agent_type",
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
    expect(stop).toMatchObject({ session_id: sessionId, transcript_path: parentTranscript, agent_id: agentId, agent_type: "general-purpose", agent_transcript_path: agentTranscript, stop_hook_active: false, last_assistant_message: "REPLY-4e0 the budget is three." });
    // The tool hooks inside the sub-agent carry the parent's session id, so a Debrief call there is the parent session's.
    for (const record of records.filter((r) => r.payload?.["agent_id"] !== undefined && r.event.endsWith("ToolUse"))) {
      expect(record.payload).toMatchObject({ session_id: sessionId, transcript_path: parentTranscript, agent_id: agentId, agent_type: "general-purpose" });
    }

    // The sub-agent's transcript: every entry a sidechain of the parent's session, its first the parent's prompt with no origin.
    const entries = lines(agentTranscript);
    expect(entries.every((l) => l.isSidechain === true && l.agentId === agentId && l.sessionId === sessionId)).toBe(true);
    expect(conversation(entries)).toEqual([`user: ${SUBAGENT_PROMPT}`, "assistant: Bash", "user: tool_result", "assistant: mcp__debrief__memory_recall", "user: tool_result", "assistant: REPLY-4e0 the budget is three."]);
    expect(entries.find((l) => l.type === "user")?.origin).toBeUndefined();
    const meta = JSON.parse(readFileSync(join(project, sessionId, "subagents", `agent-${agentId}.meta.json`), "utf8")) as Record<string, unknown>;
    expect(meta).toEqual({ agentType: "general-purpose", description: "retry budget", toolUseId: expect.stringMatching(/^toolu_stub_/) as unknown, spawnDepth: 1, requestShape: "foreground", requestNonInteractive: true });
    // At SubagentStop the transcript is written up to some point (in isolated runs it lacked the last
    // tool result and the report; under load it was whole): not reliably complete. By the parent's Stop it is.
    const atSubagentStop = records.find((r) => r.event === "SubagentStop")?.agentTranscript?.lines as Line[];
    expect(conversation(entries).slice(0, conversation(atSubagentStop).length)).toEqual(conversation(atSubagentStop));
    expect(records.find((r) => r.event === "Stop")?.subagents).toEqual({ [`agent-${agentId}.jsonl`]: entries.length });

    // The parent's transcript: the Agent result carries the report, and names the sub-agent in toolUseResult.
    const parent = lines(parentTranscript) as (Line & { toolUseResult?: Record<string, unknown> })[];
    const handBack = parent.find((l) => l.toolUseResult?.["agentId"] === agentId);
    expect(handBack?.toolUseResult).toMatchObject({ status: "completed", agentId, agentType: "general-purpose", content: [{ type: "text", text: "REPLY-4e0 the budget is three." }] });
    expect(JSON.stringify(handBack?.message?.content)).toContain("[Subagent hand-back]");
    expect(JSON.stringify(handBack?.message?.content)).toContain("REPLY-4e0 the budget is three.");

    evidence["foreground"] = sanitize(
      { hooks: seen, SubagentStart: start, SubagentStop: stop, meta, transcript: { path: agentTranscript, conversation: conversation(entries), atSubagentStop: conversation(atSubagentStop), linesAtParentStop: records.find((r) => r.event === "Stop")?.subagents }, parentToolUseResult: handBack?.toolUseResult },
      [...placeholders, [agentId, "<agent>"]],
    );
  }, 90_000);

  test("what reaches the sub-agent's model: SubagentStart additionalContext does, in each of its requests; plain stdout does not, nor the parent's SessionStart context", async () => {
    const json = await spawnSubagent({
      background: false,
      outputs: {
        PreToolUse: { stdout: ALLOW },
        SessionStart: { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "PARENT-CTX-4e0" } }) },
        SubagentStart: { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "SUBAGENT-CTX-4e0" }, systemMessage: "SUBAGENT-SYSMSG-4e0" }) },
      },
    });
    const sub = json.stub.requests.filter(fromSubagent);
    const parent = json.stub.requests.filter((r) => !fromSubagent(r));
    expect(sub.length).toBe(3);
    for (const request of sub) {
      const text = JSON.stringify(request);
      expect(text).toContain("SubagentStart hook additional context: SUBAGENT-CTX-4e0");
      expect(text).not.toContain("PARENT-CTX-4e0");
    }
    // Delivered as a role:"system" message after the parent's prompt for it.
    const messages = (sub[0]?.["messages"] ?? []) as { role: string; content: { text?: string }[] }[];
    expect(messages.map((m) => m.role)).toEqual(["user", "system"]);
    expect(messages[1]?.content[0]?.text).toMatch(/^SubagentStart hook additional context: SUBAGENT-CTX-4e0/);
    expect(parent.every((r) => !JSON.stringify(r).includes("SUBAGENT-CTX-4e0"))).toBe(true);
    expect(JSON.stringify(json.stub.requests)).not.toContain("SUBAGENT-SYSMSG-4e0");

    const plain = await spawnSubagent({ background: false, outputs: { PreToolUse: { stdout: ALLOW }, SubagentStart: { stdout: "SUBAGENT-PLAIN-4e0" } } });
    expect(plain.stub.requests.filter(fromSubagent).length).toBe(3);
    expect(JSON.stringify(plain.stub.requests)).not.toContain("SUBAGENT-PLAIN-4e0");

    evidence["subagentSees"] = {
      subagentStartAdditionalContext: { reachesSubagent: true, everyRequest: true, role: "system", prefix: "SubagentStart hook additional context: ", reachesParent: false },
      subagentStartPlainStdout: { reachesSubagent: false },
      subagentStartSystemMessage: { reachesModel: false },
      parentSessionStartContext: { reachesSubagent: false },
    };
  }, 90_000);

  test("background (the default): the parent's Stop runs while the sub-agent works, the report comes back as a task-notification prompt, and a Debrief call without a PreToolUse allow is not run", async () => {
    const { rig, sessionId, project, placeholders } = await spawnSubagent({ background: true, outputs: {} });
    const records = rig.records();
    const events = records.map((r) => r.event);
    const stops = records.filter((r) => r.event === "Stop");
    expect(stops).toHaveLength(2);
    expect(events.indexOf("Stop")).toBeLessThan(events.indexOf("SubagentStop"));
    expect(stops[0]?.payload?.["background_tasks"]).toEqual([{ id: expect.stringMatching(/^a[0-9a-f]{16}$/) as unknown, type: "subagent", status: "running", description: "retry budget", agent_type: "general-purpose" }]);
    expect(stops[1]?.payload?.["background_tasks"]).toEqual([]);
    // The sub-agent's report reaches the parent as a prompt the host submitted: UserPromptSubmit fires for it.
    const prompts = records.filter((r) => r.event === "UserPromptSubmit").map((r) => String(r.payload?.["prompt"]));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe(PARENT_PROMPT);
    expect(prompts[1]).toMatch(/^<task-notification>\n<task-id>a[0-9a-f]{16}<\/task-id>\n/);
    expect(prompts[1]).toContain("<result>REPLY-4e0 the budget is three.</result>");
    const agentId = String(records.find((r) => r.event === "SubagentStart")?.payload?.["agent_id"]);
    // In the transcript that prompt is marked as the host's, not a person's; the Agent result is only a launch receipt.
    const parent = lines(join(project, `${sessionId}.jsonl`)) as (Line & { toolUseResult?: Record<string, unknown> })[];
    expect(parent.filter((l) => l.type === "user" && typeof l.message?.content === "string").map((l) => l.origin)).toEqual([undefined, { kind: "task-notification" }]);
    expect(parent.find((l) => l.toolUseResult?.["agentId"] === agentId)?.toolUseResult).toMatchObject({ isAsync: true, status: "async_launched", agentId });
    const meta = JSON.parse(readFileSync(join(project, sessionId, "subagents", `agent-${agentId}.meta.json`), "utf8")) as Record<string, unknown>;
    expect(meta["requestShape"]).toBe("background");

    // With no allow from PreToolUse, the sub-agent's Debrief call is not run in -p (no PostToolUse, no result in its transcript).
    expect(records.filter((r) => r.payload?.["tool_name"] === "mcp__debrief__memory_recall").map((r) => r.event)).toEqual(["PreToolUse"]);
    const results = lines(join(project, sessionId, "subagents", `agent-${agentId}.jsonl`)).filter((l) => l.type === "user" && JSON.stringify(l.message?.content).includes('"scope"'));
    expect(results).toEqual([]);
    expect(existsSync(join(project, sessionId, "subagents", `agent-${agentId}.jsonl`))).toBe(true);

    evidence["background"] = sanitize({ hooks: events, firstStop: stops[0]?.payload, taskNotification: prompts[1], meta, debriefCallWithoutAllow: "not run" }, [...placeholders, [agentId, "<agent>"]]);
  }, 90_000);
});
