import { checkPlugin, type PluginCheck } from "../host-health.js";
import type { HostPaths, PluginFacts } from "../hosts.js";
import type { StatusResult } from "../memory.js";

/**
 * `memchor status`: one host's answer to "is it working?", for a person at a terminal. A shallow
 * transport: the plugin check (src/host-health.ts) and `Memory.status()` supply every fact; this
 * only lays them out and counts the problems. ✔ works · ✘ a problem · · worth knowing.
 */

export interface StatusReport {
  text: string;
  problems: number;
}

export async function hostStatus(input: { displayName: string; host: string; facts: PluginFacts; paths: HostPaths; status: StatusResult; cwd: string; env: NodeJS.ProcessEnv; now?: number }): Promise<StatusReport> {
  const plugin = await checkPlugin(input.facts, () => input.facts.find(input.paths), { cwd: input.cwd, env: input.env });
  return renderStatus({ ...input, plugin, now: input.now ?? Date.now() });
}

export function renderStatus(input: { displayName: string; host: string; facts: PluginFacts; status: StatusResult; plugin: PluginCheck; now: number }): StatusReport {
  const { facts, status, plugin, now } = input;
  const lines: string[] = [`memchor status · ${input.displayName}`];
  let problems = 0;
  const row = (label: string, value: string, mark: "✔" | "✘" | "·" | null = null): void => {
    if (mark === "✘") problems++;
    lines.push(`  ${label.padEnd(15)}${mark === null ? "" : `${mark} `}${value}`);
  };
  const ago = (at: string): string => {
    const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
    if (seconds < 2) return "just now";
    if (seconds < 120) return `${seconds}s ago`;
    if (seconds < 7_200) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 172_800) return `${Math.round(seconds / 3_600)}h ago`;
    return `${Math.round(seconds / 86_400)}d ago`;
  };

  if (plugin.state === "not_installed") {
    row("plugin", `not installed: ${facts.install}`, "✘");
  } else if (plugin.state === "unreadable") {
    row("plugin", `could not read ${input.displayName}'s plugin records: ${plugin.message}`, "✘");
  } else {
    const { install } = plugin;
    const name = `${facts.id}${install.version === null ? "" : ` ${install.version}`}`;
    // Only a user-scope install is enabled in the settings Memchor reads; others are enabled per project.
    if (install.scope !== "user") row("plugin", `${name}, installed in ${install.scope} scope`, "✔");
    else if (install.enabled) row("plugin", `${name}, enabled`, "✔");
    else row("plugin", `${name}, installed but disabled: in ${input.displayName} run /plugin enable ${facts.id}`, "✘");
    const server = plugin.server;
    if (server.problem === null) row("MCP server", `answering with ${server.tools} tools (${server.command})`, "✔");
    else row("MCP server", `could not start ${server.command}: ${server.problem}`, "✘");

    const label = (i: number): string => (i === 0 ? "hooks" : "");
    facts.hooks.forEach((hook, i) => {
      const event = hook.event.padEnd(20);
      const run = status.hookRuns.find((r) => r.host === input.host && r.event === hook.event);
      if (plugin.hooks.find((h) => h.event === hook.event)?.registered !== true) row(label(i), `${event} not registered by the installed plugin: reinstall it`, "✘");
      else if (run?.outcome === "failed") row(label(i), `${event} failed (${run.code ?? "unknown"}), ${ago(run.at)}: memchor diag status lists the failures`, "✘");
      else if (run !== undefined) row(label(i), `${event} ok, ${ago(run.at)}`, "✔");
      else if (hook.runsOnlyWhen !== null) row(label(i), `${event} never ran (it runs when ${hook.runsOnlyWhen})`, "·");
      else row(label(i), `${event} never ran: start a new ${input.displayName} session; if it still has not run, the hook is not firing`, "✘");
    });
  }

  row("last capture", status.lastCaptureAt === null ? "never" : ago(status.lastCaptureAt));
  const imported = status.import;
  const gaps = imported?.gaps ?? [];
  if (gaps.length === 0) row("capture gaps", "none");
  else row("capture gaps", `${gaps.length}: ${gaps.map((g) => g.message).join(" · ")}`, "✘");
  const unsupported = imported?.transcripts?.unsupportedVersion ?? 0;
  if (unsupported > 0) {
    const versions = (imported?.compatibility ?? []).map((c) => `${c.from} up to ${c.below}`).join(", ");
    row("transcripts", `${unsupported} from a ${input.displayName} version Memchor does not import (it imports ${versions})`, "✘");
  }
  if (imported === null) row("import", `unknown: ${status.problem?.message ?? "scope unresolved"}`, "✘");
  else if (imported.problem !== null) row("import", `${imported.problem.code}: ${imported.problem.message}`, "✘");
  else if (imported.state === "consent_required") row("import", "not answered yet: the agent asks at the next session start");
  else row("import", imported.consent?.choice ?? imported.state);
  row("preferences", status.preferenceQuestions === 0 ? "no questions waiting" : `${status.preferenceQuestions} question${status.preferenceQuestions === 1 ? "" : "s"} waiting for the user`);
  row("storage", status.storage.dbPath ?? status.storage.home);
  if (status.problem !== null && imported !== null) row("storage", `${status.problem.code}: ${status.problem.message}`, "✘");

  lines.push("", problems === 0 ? "✔ healthy" : `✘ ${problems} problem${problems === 1 ? "" : "s"}`);
  return { text: lines.join("\n") + "\n", problems };
}
