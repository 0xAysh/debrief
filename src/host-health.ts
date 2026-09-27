import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type PluginInstall, readJson } from "./host-plugins.js";
import type { PluginFacts } from "./hosts.js";

/**
 * Whether Memchor's plugin is installed in a host and working, for `memchor status`: the host's
 * record of the plugin, which of Memchor's hooks the installed copy registers, and a real MCP
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

export async function checkPlugin(facts: PluginFacts, find: () => PluginInstall | null, options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<PluginCheck> {
  let install: PluginInstall | null;
  let servers: Record<string, { command?: unknown; args?: unknown }> | undefined;
  let hooks: Record<string, unknown> | undefined;
  try {
    install = find();
    if (install === null) return { state: "not_installed" };
    servers = (readJson(join(install.root, ".mcp.json")) as { mcpServers?: typeof servers } | null)?.mcpServers;
    hooks = (readJson(join(install.root, "hooks", "hooks.json")) as { hooks?: typeof hooks } | null)?.hooks;
  } catch (error) {
    return { state: "unreadable", message: error instanceof Error ? error.message : String(error) };
  }
  const registered = facts.hooks.map((hook) => ({ event: hook.event, registered: JSON.stringify(hooks?.[hook.hostEvent] ?? null).includes(`memchor hook ${hook.event} `) }));
  const server = servers?.[facts.server];
  const command = typeof server?.command === "string" ? server.command : null;
  const args = Array.isArray(server?.args) ? server.args.filter((a): a is string => typeof a === "string") : [];
  const check: ServerCheck =
    command === null
      ? { command: "", tools: 0, problem: `the plugin registers no "${facts.server}" MCP server` }
      : await handshake(command, args, facts, options);
  return { state: "installed", install, server: check, hooks: registered };
}

/** Starts the server as the host would, completes the MCP handshake, lists its tools, and stops it. */
async function handshake(command: string, args: string[], facts: PluginFacts, options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<ServerCheck> {
  const line = [command, ...args].join(" ");
  if (!onPath(command, options.env)) return { command: line, tools: 0, problem: `${command} is not on PATH (${facts.runtimeInstall})` };
  let stderr = "";
  const transport = new StdioClientTransport({ command, args, cwd: options.cwd, env: definedOnly(options.env), stderr: "pipe" });
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2_000);
  });
  const client = new Client({ name: "memchor-status", version: "0" });
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const listed = await Promise.race([
      client.connect(transport).then(() => client.listTools()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`no answer within ${timeoutMs / 1000} s`));
        }, timeoutMs);
      }),
    ]);
    const tools = listed.tools.filter((t) => t.name.startsWith("memory_")).length;
    return { command: line, tools, problem: tools === 0 ? "it answered, but offers no Memchor tools" : null };
  } catch (error) {
    const last = stderr.trim().split("\n").at(-1);
    return { command: line, tools: 0, problem: `${error instanceof Error ? error.message : String(error)}${last === undefined || last === "" ? "" : ` (${last})`}` };
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
