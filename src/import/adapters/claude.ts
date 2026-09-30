import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  CompatibilityRow,
  ExclusionReason,
  FileRead,
  NormalizedEvent,
  OutputFacts,
  ToolKind,
  TranscriptAdapter,
  TranscriptChunk,
  TranscriptFile,
  TranscriptHead,
} from "../normalized-event.js";
import { claudeConfigDir } from "../../host-plugins.js";
import { asObject, type JsonObject, listDir, parseObject, readLines } from "../jsonl.js";
import { shellCall } from "../shell-reads.js";
import { OPERATION_SCHEMAS } from "../../schemas.js";
import { inCompatibility } from "../versions.js";

/**
 * Claude Code transcripts → normalized events.
 *
 * Location (official docs, https://code.claude.com/docs/en/sessions#where-transcripts-are-stored):
 * `$CLAUDE_CONFIG_DIR/projects/<project>/<session-id>.jsonl`, `CLAUDE_CONFIG_DIR` defaulting to
 * `~/.claude`. `<project>` is the cwd with non-alphanumerics replaced by "-" (truncated and
 * hashed past 200 characters), so it is lossy: the workspace comes from each entry's own `cwd`,
 * never from the directory name. A sub-agent's transcript is
 * `<project>/<session>/subagents/agent-<agentId>.jsonl`, with the kind of agent in the
 * `.meta.json` beside it (pinned in tests/hooks/claude-subagents.test.ts); its id here is
 * `<session>/agent-<agentId>`, and it belongs to that session: discovery lists it, and
 * `subagentsOf` hands it to the capture of its session (a hook never names it). Its final report also appears in
 * the parent's transcript, as the Agent tool's result, which is then left out
 * (`subagent_report`) so the report is one observation. Auto memory (`<project>/memory/`) is not read.
 *
 * Format: one JSON object per line. The docs state that "the entry format is internal to Claude
 * Code and changes between versions", so this adapter reads only the fields below, pins the
 * versions it accepts in {@link COMPATIBILITY}, and stops at the first entry from any other
 * version instead of guessing:
 *
 *   type, uuid, parentUuid, timestamp, cwd, gitBranch, version, isSidechain, agentId, isMeta,
 *   isCompactSummary, origin.kind, subtype, content (system), message.content[] blocks:
 *   text · thinking · redacted_thinking · tool_use{id,name,input} · tool_result{tool_use_id,content,is_error} · image
 *
 * Of `toolUseResult`, only metadata is read, never content: `agentId`/`status` (a sub-agent's
 * hand-back), `type` and `file.{startLine,numLines,totalLines}` (a `Read` window), and
 * `persistedOutputPath`, `isImage`, `interrupted`, `stderr` being empty (whether a shell
 * output reached the model whole). Every other field (usage, wireToolInputs, snapshots, …) is ignored. Unknown entry
 * or block types inside a supported version are skipped and counted (`unsupported_entry`), never
 * interpreted.
 */

export const COMPATIBILITY: readonly CompatibilityRow[] = [
  {
    from: "2.1.183",
    below: "2.2.0",
    format: "claude-code-jsonl-v1",
    basis:
      "Observed on 72 local transcripts written by 2.1.183–2.1.281 (2026-09): the fields read here are present and unchanged across that range; only additive keys differ. Fixtures: tests/import/fixtures/claude-code/{2.1.183,2.1.281,2.1.284}.",
  },
];

/** Entry types that carry host bookkeeping only (titles, modes, file snapshots, costs, links). */
const METADATA_TYPES = new Set([
  "mode",
  "permission-mode",
  "bridge-session",
  "file-history-snapshot",
  "file-history-delta",
  "ai-title",
  "custom-title",
  "last-prompt",
  "atis-latch",
  "queue-operation",
  "cost-state",
  "frame-link",
  "pr-link",
  "agent-name",
  "artifact-comment-monitor",
  "artifact-autoreact-ledger",
  "fork-context-ref",
  "summary",
]);

