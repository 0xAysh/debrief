import type { HookFailure } from "../import/hook-failures.js";
import { summarizeCheckpoint } from "../integrity/checkpoints.js";
import type { PreferenceBlock } from "../integrity/preferences.js";
import type { BootstrapResult, ContextPack } from "../memory.js";
import type { Returned } from "../storage/call-log.js";
import { age, checkpointLabel, itemLabel } from "./label.js";

/**
 * Session-start context as text: what a host's session-start hook injects, built from the same
 * bootstrap result `memory_bootstrap` returns. Two outputs, for two readers: `context` for the
 * model, and `notice`, one line for the user.
 *
 * It carries what applies to every task (how to use Debrief, the user's preferences, questions
 * waiting for the user) and one line pointing at work memory, never the work itself: Debrief
 * cannot know what the user will ask, so the agent recalls per task (the protocol says so), and
 * `memory_bootstrap` returns the checkpoint and the turns no checkpoint covers.
 *
 * Fail open, never silently: memory that could not be read says so and tells the agent not to
 * assume there is none, and an empty workspace says it is empty. The two never look alike.
 */

/** Claude Code caps hook context at 10,000 characters; this leaves room for its own framing. */
export const SESSION_CONTEXT_CHARS = 9_000;
/** The checkpoint's goal in the pointer, which stays one line of at most 300 characters. */
const POINTER_GOAL_CHARS = 80;
/** One item's text in the list; `memory_read` has the rest. */
const ITEM_CHARS = 300;
/** Capture failures this recent are news to the user at session start. */
const FAILURE_WINDOW_MS = 24 * 3_600_000;

export interface SessionStart {
  context: string;
  notice: string;
  /** The error code when memory could not be loaded (the context then says so; also on record as a hook failure). */
  failure: string | null;
  /** The records the context shows, in order (for the call log): what the caps cut is not among them. */
  records: Shown[];
}

export type Shown = Omit<Returned, "position">;

/** A sub-agent's start: context for its model only (the user sees the parent's session start). */
export interface SubagentStart {
  context: string;
  /** The error code when memory could not be loaded (the context then says so; also on record as a hook failure). */
  failure: string | null;
  /** The records the context shows, in order (for the call log). */
  records: Shown[];
}

/**
 * A sub-agent's share, well under the session start's: it needs where the task stands, not the
 * session's history. The checkpoint gets up to 1,500 characters, preferences what they take
 * (normally a few lines), and items the rest.
 */
export const SUBAGENT_CONTEXT_CHARS = 4_000;
const SUBAGENT_CHECKPOINT_CHARS = 1_500;
const SUBAGENT_GUIDE =
  "Debrief is the working memory of the session that started you (you are its sub-agent). The checkpoint below is where the task stands; the parent session keeps it, so do not call memory_checkpoint. What you do is kept from your transcript: put what you found in your final report. memory_recall has more.";

/** What a Stop hook says: a request to the agent to update a stale checkpoint, and a line for the user. */
export interface TurnEnd {
  nudge: string | null;
  notice: string | null;
  /** Why the turn was not saved (also on record as a hook failure). */
  failure: { code: string; message: string } | null;
  /** Why the saved turn's nudge could not be worked out, so none was given (also on record as a hook failure). */
  nudgeFailure: { code: string; message: string } | null;
}

/** A one-line notice for the user (a hook's `systemMessage`), never shown to the model. */
export function userNotice(...parts: string[]): string {
  return ["◪ debrief", ...parts].join(" · ");
}

