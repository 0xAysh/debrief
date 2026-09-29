import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where each host records that Debrief's plugin is installed. Only file reads: the host table
 * (src/hosts.ts) points at these, and every hook loads that table.
 */

export interface PluginInstall {
  version: string | null;
  /** Where the host installed it (Claude Code: user, project or local), as the host names it. */
  scope: string;
  /** Null where the host keeps that elsewhere than the records read here (a Claude Code project or local install). */
  enabled: boolean | null;
  /** The installed copy of the plugin (its `.mcp.json` and `hooks/hooks.json`). */
  root: string;
}

/** Claude Code's config directory: `$CLAUDE_CONFIG_DIR`, then `~/.claude`. An empty value means unset (Claude Code's own default), never "the cwd". */
export function claudeConfigDir(): string {
  const fromEnv = process.env["CLAUDE_CONFIG_DIR"];
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : join(homedir(), ".claude");
}

/**
 * Claude Code's record of an installed plugin: `plugins/installed_plugins.json` (version 2: id →
 * installs) and, for a user-scope install, `enabledPlugins` in `settings.json`, both in its config
 * directory. Pinned against Claude Code 2.1.284 (tests/hooks/claude-plugin.test.ts). Null when
 * it is not installed; throws when the files cannot be read.
 */
export function claudeCodePluginInstall(configDir: string, id: string): PluginInstall | null {
  const installed = readJson(join(configDir, "plugins", "installed_plugins.json"));
  const installs = (installed as { plugins?: Record<string, unknown> } | null)?.plugins?.[id];
  const entry = Array.isArray(installs) ? (installs as { scope?: unknown; installPath?: unknown; version?: unknown }[]).find((i) => typeof i.installPath === "string") : undefined;
  if (entry === undefined) return null;
  const scope = typeof entry.scope === "string" ? entry.scope : "user";
  // Only a user-scope install is enabled in the config directory's settings; the others, in a project's.
  const settings = scope === "user" ? (readJson(join(configDir, "settings.json")) as { enabledPlugins?: Record<string, unknown> } | null) : null;
  return { version: typeof entry.version === "string" ? entry.version : null, scope, enabled: scope === "user" ? settings?.enabledPlugins?.[id] === true : null, root: entry.installPath as string };
}

/** A JSON file's content; null when it does not exist; throws when it cannot be read or parsed. */
export function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
}