/** Tools whose results are whole files or edits: only the call (path) is kept. */
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead"]);
/** Debrief's own tools (every operation it offers), under whatever name the user gave the MCP server. */
const DEBRIEF_TOOL = new RegExp(`^mcp__.+__(${Object.keys(OPERATION_SCHEMAS).join("|")})$`);
/** Context Claude Code injects into user turns; not something the user wrote. */
const INJECTED = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** The first entries carry the cwd; this bounds what discovery reads from each transcript. */
const HEAD_BYTES = 64 * 1024;

export function claudeCodeAdapter(options: { configDir?: string } = {}): TranscriptAdapter {
  const configDir = options.configDir ?? claudeConfigDir();
  const root = join(configDir, "projects");
  return {
    host: "claude-code",
    displayName: "Claude Code",
    compatibility: COMPATIBILITY,
    root,
    discover: () => discover(root),
    fileAt: (path) => fileAt(root, path),
    subagentsOf,
    inspect,
    read,
  };
}

function discover(root: string): TranscriptFile[] {
  const files: TranscriptFile[] = [];
  for (const project of listDir(root)) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const entry of listDir(dir)) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const file = statTranscript(join(dir, entry.name));
        if (file !== null) files.push(file);
      } else if (entry.isDirectory()) {
        // A session's directory: its sub-agents' transcripts, whether or not the session's own transcript is still there.
        files.push(...subagentFiles(join(dir, entry.name)));
      }
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Only `<root>/<project>/<session>.jsonl`: a hook names a session's transcript, and its sub-agents' come with it (`subagentsOf`). */
function fileAt(root: string, path: string): TranscriptFile | null {
  const resolved = resolve(path);
  if (!resolved.endsWith(".jsonl") || dirname(dirname(resolved)) !== resolve(root)) return null;
  return statTranscript(resolved);
}

function subagentsOf(file: TranscriptFile): TranscriptFile[] {
  return file.subagentOf === undefined ? subagentFiles(sessionDir(file)) : [];
}

/** The directory Claude Code keeps a session's own files in (its sub-agents' transcripts among them). */
function sessionDir(file: TranscriptFile): string {
  return file.subagentOf === undefined ? file.path.slice(0, -".jsonl".length) : dirname(dirname(file.path));
}

const SUBAGENT_FILE = /^agent-([A-Za-z0-9_-]{1,64})\.jsonl$/;

function subagentFiles(session: string): TranscriptFile[] {
  return listDir(join(session, "subagents"))
    .filter((entry) => entry.isFile())
    .map((entry) => subagentFile(session, entry.name))
    .filter((file) => file !== null);
}

function subagentFile(session: string, name: string): TranscriptFile | null {
  const agentId = SUBAGENT_FILE.exec(name)?.[1];
  if (agentId === undefined) return null;
  const path = join(session, "subagents", name);
  const file = statTranscript(path);
  if (file === null) return null;
  const parent = basename(session);
  return { ...file, transcriptId: `${parent}/agent-${agentId}`, subagentOf: { transcriptId: parent, agentType: agentTypeOf(path) } };
}

