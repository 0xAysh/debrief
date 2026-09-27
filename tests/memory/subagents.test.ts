import { appendFileSync, rmSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { type ManageResult, type Memory, openMemory, type PackItem } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, claudeDelegatedTurn, claudeTurn, installSubagent, installTranscript } from "../import/fixtures.js";

/**
 * Sub-agents at seam ③: a Claude Code session whose turn delegates to a sub-agent, in hand-written
 * 2.1.283 transcripts (the parent's, and the sub-agent's under `<session>/subagents/`), imported
 * the way the parent's Stop hook and a later session start import them.
 */

const PARENT = "e0d00000-0000-4000-8000-0000000000c1";
const AGENT = "a40000000000000c1";
const FINDING = "SYNTHETIC-FINDING the retry budget is 3 attempts";
const REPORT = "SYNTHETIC-REPORT The retry budget is three attempts, set in retry.ts.";
const SUBAGENT_PROMPT = "SYNTHETIC-DELEGATED find where the retry budget is set";

function workspace() {
  const repo = initRepo({ branch: "fix/double-charge" });
  const home = tempDir();
  const config = claudeConfigDir();
  const open = (hostSessionId?: string): Memory => {
    const memory = openMemory({ cwd: repo, home, host: "claude-code", claudeConfigDir: config, ...(hostSessionId === undefined ? {} : { hostSessionId }) });
    onCleanup(() => {
      memory.close();
    });
    return memory;
  };
  const setup = open();
  setup.bootstrap({ importChoice: "current_project" });
  setup.close();
  return { repo, home, config, open };
}

/** A session whose one turn delegated to a sub-agent that ran a command; both transcripts on disk. */
function delegated(options: { background?: boolean; subagent?: boolean } = {}) {
  const w = workspace();
  const at = new Date(Date.now() - 60_000);
  const turn = claudeDelegatedTurn({ cwd: w.repo, sessionId: PARENT, n: 1, at, prompt: "SYNTHETIC-USER-PROMPT check the retry budget with a helper", agentId: AGENT, subagentPrompt: SUBAGENT_PROMPT, report: REPORT, ...(options.background === undefined ? {} : { background: options.background }) });
  const parent = installTranscript(w.config, "", { cwd: w.repo, sessionId: PARENT, content: turn.lines });
  const subagent = options.subagent === false ? null : installSubagent(w.config, { cwd: w.repo, sessionId: PARENT, agentId: AGENT, toolUseId: turn.toolUseId, at: new Date(at.getTime() + 100), prompt: SUBAGENT_PROMPT, command: "grep -rn budget src", output: FINDING, report: REPORT });
  return { ...w, parent: parent.path, subagent: subagent?.path ?? null, last: turn.last };
}

function recalled(memory: Memory, query: string, marker: string): PackItem[] {
  return memory.recall({ query, maxTokens: 8_000 }).items.filter((item) => item.excerpt.includes(marker));
}

