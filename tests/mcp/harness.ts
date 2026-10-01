import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type ElicitRequest, ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { onCleanup } from "../helpers.js";

/** The CLI as the package ships it: one bundled file (scripts/bundle.mjs). */
export const CLI = resolve(import.meta.dirname, "../../dist/debrief.mjs");

export interface ToolOutcome {
  isError: boolean;
  structured: Record<string, unknown>;
  text: string;
}

export interface ServerHandle {
  client: Client;
  pid: number;
  /** `meta` is sent as this call's `_meta`, instead of the server's (a host's per-call tool-use id). */
  call(name: string, args?: Record<string, unknown>, meta?: Record<string, unknown>): Promise<ToolOutcome>;
  /** Result of a call that must succeed. */
  ok<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>, meta?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export const NO_NETWORK = resolve(import.meta.dirname, "no-network.mjs");

/**
 * Spawns `node dist/debrief.mjs mcp` in `cwd` with an isolated DEBRIEF_HOME (and, if given, an
 * isolated Claude config dir or Codex home) and connects an SDK client. `networkLog` preloads a guard that
 * records and refuses every network attempt.
 */
export async function spawnServer(options: {
  cwd: string;
  home: string;
  host?: string;
  clientName?: string;
  claudeConfigDir?: string;
  codexHome?: string;
  networkLog?: string;
  /** Sent as `_meta` on every tools/call, as a host does (Codex: `{ threadId }`). */
  meta?: Record<string, unknown>;
  /**
   * The client's elicitation capability as a host advertises it (Claude Code: `{}`; Codex:
   * `{ form: {}, url: {} }`) and how the "user" answers; omitted = no elicitation support.
   */
  elicitation?: { capability: Record<string, unknown>; respond: (request: ElicitRequest["params"]) => Promise<ElicitResult> };
  /** `DEBRIEF_ELICITATION_TIMEOUT_MS` for the server. */
  elicitationTimeoutMs?: number;
  /**
   * Meaning search (the bundled model). Off unless asked for: the suites that test something else
   * get keyword search alone, as they were written for, without racing the background fill.
   */
  meaning?: boolean;
  /** `DEBRIEF_EMBEDDER_IDLE_MS` for the server: how long the model stays loaded without a request. */
  embedderIdleMs?: number;
  /** Another copy of the bundle to run (a package unpacked elsewhere, one missing its model). */
  cli?: string;
}): Promise<ServerHandle> {
  const args = [...(options.networkLog === undefined ? [] : ["--import", NO_NETWORK]), options.cli ?? CLI, "mcp", ...(options.host === undefined ? [] : ["--host", options.host])];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    cwd: options.cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      DEBRIEF_HOME: options.home,
      // Never let a spawned server read the developer's real transcripts.
      CLAUDE_CONFIG_DIR: options.claudeConfigDir ?? resolve(options.home, "no-claude-config"),
      CODEX_HOME: options.codexHome ?? resolve(options.home, "no-codex-home"),
      ...(options.networkLog === undefined ? {} : { DEBRIEF_NETWORK_LOG: options.networkLog }),
      ...(options.elicitationTimeoutMs === undefined ? {} : { DEBRIEF_ELICITATION_TIMEOUT_MS: String(options.elicitationTimeoutMs) }),
      ...(options.meaning === true ? {} : { DEBRIEF_MEANING_SEARCH: "off" }),
      ...(options.embedderIdleMs === undefined ? {} : { DEBRIEF_EMBEDDER_IDLE_MS: String(options.embedderIdleMs) }),
    },
    stderr: "pipe",
  });
  const elicitation = options.elicitation;
  const client = new Client(
    { name: options.clientName ?? "debrief-test", version: "0.0.0" },
    elicitation === undefined ? {} : { capabilities: { elicitation: elicitation.capability } },
  );
  if (elicitation !== undefined) client.setRequestHandler(ElicitRequestSchema, (request) => elicitation.respond(request.params));
  await client.connect(transport);
  const pid = transport.pid;
  if (pid === null) throw new Error("server did not start");

  const call = async (name: string, callArgs: Record<string, unknown> = {}, meta = options.meta): Promise<ToolOutcome> => {
    const result = await client.callTool({ name, arguments: callArgs, ...(meta === undefined ? {} : { _meta: meta }) });
    const content = result.content as { type: string; text?: string }[];
    return {
      isError: result.isError === true,
      structured: (result.structuredContent ?? {}) as Record<string, unknown>,
      text: content.find((c) => c.type === "text")?.text ?? "",
    };
  };
  const handle: ServerHandle = {
    client,
    pid,
    call,
    ok: async <T,>(name: string, callArgs: Record<string, unknown> = {}, meta?: Record<string, unknown>): Promise<T> => {
      const outcome = await call(name, callArgs, meta ?? options.meta);
      if (outcome.isError) throw new Error(`${name} failed: ${outcome.text}`);
      return outcome.structured as T;
    },
    close: () => client.close(),
  };
  onCleanup(() => {
    void client.close();
  });
  return handle;
}