/** The kind of sub-agent, from the `.meta.json` Claude Code writes beside its transcript; null when that is missing or unreadable. */
function agentTypeOf(transcript: string): string | null {
  try {
    const meta = parseObject(readFileSync(transcript.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    const type = meta?.["agentType"];
    return typeof type === "string" && type.trim() !== "" ? type.trim().slice(0, 64) : null;
  } catch {
    return null;
  }
}

function statTranscript(path: string): TranscriptFile | null {
  try {
    const st = statSync(path);
    return st.isFile() ? { transcriptId: basename(path, ".jsonl"), path, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) } : null;
  } catch {
    return null; // removed between listing and stat (retention sweep): not there, nothing to import
  }
}

function inspect(file: TranscriptFile): TranscriptHead {
  for (const line of readLines(file.path, 0, HEAD_BYTES)) {
    if (line.text === null) continue;
    const entry = parseObject(line.text);
    if (entry !== null && typeof entry["cwd"] === "string") {
      const hostVersion = typeof entry["version"] === "string" ? entry["version"] : null;
      return { cwd: entry["cwd"], hostVersion, supported: hostVersion !== null && isSupported(hostVersion) };
    }
  }
  return { cwd: null, hostVersion: null, supported: true };
}

function read(file: TranscriptFile, from: number, maxBytes: number): TranscriptChunk {
  const chunk: TranscriptChunk = { events: [], end: from, excluded: {}, stop: null };
  const context: ReadContext = { file, subagentsDir: join(sessionDir(file), "subagents") };
  const exclude = (reason: ExclusionReason, n = 1): void => {
    chunk.excluded[reason] = (chunk.excluded[reason] ?? 0) + n;
  };
  for (const line of readLines(file.path, from, maxBytes)) {
    if (line.text === null) {
      exclude("oversized_entry");
      chunk.end = line.end;
      continue;
    }
    const entry = parseObject(line.text);
    if (entry === null) {
      exclude("malformed");
      chunk.end = line.end;
      continue;
    }
    const version = entry["version"];
    const versionedEntry = entry["type"] === "user" || entry["type"] === "assistant" || entry["type"] === "system" || entry["type"] === "attachment";
    if (versionedEntry && (typeof version !== "string" || !isSupported(version))) {
      chunk.stop = { reason: "unsupported_version", hostVersion: typeof version === "string" ? version : "missing", offset: line.start };
      return chunk;
    }
    normalizeEntry(entry, line, chunk.events, exclude, context);
    chunk.end = line.end;
  }
  return chunk;
}

type Entry = JsonObject;
type Excluder = (reason: ExclusionReason, n?: number) => void;
/** The transcript being read, and where its session's sub-agent transcripts are. */
interface ReadContext {
  file: TranscriptFile;
  subagentsDir: string;
}

function normalizeEntry(entry: Entry, line: { start: number; end: number }, out: NormalizedEvent[], exclude: Excluder, context: ReadContext): void {
  const type = entry["type"];
  if (typeof type !== "string") { exclude("malformed"); return; }
  if (METADATA_TYPES.has(type)) { exclude("host_metadata"); return; }
  if (type !== "user" && type !== "assistant" && type !== "system" && type !== "attachment") { exclude("unsupported_entry"); return; }

  const { uuid, timestamp, cwd, version } = entry;
  if (typeof uuid !== "string" || typeof timestamp !== "string" || typeof cwd !== "string" || typeof version !== "string") {
    exclude("malformed"); return;
  }
  const sidechain = entry["isSidechain"] === true;
  const attributed = typeof entry["attributionAgent"] === "string" ? entry["attributionAgent"] : null;
  const origin = {
    branch: sidechain ? (typeof entry["agentId"] === "string" ? entry["agentId"] : "sidechain") : "main",
    ...(sidechain ? { agentType: context.file.subagentOf?.agentType ?? attributed } : {}),
    observedAt: timestamp,
    cwd,
    gitBranch: typeof entry["gitBranch"] === "string" && entry["gitBranch"] !== "" ? entry["gitBranch"] : null,
    hostVersion: version,
    lineStart: line.start,
    lineEnd: line.end,
  };
  const eventId = (block: number): string => (block === 0 ? uuid : `${uuid}#${block}`);

  if (type === "attachment") { exclude("host_metadata"); return; }
  if (type === "system") {
    // away_summary is a recap Claude Code wrote for the user; every other subtype is bookkeeping.
    if (entry["subtype"] === "away_summary" && typeof entry["content"] === "string" && entry["content"].trim() !== "") {
      out.push({ ...origin, eventId: eventId(0), type: "host_summary", text: entry["content"].trim() });
      return;
    }
    exclude("host_metadata"); return;
  }

  const message = entry["message"];
  if (message === null || typeof message !== "object") { exclude("malformed"); return; }
  const content = (message as { content?: unknown }).content;

  if (type === "user") {
    if (entry["isCompactSummary"] === true) {
      const text = typeof content === "string" ? content : resultText(content, exclude);
      if (text.trim() !== "") out.push({ ...origin, eventId: eventId(0), type: "host_summary", text: text.trim() });
      return;
    }
    // Skill bodies, command caveats and notifications are injected by Claude Code, not typed.
    const originKind = (entry["origin"] as { kind?: unknown } | undefined)?.kind;
    if (entry["isMeta"] === true || (originKind !== undefined && originKind !== "human")) { exclude("injected_context"); return; }
    if (typeof content === "string") { pushUserText(content, 0); return; }
    if (!Array.isArray(content)) { exclude("malformed"); return; }
    let text = "";
    let textBlock = -1;
    const reported = subagentReported(entry, context);
    // One result per entry is how Claude Code writes them; with several, whose metadata this is cannot be told.
    const facts = content.filter((b: unknown) => (b as { type?: unknown }).type === "tool_result").length === 1 ? outputFacts(entry) : undefined;
    content.forEach((block: unknown, index) => {
      const b = block as { type?: unknown; text?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };
      if (b.type === "tool_result" && typeof b.tool_use_id === "string" && reported) {
        exclude("subagent_report");
      } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const text = resultText(b.content, exclude);
        const output = facts === undefined ? {} : { output: { ...facts, intact: facts.intact && !HOST_NOTE.test(text) } };
        out.push({ ...origin, eventId: eventId(index), type: "tool_result", callId: b.tool_use_id, text, isError: b.is_error === true, ...output });
      } else if (b.type === "text" && typeof b.text === "string") {
        if (textBlock < 0) textBlock = index;
        text += (text === "" ? "" : "\n") + b.text;
      } else if (b.type === "image" || b.type === "document") {
        exclude("binary");
      } else {
        exclude("unsupported_entry");
      }
    });
    if (textBlock >= 0) pushUserText(text, textBlock);
    return;
  }

  // assistant
  if (!Array.isArray(content)) { exclude("malformed"); return; }
  content.forEach((block: unknown, index) => {
    const b = block as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (b.type === "thinking" || b.type === "redacted_thinking") { exclude("hidden_reasoning"); return; }
    if (b.type === "text" && typeof b.text === "string") {
      if (b.text.trim() !== "") out.push({ ...origin, eventId: eventId(index), type: "message", role: "assistant", text: b.text.trim() });
      return;
    }
    if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
      out.push({ ...origin, eventId: eventId(index), type: "tool_call", callId: b.id, tool: b.name, ...describeCall(b.name, asObject(b.input), cwd) });
      return;
    }
    exclude("unsupported_entry");
  });

  function pushUserText(raw: string, block: number): void {
    let injected = 0;
    const text = raw.replace(INJECTED, () => {
      injected++;
      return "";
    });
    if (injected > 0) exclude("injected_context", injected);
    // On a sub-agent's branch the "user" is the parent agent that prompted it.
    if (text.trim() !== "") out.push({ ...origin, eventId: eventId(block), type: "message", role: sidechain ? "parent_agent" : "user", text: text.trim() });
  }
}