/** `workRecords`: how many records recall can reach here, preferences aside; read only when there is no checkpoint or last session to name. */
export function renderSessionStart(boot: BootstrapResult, input: { protocol: string; failures: readonly HookFailure[]; now: Date; workRecords: number }): SessionStart {
  const { scope, context: pack, preferences, import: imported } = boot;
  const parts: string[] = [`# Debrief: ${scope.workspaceLabel} / ${scope.workstreamLabel ?? "(no workstream bound)"}, head r${scope.headRevision}`, input.protocol];

  if (scope.ambiguity !== null) parts.push(`## Workstream to confirm\n${scope.ambiguity.question}\nAsk the user, then call memory_bootstrap with workstream = their choice.`);
  if (imported.state === "consent_required" && imported.question !== null) parts.push(`## Transcript import needs the user's answer\n${imported.question}\nAsk the user verbatim, then call memory_bootstrap with importChoice = their answer.`);

  // Questions for the user come before anything long, so no cut can drop them.
  const question = preferences.pending[0];
  if (question !== undefined) parts.push(`## Preference question for the user\n${question.question}\nChoices: ${question.choices.map((c) => c.label).join(" / ")}. Relay their answer with memory_manage answer_preference.`);

  const pointed = pointer(boot, input.workRecords, input.now);
  if (pointed !== null) parts.push(pointed);
  if (preferences.items.length > 0) parts.push(preferencesSection(preferences));

  const empty = pack.empty && preferences.items.length === 0 && boot.lastSession === null;
  if (empty) {
    parts.push(
      boot.created.workspace
        ? "No memory for this repository yet. Record decisions, failed attempts and next steps with memory_record as they happen, and call memory_checkpoint before finishing."
        : "No memory for this workstream yet.",
    );
  }

  let text = parts.join("\n\n");
  if (text.length > SESSION_CONTEXT_CHARS) text = text.slice(0, SESSION_CONTEXT_CHARS - CUT.length) + CUT;
  const records = preferences.items.map((p) => ({ id: p.recordId, kind: "preference", freshness: null }));
  return { context: text, notice: notice(boot, empty, input), failure: null, records };
}

/**
 * One line pointing at the work memory of this line of work, when there is some: the head
 * checkpoint (revision, age, goal) and whether the last session ended without one, which
 * `memory_bootstrap` returns; else how many records `memory_recall` can reach. Null when there is
 * nothing to point at.
 */
function pointer(boot: BootstrapResult, records: number, now: Date): string | null {
  const { checkpoint } = boot.context;
  const last = boot.lastSession;
  const fetch = "Call memory_bootstrap before continuing this work.";
  if (checkpoint !== null) {
    const goal = summarizeCheckpoint(checkpoint.excerpt).goal;
    const named = goal === null ? "" : ` ("${oneLine(goal, POINTER_GOAL_CHARS)}")`;
    const crashed = last === null ? "" : `; the last session ended without one (turns after r${checkpoint.revision})`;
    return `Memory for this line of work: checkpoint r${checkpoint.revision}${named}, ${ago(checkpoint.createdAt, now)}${crashed}. ${fetch}`;
  }
  if (last !== null) return `Memory for this line of work: no checkpoint; the last session (${oneLine(last.host, 40)}, ${ago(last.endedAt, now)}) ended without one. ${fetch}`;
  return records === 0 ? null : `${records} record${records === 1 ? "" : "s"} for this line of work: memory_recall when the task needs them.`;
}

function ago(iso: string, now: Date): string {
  const elapsed = age(iso, now);
  return elapsed === "now" ? "just now" : `${elapsed} ago`;
}

/**
 * What a sub-agent starts with (a host's sub-agent-start hook): the head checkpoint, confirmed
 * preferences and labelled items, from the session that started it. No protocol and no digest
 * (the parent has them), and nothing meant for the user (import consent, a workstream to
 * confirm, preference questions): a sub-agent cannot ask them.
 */
export function renderSubagentStart(input: { scope: BootstrapResult["scope"]; pack: ContextPack; preferences: PreferenceBlock; newWorkspace: boolean; now: Date }): SubagentStart {
  const { scope, pack, preferences } = input;
  const fixed: string[] = [`# Debrief: ${scope.workspaceLabel} / ${scope.workstreamLabel ?? "(no workstream bound)"}, head r${scope.headRevision}`, SUBAGENT_GUIDE];
  if (pack.checkpoint !== null) fixed.push(checkpointSection(pack.checkpoint, SUBAGENT_CHECKPOINT_CHARS, input.now));
  if (preferences.items.length > 0) fixed.push(preferencesSection(preferences));
  if (pack.empty && preferences.items.length === 0) fixed.push(input.newWorkspace ? "No memory for this repository yet." : "No memory for this workstream yet.");
  const listed = new Set(preferences.items.map((p) => p.recordId));
  const { text, shown } = withItems(fixed.join("\n\n"), pack, listed, SUBAGENT_CONTEXT_CHARS, SUBAGENT_CUT, input.now);
  const records = [...checkpointShown(pack), ...preferences.items.map((p) => ({ id: p.recordId, kind: "preference", freshness: null })), ...shown];
  return { context: text, failure: null, records };
}

function checkpointShown(pack: ContextPack): Shown[] {
  return pack.checkpoint === null ? [] : [{ id: pack.checkpoint.recordId, kind: "checkpoint", freshness: pack.checkpoint.freshness }];
}

