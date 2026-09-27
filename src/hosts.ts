import { claudeCodeAdapter } from "./import/adapters/claude.js";
import { codexAdapter } from "./import/adapters/codex.js";
import type { TranscriptAdapter } from "./import/normalized-event.js";
import type { SessionStart, TurnEnd } from "./retrieval/session-context.js";

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
   * The environment variable through which the host names its session to the MCP servers it
   * starts, or null. Only for the server's first session: a session a call names (`sessionMetaKey`, `toolUseMetaKey`) wins.
   */
  sessionEnv: string | null;
  /**
   * The `tools/call` `_meta` key carrying the host's id for the call, which its PreToolUse hook
   * also sees with the current session id (src/bootstrap/host-sessions.ts); null when there is none.
   * It names the session where `sessionEnv` has gone stale (Claude Code after `/clear`).
   */
  toolUseMetaKey: string | null;
  /**
   * The host's hooks, or null where Memchor has no driven evidence for them yet (then no
   * `memchor hook` runs for it and `memory_bootstrap` is the path). Output shapes live here,
   * per host, because each host validates them differently (Codex rejects unknown keys).
   */
  hooks: HookOutput | null;
  /** The host's tools that change files (as its transcripts name them): work a checkpoint should cover. */
  editTools: readonly string[];
  /**
   * How the host names Memchor's own tools in hook payloads, by exact server name (the operation
   * is group 1); null where that is not pinned. Another server's tool of the same name never matches.
   */
  memchorTool: RegExp | null;
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
    // Claude Code starts its MCP servers with the session's id in the environment, the same
    // `session_id` its hooks get and its transcript's file name, so the MCP server, the hooks and
    // the imported transcript are one session: "don't remember this session" covers all three.
    sessionEnv: "CLAUDE_CODE_SESSION_ID",
    toolUseMetaKey: "claudecode/toolUseId",
    hooks: CLAUDE_CODE_HOOKS,
    editTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
    // User-scope `mcp__memchor__…`, or the plugin-bundled server's `mcp__plugin_memchor_memchor__…`.
    memchorTool: /^mcp__(?:plugin_memchor_)?memchor__(memory_[a-z_]+)$/,
  },
  codex: {
    transcripts: (paths) => codexAdapter(paths.codexHome === undefined ? {} : { codexHome: paths.codexHome }),
    // Codex sends `threadId` on every call, and it equals the id of the thread's rollout
    // (`session_meta.id`), so it is authoritative: adopting it as the host session id makes the
    // live session and the thread's imported rollout the same session for workstream
    // resolution (step 1). `initialize` carries no such id.
    sessionMetaKey: "threadId",
    sessionEnv: null,
    toolUseMetaKey: null,
    hooks: null,
    editTools: ["apply_patch"],
    memchorTool: null,
  },
  pi: { transcripts: null, sessionMetaKey: null, sessionEnv: null, toolUseMetaKey: null, hooks: null, editTools: [], memchorTool: null },
  unknown: { transcripts: null, sessionMetaKey: null, sessionEnv: null, toolUseMetaKey: null, hooks: null, editTools: [], memchorTool: null },
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