/**
 * Whether a tool result is a sub-agent's hand-back that its own transcript, imported with this
 * one, carries instead. The Agent tool's result names the agent in `toolUseResult.agentId`. In the
 * background it is only a launch receipt (`status: "async_launched"`), always left out: the
 * sub-agent's transcript may not be written yet when the parent stops, and the report returns as
 * a task-notification. In the foreground it is the report, left out while the sub-agent's
 * transcript is on disk (it is by then), kept otherwise.
 */
function subagentReported(entry: Entry, context: ReadContext): boolean {
  const result = asObject(entry["toolUseResult"]);
  const agentId = result["agentId"];
  if (typeof agentId !== "string") return false;
  if (result["status"] === "async_launched") return true;
  const name = `agent-${agentId}.jsonl`;
  return SUBAGENT_FILE.test(name) && existsSync(join(context.subagentsDir, name));
}

/** One-line description, touched paths and semantic kind of a tool call, from its input. */
function describeCall(name: string, input: Entry, cwd: string): { summary: string; paths: string[]; urls: string[]; toolKind: ToolKind; inputDigest?: string; read?: FileRead } {
  const str = (key: string): string | null => (typeof input[key] === "string" ? input[key] : null);
  const debrief = DEBRIEF_TOOL.exec(name);
  if (debrief !== null) return { summary: `${debrief[1] ?? name} ${JSON.stringify(input)}`, paths: [], urls: [], toolKind: "debrief" };
  if (FILE_TOOLS.has(name)) {
    const path = str("file_path") ?? str("notebook_path");
    const offset = typeof input["offset"] === "number" ? input["offset"] : null;
    const limit = typeof input["limit"] === "number" ? input["limit"] : null;
    const lines = offset !== null && limit !== null ? ` (lines ${offset}-${offset + limit - 1})` : "";
    const read = name === "Read" && path !== null ? { read: { path: isAbsolute(path) ? path : resolve(cwd, path), format: "read_tool" as const, trimmed: false } } : {};
    return { summary: `${name} ${path ?? "(no path)"}${lines}`, paths: path === null ? [] : [path], urls: [], toolKind: "artifact_access", ...read };
  }
  switch (name) {
    case "Bash":
      // A command that only prints files inside the cwd is a file read, like Read (see shell-reads.ts).
      return { summary: `$ ${str("command") ?? ""}`, urls: [], ...shellCall(str("command"), cwd, cwd, true) };
    case "Grep":
    case "Glob": {
      const path = str("path");
      return { summary: `${name} ${JSON.stringify(str("pattern") ?? "")}${path === null ? "" : ` in ${path}`}`, paths: path === null ? [] : [path], urls: [], toolKind: "other" };
    }
    case "WebFetch": {
      const url = str("url");
      return { summary: `WebFetch ${url ?? ""}`, paths: [], urls: url === null ? [] : [url], toolKind: "other" };
    }
    case "WebSearch":
      return { summary: `WebSearch ${JSON.stringify(str("query") ?? "")}`, paths: [], urls: [], toolKind: "other" };
    case "Agent":
    case "Task":
      return { summary: `${name}: ${str("description") ?? ""}`, paths: [], urls: [], toolKind: "other" };
    default:
      // Unknown schemas are not safe to summarize. Keep only a deterministic digest for
      // event-version identity; importer bookkeeping never persists this digest or input.
      return {
        summary: `${name} [arguments omitted]`,
        paths: [],
        urls: [],
        toolKind: "other",
        inputDigest: `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`,
      };
  }
}

