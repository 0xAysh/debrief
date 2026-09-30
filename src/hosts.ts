import { claudeCodePluginInstall, claudeConfigDir, type PluginInstall } from "./host-plugins.js";
import { claudeCodeAdapter } from "./import/adapters/claude.js";
import { codexAdapter } from "./import/adapters/codex.js";
import type { TranscriptAdapter } from "./import/normalized-event.js";
import type { SessionStart, SubagentStart, TurnEnd } from "./retrieval/session-context.js";

/**
 * Everything Debrief knows about each agent host, in one place: the memory module picks the
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
  /** The host's transcript format; null when Debrief cannot import its history. */
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
   * The host's hooks, or null where Debrief has no driven evidence for them yet (then no
   * `debrief hook` runs for it and `memory_bootstrap` is the path). Output shapes live here,
   * per host, because each host validates them differently (Codex rejects unknown keys).
   */
  hooks: HookOutput | null;
  /** The host's tools that change files (as its transcripts name them): work a checkpoint should cover. */
  editTools: readonly string[];
  /**
   * How the host names Debrief's own tools in hook payloads, by exact server name (the operation
   * is group 1); null where that is not pinned. Another server's tool of the same name never matches.
   */
  debriefTool: RegExp | null;
  /**
   * Prompts the host submits itself through its prompt hook, which are not the user's words (a
   * background sub-agent's report); null where none are pinned.
   */
  hostPrompt: RegExp | null;
  /** How Debrief is installed into the host as a plugin, for `debrief status`; null where there is none. */
  plugin: PluginFacts | null;
}

export interface PluginFacts {
  /** The host's name for people, e.g. "Claude Code". */
  hostName: string;
  /** The plugin's id in the host (`<plugin>@<marketplace>`). */
  id: string;
  /** What the user does to install it. */
  install: string;
  /** What the user does to enable it once installed. */
  enable: string;
  /** The MCP server's name in the plugin. */
  server: string;
  /** How the user gets the `debrief` command the plugin runs. */
  runtimeInstall: string;
  /** The host's record of the installed plugin; null when it is not installed. Throws when that record cannot be read. */
  find(): PluginInstall | null;
  /**
   * Debrief's hooks as the plugin registers them, in the order they fire: the host's event name,
   * the `debrief hook` it runs, and when it runs, where that is not every session (then never
   * having run is expected, not a problem).
   */
  hooks: readonly { hostEvent: string; event: string; runsOnlyWhen: string | null }[];
}

export interface HookOutput {
  /** Stdout for a session-start hook: context for the model, and the one-line notice for the user. */
  sessionStart(start: SessionStart): string;
  /** Stdout for a sub-agent-start hook: context for the sub-agent's model. */
  subagentStart(start: SubagentStart): string;
  /** Stdout for a Stop hook: a request that the agent continue (the nudge), and the user's line; empty for neither. */
  stop(end: TurnEnd): string;
  /** Stdout for a prompt-submit hook: one line of context for the agent. */
  promptHint(line: string): string;
  /** Stdout for a pre-tool hook that lets a call skip the permission prompt, with a notice for the user. */
  allowTool(notice: string | null): string;
}

/** Pinned against Claude Code 2.1.284 (tests/hooks/claude-hooks.test.ts, tests/hooks/claude-subagents.test.ts). */
const CLAUDE_CODE_HOOKS: HookOutput = {
  sessionStart: (start) => JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: start.context }, systemMessage: start.notice }),
  // Only additionalContext reaches the sub-agent; plain stdout does not (tests/hooks/claude-subagents.test.ts).
  subagentStart: (start) => JSON.stringify({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: start.context } }),
  stop: (end) =>
    end.nudge === null && end.notice === null
      ? ""
      : JSON.stringify({ ...(end.nudge === null ? {} : { decision: "block", reason: end.nudge }), ...(end.notice === null ? {} : { systemMessage: end.notice }) }),
  promptHint: (line) => JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: line } }),
  allowTool: (notice) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" }, ...(notice === null ? {} : { systemMessage: notice }) }),
};

/** plugin/ in this repository, listed by its marketplace (.claude-plugin/marketplace.json). */
const CLAUDE_CODE_PLUGIN = "debrief@debrief";

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
    // User-scope `mcp__debrief__…`, or the plugin-bundled server's `mcp__plugin_debrief_debrief__…`.
    debriefTool: /^mcp__(?:plugin_debrief_)?debrief__(memory_[a-z_]+)$/,
    // A background sub-agent's report arrives as a UserPromptSubmit prompt (tests/hooks/claude-subagents.test.ts).
    hostPrompt: /^<task-notification>\n/,
    // Pinned by tests/hooks/claude-plugin.test.ts.
    plugin: {
      hostName: "Claude Code",
      id: CLAUDE_CODE_PLUGIN,
      install: `in Claude Code run /plugin marketplace add 0xAysh/debrief, then /plugin install ${CLAUDE_CODE_PLUGIN}`,
      enable: `in Claude Code run /plugin enable ${CLAUDE_CODE_PLUGIN}`,
      server: "debrief",
      runtimeInstall: "npm install -g debrief-cli",
      find: () => claudeCodePluginInstall(claudeConfigDir(), CLAUDE_CODE_PLUGIN),
      hooks: [
        { hostEvent: "SessionStart", event: "session-start", runsOnlyWhen: null },
        { hostEvent: "SubagentStart", event: "subagent-start", runsOnlyWhen: "a sub-agent starts" },
        { hostEvent: "UserPromptSubmit", event: "user-prompt-submit", runsOnlyWhen: null },
        { hostEvent: "PreToolUse", event: "pre-tool-use", runsOnlyWhen: "the agent calls a Debrief tool" },
        { hostEvent: "Stop", event: "stop", runsOnlyWhen: null },
      ],
    },
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
    debriefTool: null,
    hostPrompt: null,
    plugin: null,
  },
  pi: { transcripts: null, sessionMetaKey: null, sessionEnv: null, toolUseMetaKey: null, hooks: null, editTools: [], debriefTool: null, hostPrompt: null, plugin: null },
  unknown: { transcripts: null, sessionMetaKey: null, sessionEnv: null, toolUseMetaKey: null, hooks: null, editTools: [], debriefTool: null, hostPrompt: null, plugin: null },
} as const satisfies Record<string, HostDescriptor>;

export type HostId = keyof typeof HOSTS;

export const HOST_IDS = Object.keys(HOSTS) as HostId[];

/** Hosts whose hooks Debrief has driven evidence for (`debrief hook … --host`). */
export const HOOK_HOSTS = HOST_IDS.filter((id) => HOSTS[id].hooks !== null);

/** Hosts whose transcripts Debrief can import. */
export const TRANSCRIPT_HOSTS = HOST_IDS.filter((id) => HOSTS[id].transcripts !== null);

/** The descriptor for a host name; null for any name Debrief does not know (treated like "unknown"). */
export function hostDescriptor(host: string | undefined): HostDescriptor | null {
  return host !== undefined && Object.hasOwn(HOSTS, host) ? HOSTS[host as HostId] : null;
}
