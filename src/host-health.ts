import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type PluginInstall, readJson } from "./host-plugins.js";
import type { PluginFacts } from "./hosts.js";

/**
 * Whether Debrief's plugin is installed in a host and working, for `debrief status`: the host's
 * record of the plugin, which of Debrief's hooks the installed copy registers, and a real MCP
 * handshake with the server command it registers (as `claude mcp list` does). What each hook
 * last did is `Memory.status().hookRuns`; this module only reads the host's files and starts
 * the server once.
 */

export interface ServerCheck {
  /** The command line the plugin registers, for the user. */
  command: string;
  tools: number;
  problem: string | null;
}

export type PluginCheck =
  | { state: "not_installed" }
  | { state: "unreadable"; message: string }
  | { state: "installed"; install: PluginInstall; server: ServerCheck; hooks: { event: string; registered: boolean }[] };

/** How long the MCP server may take to answer the handshake. */
const HANDSHAKE_TIMEOUT_MS = 15_000;

/** Where and with what environment the server is started: as the host would start it here. */
export interface Launch {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export async function checkPlugin(facts: PluginFacts, launch: Launch): Promise<PluginCheck> {
  let install: PluginInstall | null;
  let servers: Record<string, { command?: unknown; args?: unknown }> | undefined;
  let hooks: Record<string, unknown> | undefined;
  try {
    install = facts.find();
    if (install === null) return { state: "not_installed" };
    servers = (readJson(join(install.root, ".mcp.json")) as { mcpServers?: typeof servers } | null)?.mcpServers;
    hooks = (readJson(join(install.root, "hooks", "hooks.json")) as { hooks?: typeof hooks } | null)?.hooks;
  } catch (error) {
    return { state: "unreadable", message: error instanceof Error ? error.message : String(error) };
  }
  const registered = facts.hooks.map((hook) => ({ event: hook.event, registered: JSON.stringify(hooks?.[hook.hostEvent] ?? null).includes(`debrief hook ${hook.event} `) }));
  const server = servers?.[facts.server];
  const command = typeof server?.command === "string" ? server.command : null;
  const args = Array.isArray(server?.args) ? server.args.filter((a): a is string => typeof a === "string") : [];
  const check: ServerCheck =
    command === null
      ? { command: "", tools: 0, problem: `the plugin registers no "${facts.server}" MCP server` }
      : await handshake(command, args, facts, launch);
  return { state: "installed", install, server: check, hooks: registered };
}

/** Starts the server as the host would, completes the MCP handshake, lists its tools, and stops it. */
async function handshake(command: string, args: string[], facts: PluginFacts, launch: Launch): Promise<ServerCheck> {
  const line = [command, ...args].join(" ");
  if (!onPath(command, launch.env)) return { command: line, tools: 0, problem: `${command} is not on PATH (${facts.runtimeInstall})` };
  let stderr = "";
  const transport = new StdioClientTransport({ command, args, cwd: launch.cwd, env: definedOnly(launch.env), stderr: "pipe" });
  transport.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 2_000) stderr += chunk.toString();
  });
  const client = new Client({ name: "debrief-status", version: "0" });
  let timer: NodeJS.Timeout | undefined;
  try {
    const listed = await Promise.race([
      client.connect(transport).then(() => client.listTools()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`no answer within ${HANDSHAKE_TIMEOUT_MS / 1000} s`));
        }, HANDSHAKE_TIMEOUT_MS);
      }),
    ]);
    const tools = listed.tools.filter((t) => t.name.startsWith("memory_")).length;
    return { command: line, tools, problem: tools === 0 ? "it answered, but offers no Debrief tools" : null };
  } catch (error) {
    // What the server said first: the error, before any usage text or stack.
    const said = stderr.split("\n").find((l) => l.trim() !== "")?.trim();
    return { command: line, tools: 0, problem: `${error instanceof Error ? error.message : String(error)}${said === undefined ? "" : ` (${said})`}` };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}

function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
  const candidates = isAbsolute(command) || command.includes("/") ? [command] : (env["PATH"] ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function definedOnly(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