/** A note Claude Code adds to shell output (the command printed nothing, or it moved the shell out of the project). */
const HOST_NOTE = /^\((?:Bash completed with no output|No output)\)$|(?:^|\n)Shell cwd was reset to /;

/**
 * Whether the model saw a result whole, and a `Read` window, from `toolUseResult` metadata: a
 * `text` Read's `file` line counts, and for shell output whether it was persisted to a file,
 * an image, interrupted, or had stderr (which Claude Code shows with stdout). Undefined when
 * the entry records neither.
 */
function outputFacts(entry: Entry): OutputFacts | undefined {
  const result = asObject(entry["toolUseResult"]);
  if (result["type"] === "text") {
    const file = asObject(result["file"]);
    const [startLine, numLines, totalLines] = [file["startLine"], file["numLines"], file["totalLines"]];
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(numLines) || !Number.isSafeInteger(totalLines)) return undefined;
    return { intact: true, window: { startLine: startLine as number, numLines: numLines as number, totalLines: totalLines as number } };
  }
  if (typeof result["stdout"] !== "string") return undefined;
  return { intact: result["persistedOutputPath"] === undefined && result["isImage"] !== true && result["interrupted"] !== true && result["stderr"] === "" };
}

function resultText(content: unknown, exclude: Excluder): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as { type?: unknown; text?: unknown }[]) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image" || block.type === "document") exclude("binary");
    else if (block.type === "tool_reference") exclude("host_metadata");
    else exclude("unsupported_entry");
  }
  return parts.join("\n");
}

function isSupported(version: string): boolean {
  return inCompatibility(version, COMPATIBILITY);
}
