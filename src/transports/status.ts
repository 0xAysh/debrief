import { sep } from "node:path";
import { checkPlugin, type Launch, type PluginCheck } from "../host-health.js";
import type { HostId, PluginFacts } from "../hosts.js";
import type { StatusResult } from "../memory.js";

/**
 * `debrief status`: one host's answer to "is it working?", for a person at a terminal. A shallow
 * transport: the plugin check (src/host-health.ts), the host table and `Memory.status()` supply
 * every fact; this only lays them out and counts the problems. ✔ works · ✘ a problem · · worth knowing.
 */

export interface StatusReport {
  text: string;
  problems: number;
}

export async function hostStatus(host: HostId, facts: PluginFacts, status: StatusResult, launch: Launch): Promise<StatusReport> {
  return renderStatus(host, facts, status, await checkPlugin(facts, launch), Date.now());
}

function renderStatus(host: HostId, facts: PluginFacts, status: StatusResult, plugin: PluginCheck, now: number): StatusReport {
  const lines: string[] = [`debrief status · ${facts.hostName}`];
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
  // Hooks run in every repository; a run elsewhere proves the hook fires, and says where.
  const worktree = status.scope?.worktree ?? null;
  const where = (cwd: string): string => (worktree !== null && (cwd === worktree || cwd.startsWith(worktree + sep)) ? "" : ` (in ${cwd})`);

  if (plugin.state === "not_installed") {
    row("plugin", `not installed: ${facts.install}`, "✘");
  } else if (plugin.state === "unreadable") {
    row("plugin", `could not read ${facts.hostName}'s plugin records: ${plugin.message}`, "✘");
  } else {
    const { install } = plugin;
    const name = `${facts.id}${install.version === null ? "" : ` ${install.version}`}`;
    if (install.enabled === null) row("plugin", `${name}, installed in ${install.scope} scope`, "✔");
    else if (install.enabled) row("plugin", `${name}, enabled`, "✔");
    else row("plugin", `${name}, installed but disabled: ${facts.enable}`, "✘");
    const server = plugin.server;
    if (server.problem === null) row("MCP server", `answering with ${server.tools} tools (${server.command})`, "✔");
    else row("MCP server", `could not start ${server.command}: ${server.problem}`, "✘");

    facts.hooks.forEach((hook, i) => {
      const label = i === 0 ? "hooks" : "";
      const event = hook.event.padEnd(20);
      const run = status.hookRuns.find((r) => r.host === host && r.event === hook.event);
      if (plugin.hooks.find((h) => h.event === hook.event)?.registered !== true) {
        row(label, `${event} not registered by the installed plugin: reinstall it`, "✘");
      } else if (run?.outcome === "failed") {
        const failure = status.hookFailures.findLast((f) => f.host === host && f.event === hook.event);
        row(label, `${event} failed, ${ago(run.at)}${where(run.cwd)}: ${run.code ?? "unknown"}${failure === undefined ? "" : `: ${failure.message}`}`, "✘");
      } else if (run !== undefined) {
        row(label, `${event} ok, ${ago(run.at)}${where(run.cwd)}`, "✔");
      } else if (hook.runsOnlyWhen !== null) {
        row(label, `${event} never ran (it runs when ${hook.runsOnlyWhen})`, "·");
      } else {
        row(label, `${event} never ran: start a new ${facts.hostName} session; if it still has not run, the hook is not firing`, "✘");
      }
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
    row("transcripts", `${unsupported} from a ${facts.hostName} version Debrief does not import (it imports ${versions})`, "✘");
  }
  if (imported === null) row("import", `unknown: ${status.problem?.message ?? "scope unresolved"}`, "✘");
  else if (imported.problem !== null) row("import", `${imported.problem.code}: ${imported.problem.message}`, "✘");
  else if (imported.state === "consent_required") row("import", "not answered yet: the agent asks at the next session start");
  else row("import", imported.consent?.choice ?? imported.state);
  row("preferences", status.preferenceQuestions === 0 ? "no questions waiting" : `${status.preferenceQuestions} question${status.preferenceQuestions === 1 ? "" : "s"} waiting for the user`);
  const meaning = status.meaning;
  if (meaning?.state === "off") {
    row("meaning search", (meaning.notice ?? "off").replace(/^meaning search: /, ""), "·");
  } else if (meaning?.state === "failed") {
    row("meaning search", `${meaning.model} failed to load: ${meaning.problem ?? "unknown"}; recall finds memory by its words only`, "✘");
  } else if (meaning !== null) {
    const coverage = meaning.coverage;
    const covered =
      coverage === null
        ? ""
        : coverage.embedded === coverage.chunks
          ? "; all of this repository's memory is searchable by meaning"
          : `; ${coverage.percent}% of this repository's memory is searchable by meaning (the MCP server embeds the rest in the background)`;
    row("meaning search", `${meaning.model} loads${covered}`, "✔");
  }
  row("storage", status.storage.dbPath ?? status.storage.home);
  if (status.problem !== null && imported !== null) row("storage", `${status.problem.code}: ${status.problem.message}`, "✘");

  lines.push("", problems === 0 ? "✔ healthy" : `✘ ${problems} problem${problems === 1 ? "" : "s"}`);
  return { text: lines.join("\n") + "\n", problems };
}