describe("a sub-agent's work is kept under the session that started it", () => {
  test("the parent's Stop capture imports its sub-agents' transcripts: same workstream and session, each record naming the sub-agent", () => {
    const s = delegated();
    const ended = s.open().endTurn({ transcriptPath: s.parent });
    expect(ended.failure).toBeNull();
    const memory = s.open();
    const [finding] = recalled(memory, "retry budget attempts", "SYNTHETIC-FINDING");
    expect(finding?.attribution).toBe("direct_observation");
    expect(finding?.source).toMatchObject({ kind: "transcript", host: "claude-code", transcriptId: `${PARENT}/agent-${AGENT}`, branch: AGENT, agentType: "general-purpose" });
    const [prompt] = recalled(memory, "SYNTHETIC-USER-PROMPT retry budget helper", "SYNTHETIC-USER-PROMPT");
    expect(prompt?.source).toMatchObject({ transcriptId: PARENT, branch: "main", agentType: null });
    // One session: the sub-agent's records are the parent session's, in its workstream.
    expect(finding?.sessionId).toBe(prompt?.sessionId);
    expect(memory.status().scope?.workstreamId).toBeDefined();
    expect(ended.notice).toMatch(/saved turn \((\d+) events\)/);
  });

  test("a session start's catch-up import finds sub-agent transcripts too, and the consent question counts sessions, not sub-agents", () => {
    const repo = initRepo({ branch: "fix/double-charge" });
    const home = tempDir();
    const config = claudeConfigDir();
    const at = new Date(Date.now() - 60_000);
    const turn = claudeDelegatedTurn({ cwd: repo, sessionId: PARENT, n: 1, at, prompt: "Check the retry budget.", agentId: AGENT, subagentPrompt: SUBAGENT_PROMPT, report: REPORT });
    installTranscript(config, "", { cwd: repo, sessionId: PARENT, content: turn.lines });
    installSubagent(config, { cwd: repo, sessionId: PARENT, agentId: AGENT, toolUseId: turn.toolUseId, at, prompt: SUBAGENT_PROMPT, command: "grep -rn budget src", output: FINDING, report: REPORT });
    const memory = openMemory({ cwd: repo, home, host: "claude-code", claudeConfigDir: config });
    onCleanup(() => {
      memory.close();
    });
    expect(memory.bootstrap().import.question).toContain("Memchor found 1 local Claude Code sessions (1 in this project,");
    memory.bootstrap({ importChoice: "current_project" });
    expect(recalled(memory, "retry budget attempts", "SYNTHETIC-FINDING")).toHaveLength(1);
  });

  test("the prompt a sub-agent was given is the parent agent's: never user_direction, not a user prompt in the digest, not a turn for the nudge", () => {
    const w = workspace();
    // Four turns of work with commands, the fourth delegating: with the sub-agent's prompt counted as the user's, this would be the fifth prompt and nudge.
    let after: string | null = null;
    const { path } = installTranscript(w.config, "", { cwd: w.repo, sessionId: PARENT, content: "" });
    const base = Date.now() - 3_600_000;
    for (let n = 1; n <= 3; n++) {
      const turn = claudeTurn({ cwd: w.repo, sessionId: PARENT, n, at: new Date(base + n * 60_000), prompt: `SYNTHETIC-STEP ${n}.`, command: "npm test", after });
      after = turn.last;
      appendFileSync(path, turn.lines);
      expect(w.open().endTurn({ transcriptPath: path }).nudge).toBeNull();
    }
    const turn = claudeDelegatedTurn({ cwd: w.repo, sessionId: PARENT, n: 4, at: new Date(base + 4 * 60_000), prompt: "SYNTHETIC-STEP 4.", agentId: AGENT, subagentPrompt: SUBAGENT_PROMPT, report: REPORT, after });
    appendFileSync(path, turn.lines);
    installSubagent(w.config, { cwd: w.repo, sessionId: PARENT, agentId: AGENT, toolUseId: turn.toolUseId, at: new Date(base + 4 * 60_000 + 100), prompt: SUBAGENT_PROMPT, command: "grep -rn budget src", output: FINDING, report: REPORT });
    expect(w.open().endTurn({ transcriptPath: path }).nudge).toBeNull();

    const memory = w.open();
    const [prompt] = recalled(memory, "SYNTHETIC-DELEGATED retry budget", "SYNTHETIC-DELEGATED");
    expect(prompt?.attribution).toBe("agent_inference");
    expect(prompt?.source?.agentType).toBe("general-purpose");
    const context = memory.sessionStart()?.context ?? "";
    const digestLines = context.split("User prompts:\n")[1]?.split("\n") ?? [];
    const prompts = digestLines.slice(0, digestLines.findIndex((line) => !line.startsWith("- ")));
    expect(prompts).toEqual(["- SYNTHETIC-STEP 2.", "- SYNTHETIC-STEP 3.", "- SYNTHETIC-STEP 4."]);
    // It can be an item of memory, labelled as the sub-agent's, never one of the user's prompts.
    expect(context).toMatch(/- \[evidence · \d+m · claude-code\/general-purpose · \w+\] SYNTHETIC-DELEGATED find where the retry budget is set/);
    // The sub-agent's command is the session's work.
    expect(context).toMatch(/Commands: .*✓ grep -rn budget src/);
  });

  test("the report counts once: the parent's copy of it (the Agent result) is left out while the sub-agent's transcript is on disk, and kept when it is not", () => {
    const s = delegated();
    s.open().endTurn({ transcriptPath: s.parent });
    const memory = s.open();
    const reports = recalled(memory, "retry budget three attempts retry.ts", "SYNTHETIC-REPORT");
    expect(reports.map((r) => [r.source?.transcriptId, r.attribution])).toEqual([[`${PARENT}/agent-${AGENT}`, "agent_inference"]]);
    expect(reports[0]?.corroboration).toEqual({ independentRoots: 1, records: 1 });

    const alone = delegated({ subagent: false });
    alone.open().endTurn({ transcriptPath: alone.parent });
    const kept = recalled(alone.open(), "retry budget three attempts retry.ts", "SYNTHETIC-REPORT");
    expect(kept.map((r) => [r.source?.transcriptId, r.attribution])).toEqual([[PARENT, "direct_observation"]]);
  });

  test("in the background, neither the launch receipt nor the host's task-notification is stored, even when the parent stops before the sub-agent's transcript is written; the report comes from that transcript", () => {
    const s = delegated({ background: true, subagent: false });
    // Pinned: at the parent's first Stop a background sub-agent's transcript is not on disk yet.
    s.open().endTurn({ transcriptPath: s.parent });
    installSubagent(s.config, { cwd: s.repo, sessionId: PARENT, agentId: AGENT, toolUseId: "toolu_agent_1", at: new Date(), prompt: SUBAGENT_PROMPT, command: "grep -rn budget src", output: FINDING, report: REPORT });
    s.open().endTurn({ transcriptPath: s.parent });
    const memory = s.open();
    expect(recalled(memory, "Async agent launched successfully", "Async agent launched")).toEqual([]);
    expect(recalled(memory, "retry budget three attempts retry.ts", "SYNTHETIC-REPORT").map((r) => r.source?.transcriptId)).toEqual([`${PARENT}/agent-${AGENT}`]);
  });

  test("a Stop hook cannot name a sub-agent's transcript itself: it is imported only with its session", () => {
    const s = delegated();
    expect(s.open().captureTurn({ transcriptPath: s.subagent ?? "" })).toMatchObject({ state: "skipped", reason: "not_a_transcript" });
    expect(recalled(s.open(), "retry budget attempts", "SYNTHETIC-FINDING")).toEqual([]);
  });

  test("a sub-agent's transcript gets the main transcript's privacy rules: <private> spans, secrets and oversized output", () => {
    const w = workspace();
    const at = new Date(Date.now() - 60_000);
    const turn = claudeDelegatedTurn({ cwd: w.repo, sessionId: PARENT, n: 1, at, prompt: "Check the retry budget.", agentId: AGENT, subagentPrompt: `${SUBAGENT_PROMPT} <private>SYNTHETIC-HIDDEN staging host</private>`, report: REPORT });
    const parent = installTranscript(w.config, "", { cwd: w.repo, sessionId: PARENT, content: turn.lines });
    const output = `SYNTHETIC-FINDING token ghp_${"a1B2c3D4e5".repeat(4)} ${"retry line ".repeat(2_000)}`;
    installSubagent(w.config, { cwd: w.repo, sessionId: PARENT, agentId: AGENT, toolUseId: turn.toolUseId, at, prompt: `${SUBAGENT_PROMPT} <private>SYNTHETIC-HIDDEN staging host</private>`, command: "grep -rn budget src", output, report: REPORT });
    w.open().endTurn({ transcriptPath: parent.path });
    const memory = w.open();
    const [prompt] = recalled(memory, "SYNTHETIC-DELEGATED retry budget", "SYNTHETIC-DELEGATED");
    expect(prompt?.excerpt).toContain("[private]");
    expect(prompt?.excerpt).not.toContain("SYNTHETIC-HIDDEN");
    const [finding] = recalled(memory, "retry budget SYNTHETIC-FINDING", "SYNTHETIC-FINDING");
    const body = memory.read({ recordId: finding?.recordId ?? "", maxBytes: 32_000 }).body;
    expect(body).toContain("[redacted:");
    expect(body).not.toContain("ghp_a1B2");
    expect(body).toMatch(/\[… [\d,]+ bytes omitted by Memchor …\]/);
  });

  test("the digest's last reply is the session's own agent, not a sub-agent or the prompt it was given", () => {
    const s = delegated({ background: true });
    const context = (() => {
      s.open().endTurn({ transcriptPath: s.parent });
      return s.open().sessionStart()?.context ?? "";
    })();
    expect(context).toContain("Last reply: Done with turn 1.");
  });
});

