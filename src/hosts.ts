import { claudeCodeAdapter } from "./import/adapters/claude.js";
import { codexAdapter } from "./import/adapters/codex.js";
import type { TranscriptAdapter } from "./import/normalized-event.js";
import type { SessionStart } from "./retrieval/session-context.js";
import type { TurnEnd } from "./memory.js";

/**
 * Everything Memchor knows about each agent host, in one place: the memory module picks the
 * transcript adapter from here, the MCP transport the `_meta` key naming the live session,
 * and the CLI its `--host` choices. Transcript formats themselves stay behind
 * {@link TranscriptAdapter} (which also carries the host's display name); this is only which
 * adapter, and how the host names its session.
 */

/** Where hosts keep their history; each adapter reads only its own. */
export interface HostPaths {
  /** Claude Code's config directory. Defaults to `$CLAUDE_CONFIG_DIR`, then `~/.claude`. */
  claudeConfigDir?: string | undefined;
  /** Codex's home directory. Defaults to `$CODEX_HOME`, then `~/.codex`. */
  codexHome?: string | undefined;
}

export interface HostDescriptor {
  /** The host's transcript format; null when Memchor cannot import its history. */
  transcripts: ((paths: HostPaths) => TranscriptAdapter) | null;
  /**
   * The `tools/call` `_meta` key through which the host names its own session on every call,
   * or null when it sends none (then the live session and its transcript are only joined by
   * worktree).
   */
  sessionMetaKey: string | null;
  /**
   * The host's hooks, or null where Memchor has no driven evidence for them yet (then no
   * `memchor hook` runs for it and `memory_bootstrap` is the path). Output shapes live here,
   * per host, because each host validates them differently (Codex rejects unknown keys).
   */
  hooks: HookOutput | null;
  /** The host's tools that change files (as its transcripts name them): work a checkpoint should cover. */
  editTools: readonly string[];
}

export interface HookOutput {
  /** Stdout for a session-start hook: context for the model, and the one-line notice for the user. */
  sessionStart(start: SessionStart): string;
  /** Stdout for a Stop hook: a request that the agent continue (the nudge), and the user's line; empty for neither. */
  stop(end: TurnEnd): string;
  /** Stdout for a prompt-submit hook: one line of context for the agent. */
  promptHint(line: string): string;
  /** Stdout for a pre-tool hook that lets a call skip the permission prompt, with a notice for the user. */
  allowTool(notice: string | null): string;
}

/** Pinned against Claude Code 2.1.283 (tests/hooks/claude-hooks.test.ts). */
const CLAUDE_CODE_HOOKS: HookOutput = {
  sessionStart: (start) => JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: start.context }, systemMessage: start.notice }),
  stop: (end) =>
    end.nudge === null && end.notice === null
      ? ""
      : JSON.stringify({ ...(end.nudge === null ? {} : { decision: "block", reason: end.nudge }), ...(end.notice === null ? {} : { systemMessage: end.notice }) }),
  promptHint: (line) => JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: line } }),
  allowTool: (notice) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" }, ...(notice === null ? {} : { systemMessage: notice }) }),
};

export const HOSTS = {
  "claude-code": {
    transcripts: (paths) => claudeCodeAdapter(paths.claudeConfigDir === undefined ? {} : { configDir: paths.claudeConfigDir }),
    sessionMetaKey: null,
    hooks: CLAUDE_CODE_HOOKS,
    editTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
  },
  codex: {
    transcripts: (paths) => codexAdapter(paths.codexHome === undefined ? {} : { codexHome: paths.codexHome }),
    // Codex sends `threadId` on every call, and it equals the id of the thread's rollout
    // (`session_meta.id`), so it is authoritative: adopting it as the host session id makes the
    // live session and the thread's imported rollout the same session for workstream
    // resolution (step 1). `initialize` carries no such id.
    sessionMetaKey: "threadId",
    hooks: null,
    editTools: ["apply_patch"],
  },
  pi: { transcripts: null, sessionMetaKey: null, hooks: null, editTools: [] },
  unknown: { transcripts: null, sessionMetaKey: null, hooks: null, editTools: [] },
} as const satisfies Record<string, HostDescriptor>;

export type HostId = keyof typeof HOSTS;

export const HOST_IDS = Object.keys(HOSTS) as HostId[];

/** Hosts whose hooks Memchor has driven evidence for (`memchor hook … --host`). */
export const HOOK_HOSTS = HOST_IDS.filter((id) => HOSTS[id].hooks !== null);

/** Hosts whose transcripts Memchor can import. */
export const TRANSCRIPT_HOSTS = HOST_IDS.filter((id) => HOSTS[id].transcripts !== null);

/** The descriptor for a host name; null for any name Memchor does not know (treated like "unknown"). */
export function hostDescriptor(host: string | undefined): HostDescriptor | null {
  return host !== undefined && Object.hasOwn(HOSTS, host) ? HOSTS[host as HostId] : null;
}
