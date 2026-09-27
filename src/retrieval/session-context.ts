import type { CaptureFailure } from "../import/capture-failures.js";
import type { BootstrapResult } from "../memory.js";
import { checkpointLabel, itemLabel } from "./label.js";

/**
 * Session-start context as text: what a host's session-start hook injects, built from the same
 * bootstrap result `memory_bootstrap` returns. Two outputs, for two readers: `context` for the
 * model, and `notice`, one line for the user.
 *
 * Fail open, never silently: memory that could not be read says so and tells the agent not to
 * assume there is none, and an empty workspace says it is empty. The two never look alike.
 */

/** Claude Code caps hook context at 10,000 characters; this leaves room for its own framing. */
export const SESSION_CONTEXT_CHARS = 9_000;
/** One item's text in the list; `memory_read` has the rest. */
const ITEM_CHARS = 300;
/** Capture failures this recent are news to the user at session start. */
const FAILURE_WINDOW_MS = 24 * 3_600_000;

export interface SessionStart {
  context: string;
  notice: string;
}

export function renderSessionStart(boot: BootstrapResult, input: { protocol: string; failures: readonly CaptureFailure[]; now: Date }): SessionStart {
  const { scope, context: pack, preferences, import: imported } = boot;
  const fixed: string[] = [`# Memchor: ${scope.workspaceLabel} / ${scope.workstreamLabel ?? "(no workstream bound)"}, head r${scope.headRevision}`, input.protocol];

  if (scope.ambiguity !== null) fixed.push(`## Workstream to confirm\n${scope.ambiguity.question}\nAsk the user, then call memory_bootstrap with workstream = their choice.`);
  if (imported.state === "consent_required" && imported.question !== null) fixed.push(`## Transcript import needs the user's answer\n${imported.question}\nAsk the user verbatim, then call memory_bootstrap with importChoice = their answer.`);

  if (pack.checkpoint !== null) {
    const warning = pack.checkpoint.warning === null ? "" : `\n⚠ ${pack.checkpoint.warning}`;
    fixed.push(`## Checkpoint [${checkpointLabel(pack.checkpoint, input.now)}]\n${pack.checkpoint.excerpt}${warning}`);
  }
  if (preferences.items.length > 0) fixed.push(`## Preferences (${preferences.note})\n${preferences.items.map((p) => `- ${p.text}`).join("\n")}`);
  const question = preferences.pending[0];
  if (question !== undefined) fixed.push(`## Preference question for the user\n${question.question}\nChoices: ${question.choices.map((c) => c.label).join(" / ")}. Relay their answer with memory_manage answer_preference.`);

  const empty = pack.empty && preferences.items.length === 0;
  if (empty) {
    fixed.push(
      boot.created.workspace
        ? "No memory for this repository yet. Record decisions, failed attempts and next steps with memory_record as they happen, and call memory_checkpoint before finishing."
        : "No memory for this workstream yet.",
    );
  }

  // Items fill what the fixed parts leave; whatever does not fit is named, never silently dropped.
  let text = fixed.join("\n\n");
  let shown = 0;
  // Preferences are listed above; the pack carries them too.
  const listed = new Set(preferences.items.map((p) => p.recordId));
  const items = pack.items.filter((item) => !listed.has(item.recordId));
  if (items.length > 0) {
    text += "\n\n## Recent memory";
    for (const item of items) {
      const body = oneLine(item.title ?? item.excerpt, ITEM_CHARS);
      const warning = item.warning === null ? "" : `\n  ⚠ ${item.warning}`;
      const line = `\n- [${itemLabel(item, input.now)}] ${body} (${item.recordId})${warning}`;
      if (text.length + line.length + TAIL_RESERVE > SESSION_CONTEXT_CHARS) break;
      text += line;
      shown++;
    }
  }
  const hidden = items.length - shown + pack.omissions.reduce((n, o) => n + o.count, 0);
  if (hidden > 0) text += `\n${hidden} more not shown: use memory_recall.`;

  if (text.length > SESSION_CONTEXT_CHARS) text = text.slice(0, SESSION_CONTEXT_CHARS - CUT.length) + CUT;
  return { context: text, notice: notice(boot, shown, empty, input) };
}

/** Room kept for the "N more not shown" line. */
const TAIL_RESERVE = 60;
const CUT = "\n[cut by Memchor to fit session-start context: call memory_bootstrap for all of it]";

export function unreadableSessionStart(code: string): SessionStart {
  return {
    context: `Memory could not be loaded (${code}). Do not assume this project has none. Tell the user, and do not rely on memory tools this session unless memory_status reports storage healthy.`,
    notice: `◪ memchor · memory could not be loaded (${code})`,
  };
}

function notice(boot: BootstrapResult, shown: number, empty: boolean, input: { failures: readonly CaptureFailure[]; now: Date }): string {
  const parts = ["◪ memchor"];
  if (empty) parts.push("no memory yet");
  else {
    if (boot.context.checkpoint !== null) parts.push(`checkpoint r${boot.context.checkpoint.revision} loaded`);
    const preferences = boot.preferences.items.length;
    if (preferences > 0) parts.push(`${preferences} preference${preferences === 1 ? "" : "s"}`);
    parts.push(`${shown} item${shown === 1 ? "" : "s"}`);
  }
  if (boot.import.state === "consent_required") parts.push("transcript import needs your answer");
  if (boot.scope.ambiguity !== null) parts.push("workstream to confirm");
  const recent = input.failures.filter((f) => input.now.getTime() - Date.parse(f.at) < FAILURE_WINDOW_MS);
  const last = recent.at(-1);
  if (last !== undefined) parts.push(`⚠ ${recent.length} capture failure${recent.length === 1 ? "" : "s"} (${last.code}): memchor diag status`);
  return parts.join(" · ");
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