function checkpointSection(checkpoint: NonNullable<ContextPack["checkpoint"]>, maxChars: number, now: Date): string {
  const warning = checkpoint.warning === null ? "" : `\n⚠ ${checkpoint.warning}`;
  const body = checkpoint.excerpt.length <= maxChars ? checkpoint.excerpt : `${checkpoint.excerpt.slice(0, maxChars)}… (memory_read ${checkpoint.recordId} for all of it)`;
  return `## Checkpoint [${checkpointLabel(checkpoint, now)}]\n${body}${warning}`;
}

function preferencesSection(preferences: PreferenceBlock): string {
  return `## Preferences (${preferences.note})\n${preferences.items.map((p) => `- ${p.text}`).join("\n")}`;
}

/** Items fill what the fixed parts leave, up to `cap`; whatever does not fit is named, never silently dropped. */
function withItems(fixed: string, pack: ContextPack, listed: ReadonlySet<string>, cap: number, cut: string, now: Date): { text: string; shown: Shown[] } {
  let text = fixed;
  const shown: Shown[] = [];
  const items = pack.items.filter((item) => !listed.has(item.recordId));
  if (items.length > 0) {
    text += "\n\n## Recent memory";
    for (const item of items) {
      const body = oneLine(item.title ?? item.excerpt, ITEM_CHARS);
      const warning = item.warning === null ? "" : `\n  ⚠ ${item.warning}`;
      const line = `\n- [${itemLabel(item, now)}] ${body} (${item.recordId})${warning}`;
      if (text.length + line.length + TAIL_RESERVE > cap) break;
      text += line;
      shown.push({ id: item.recordId, kind: item.kind, freshness: item.freshness });
    }
  }
  const hidden = items.length - shown.length + pack.omissions.reduce((n, o) => n + o.count, 0);
  if (hidden > 0) text += `\n${hidden} more not shown: use memory_recall.`;
  if (text.length > cap) text = text.slice(0, cap - cut.length) + cut;
  return { text, shown };
}

/** Room kept for the "N more not shown" line. */
const TAIL_RESERVE = 60;
const CUT = "\n[cut by Debrief to fit session-start context: call memory_bootstrap for all of it]";
const SUBAGENT_CUT = "\n[cut by Debrief to fit sub-agent context: use memory_recall for the rest]";

/** A sub-agent cannot tell the user; its parent's session start already did, and its report can. */
export function unreadableSubagentStart(code: string): SubagentStart {
  return { context: `Memory could not be loaded (${code}). Do not assume this project has none; say so in your report.`, failure: code, records: [] };
}

export function unreadableSessionStart(code: string): SessionStart {
  return {
    context: `Memory could not be loaded (${code}). Do not assume this project has none. Tell the user, and do not rely on memory tools this session unless memory_status reports storage healthy.`,
    notice: userNotice(`memory could not be loaded (${code})`),
    failure: code,
    records: [],
  };
}

function notice(boot: BootstrapResult, empty: boolean, input: { failures: readonly HookFailure[]; now: Date; workRecords: number }): string {
  const parts: string[] = [];
  const { checkpoint } = boot.context;
  const last = boot.lastSession;
  if (empty) parts.push("no memory yet");
  else {
    if (checkpoint !== null) parts.push(`checkpoint r${checkpoint.revision}`);
    const preferences = boot.preferences.items.length;
    if (preferences > 0) parts.push(`${preferences} preference${preferences === 1 ? "" : "s"}`);
    // Without a checkpoint or a last session to name, the pointer's count is what the agent was told.
    const records = checkpoint === null && last === null ? input.workRecords : 0;
    if (records > 0) parts.push(`${records} record${records === 1 ? "" : "s"}`);
  }
  if (last !== null && checkpoint === null) parts.push(`last session ended without a checkpoint (${last.host})`);
  else if (last !== null && checkpoint !== null) parts.push(`turns after r${checkpoint.revision} not checkpointed`);
  if (boot.import.state === "consent_required") parts.push("transcript import needs your answer");
  if (boot.scope.ambiguity !== null) parts.push("workstream to confirm");
  const recent = input.failures.filter((f) => input.now.getTime() - Date.parse(f.at) < FAILURE_WINDOW_MS);
  const latest = recent.at(-1);
  if (latest !== undefined) parts.push(`⚠ ${recent.length} hook failure${recent.length === 1 ? "" : "s"} (${latest.code}): debrief diag status`);
  return userNotice(...parts);
}

/** `text` on one line, cut to `max` characters with an ellipsis. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