describe("\"don't remember this session\" in the parent covers its sub-agents", () => {
  function markPrivate(memory: Memory): Extract<ManageResult, { action: "private_session" }> {
    const result = memory.manage({ action: "private_session" });
    if (result.action !== "private_session") throw new Error("unreachable");
    return result;
  }

  test("what its sub-agents' transcripts brought in is forgotten, and a later import pass does not bring it back", () => {
    const s = delegated();
    s.open().endTurn({ transcriptPath: s.parent });
    expect(recalled(s.open(), "retry budget attempts", "SYNTHETIC-FINDING")).toHaveLength(1);
    const live = s.open(PARENT);
    live.bootstrap();
    markPrivate(live);
    const after = s.open();
    after.bootstrap();
    after.endTurn({ transcriptPath: s.parent });
    expect(recalled(after, "retry budget three attempts SYNTHETIC", "SYNTHETIC")).toEqual([]);
  });

  test("its sub-agents' records are forgotten even when the session's own transcript was never imported", () => {
    const s = delegated();
    // The parent's transcript is gone (retention, a moved config): catch-up import still finds the sub-agent's.
    rmSync(s.parent);
    s.open().bootstrap();
    expect(recalled(s.open(), "retry budget attempts", "SYNTHETIC-FINDING")).toHaveLength(1);
    const live = s.open(PARENT);
    live.bootstrap();
    expect(markPrivate(live).forgotten.length).toBeGreaterThan(0);
    expect(recalled(s.open(), "retry budget three attempts SYNTHETIC", "SYNTHETIC")).toEqual([]);
  });

  test("a sub-agent transcript that appears after the marking is never imported", () => {
    const s = delegated({ subagent: false });
    const live = s.open(PARENT);
    live.bootstrap();
    markPrivate(live);
    const later = installSubagent(s.config, { cwd: s.repo, sessionId: PARENT, agentId: AGENT, toolUseId: "toolu_agent_1", at: new Date(), prompt: SUBAGENT_PROMPT, command: "grep -rn budget src", output: FINDING, report: REPORT });
    const memory = s.open();
    expect(memory.endTurn({ transcriptPath: s.parent }).failure).toBeNull();
    memory.bootstrap();
    expect(recalled(memory, "retry budget attempts", "SYNTHETIC-FINDING")).toEqual([]);
    rmSync(later.path);
  });
});
