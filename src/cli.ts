#!/usr/bin/env node
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { resolveHome } from "./bootstrap/workspace-resolution.js";
import { DebriefError } from "./errors.js";
import { HOOK_HOSTS, HOST_IDS, type HostId, HOSTS, hostDescriptor, type PluginFacts, TRANSCRIPT_HOSTS } from "./hosts.js";
import { consentFacts } from "./import/reconcile.js";
import { openMemory, type Memory } from "./memory.js";
import { parseSince, runReport } from "./report/report.js";
import { oneLine } from "./retrieval/session-context.js";
import { IMPORT_CHOICES, type ImportChoice, LIMITS } from "./schemas.js";
import { assertEmbeddedRuntime } from "./storage/database.js";
import { deleteHome, describeHome } from "./storage/home.js";
import { runHook } from "./transports/hook.js";
import { runStdioServer } from "./transports/mcp.js";
import { hostStatus } from "./transports/status.js";

const USAGE = `Usage:
  debrief status                                      Is Debrief installed and working here? (exit 1 when not)
  debrief import [--set ${IMPORT_CHOICES.join("|")}]
                                                      Import past sessions' transcripts, as the user chose (--set records the choice)
  debrief report [--since 7d|24h|<date>] [--all]      Did Debrief help? Usage, what was used, correctness, freshness, cost (this repository; --all: every one)
  debrief report --review [--since …] [--all]         Rate up to 10 random searches from the window (answers read from stdin)
  debrief delete-data [--yes]                         Delete all of Debrief's stored memory, after typing delete (--yes: without asking)
  debrief mcp [--host ${HOST_IDS.join("|")}]
                                                      Serve MCP over stdio (started by the agent host)
  debrief hook stop --host ${HOOK_HOSTS.join("|")}
                                                      Capture the session's latest turn; ask for a stale checkpoint (the host's Stop hook; payload on stdin)
  debrief hook session-start --host ${HOOK_HOSTS.join("|")}
                                                      Print session-start context (run by the host's SessionStart hook; payload on stdin)
  debrief hook subagent-start --host ${HOOK_HOSTS.join("|")}
                                                      Print a sub-agent's starting context (run by the host's SubagentStart hook; payload on stdin)
  debrief hook user-prompt-submit --host ${HOOK_HOSTS.join("|")}
                                                      Hint the agent when a prompt states a lasting preference (payload on stdin)
  debrief hook pre-tool-use --host ${HOOK_HOSTS.join("|")}
                                                      Let Debrief's read-only calls skip the permission prompt (payload on stdin)
  debrief diag status                                 Runtime, storage and scope health
  debrief diag records [--query <text>] [--kind <k>]  List eligible records for this worktree
  debrief diag reindex                                Rebuild the search index from canonical records
  debrief diag integrity                              SQLite, foreign-key and search-index checks
  debrief diag demo [--temp-home]                     Run bootstrap → record → checkpoint → recall here and print the pack
                                                      (writes demo records to $DEBRIEF_HOME, or to a new temp home)
  debrief diag consent [--set ${IMPORT_CHOICES.join("|")}] [--host ${TRANSCRIPT_HOSTS.join("|")}]
                                                      Show (or change) the host's transcript-import decision
  debrief diag import [--host ${TRANSCRIPT_HOSTS.join("|")}]
                                                      Import approved transcripts to completion and print progress

Scope is always the Git worktree of the current directory. Storage: $DEBRIEF_HOME or ~/.debrief.`;

async function main(argv: string[]): Promise<number> {
  const [command, subcommand] = argv;
  if (command === "mcp") {
    const { values } = parseArgs({ args: argv.slice(1), options: { host: { type: "string" } }, strict: true });
    if (values.host !== undefined && hostDescriptor(values.host) === null) return usage(`unknown --host ${values.host}`);
    // Fail at startup, visibly, rather than on the first tool call inside the host.
    assertEmbeddedRuntime();
    await runStdioServer({ cwd: process.cwd(), ...(values.host === undefined ? {} : { host: values.host }) });
    return -1; // keep running until stdin ends or a signal arrives
  }
  if (command === "hook") {
    // A host runs this at its lifecycle events: always exit 0, so a failure never breaks the host.
    let stdin = "";
    try {
      stdin = readFileSync(0, "utf8");
    } catch {
      // No stdin (closed or not readable): the transport reports the empty payload.
    }
    const outcome = runHook({ args: argv.slice(1), stdin, cwd: process.cwd(), home: resolveHome(undefined) });
    process.stdout.write(outcome.stdout);
    process.stderr.write(outcome.stderr);
    return 0;
  }
  if (command === "import") {
    const { values } = parseArgs({ args: argv.slice(1), options: { set: { type: "string" } }, strict: true });
    if (values.set !== undefined && !IMPORT_CHOICES.includes(values.set as ImportChoice)) return usage(`--set must be one of ${IMPORT_CHOICES.join(", ")}`);
    return importHistory(values.set as ImportChoice | undefined);
  }
  if (command === "report") {
    const { values } = parseArgs({ args: argv.slice(1), options: { since: { type: "string", default: "7d" }, all: { type: "boolean" }, review: { type: "boolean" } }, strict: true });
    if (parseSince(values.since, new Date()) === null) return usage(`--since must look like 7d, 24h or 2026-09-22 (got ${values.since})`);
    return runReport({
      cwd: process.cwd(),
      home: resolveHome(undefined),
      since: values.since,
      all: values.all === true,
      review: values.review === true,
      stdin: process.stdin,
      write: (text) => process.stdout.write(text),
    });
  }
  if (command === "delete-data") {
    const { values } = parseArgs({ args: argv.slice(1), options: { yes: { type: "boolean" } }, strict: true });
    return deleteData(values.yes === true);
  }
  if (command === "status") {
    if (argv.length > 1) return usage(`unknown status argument ${argv.slice(1).join(" ")}`);
    return status();
  }
  if (command === "diag" && subcommand !== undefined) {
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        query: { type: "string" },
        kind: { type: "string", multiple: true },
        "temp-home": { type: "boolean" },
        set: { type: "string" },
        host: { type: "string" },
      },
      strict: true,
    });
    const home = values["temp-home"] === true ? mkdtempSync(join(tmpdir(), "debrief-demo-")) : resolveHome(undefined);
    // Transcript commands act as the host whose history they manage; the rest as a diagnostic tool.
    const transcripts = subcommand === "consent" || subcommand === "import";
    // A host that cannot import would only report "unsupported" for a mistyped name.
    if (transcripts && values.host !== undefined && !(TRANSCRIPT_HOSTS as string[]).includes(values.host)) {
      return usage(`--host must be one of ${TRANSCRIPT_HOSTS.join(", ")} (got ${values.host})`);
    }
    const host = values.host ?? (transcripts ? "claude-code" : "debrief-diag");
    if (values.set !== undefined && !IMPORT_CHOICES.includes(values.set as ImportChoice)) return usage(`--set must be one of ${IMPORT_CHOICES.join(", ")}`);
    const memory = openMemory({ cwd: process.cwd(), host, home });
    try {
      return diag(memory, subcommand, values, home);
    } finally {
      memory.close();
    }
  }
  return usage(command === undefined || command === "--help" || command === "help" ? undefined : `unknown command ${argv.join(" ")}`);
}

function diag(memory: Memory, subcommand: string, values: { query?: string | undefined; kind?: string[] | undefined; set?: string | undefined }, home: string): number {
  switch (subcommand) {
    case "consent": {
      const status = values.set === undefined ? memory.status().import : memory.bootstrap({ importChoice: values.set as ImportChoice }).import;
      print({ consent: status?.consent ?? null, state: status?.state ?? null, transcripts: status?.transcripts ?? null, transcriptsRoot: status?.transcriptsRoot ?? null });
      return 0;
    }
    case "import": {
      const started = performance.now();
      let peakRss = process.memoryUsage().rss;
      let afterBootstrapMs: number | null = null;
      const status = memory.importHistory({
        onStep: () => {
          afterBootstrapMs ??= Math.round(performance.now() - started);
          peakRss = Math.max(peakRss, process.memoryUsage().rss);
        },
      });
      print({ elapsedMs: Math.round(performance.now() - started), afterBootstrapMs, peakRssMB: Math.round(peakRss / 1e6), import: status });
      return status.problem === null ? 0 : 1;
    }
    case "status":
      print(memory.status());
      return 0;
    case "reindex":
      print(memory.rebuildSearchIndex());
      return 0;
    case "integrity": {
      const report = memory.checkIntegrity();
      print(report);
      return report.ok ? 0 : 1;
    }
    case "demo":
      print(demo(memory, home));
      return 0;
    case "records": {
      // Pages through recall, so the listing shows exactly what agents can see.
      const request = { maxTokens: LIMITS.maxTokens, ...(values.query === undefined ? {} : { query: values.query }), ...(values.kind === undefined ? {} : { kinds: values.kind }) };
      let pack = memory.recall(request as never);
      const scope = pack.scope;
      process.stdout.write(`${scope.workspaceLabel} / ${scope.workstreamLabel}  head r${scope.headRevision}\n`);
      if (pack.checkpoint !== null) process.stdout.write(`${pack.checkpoint.recordId}  checkpoint r${pack.checkpoint.revision}  ${oneLine(pack.checkpoint.excerpt, 100)}\n`);
      for (;;) {
        for (const item of pack.items) {
          process.stdout.write(`${item.recordId}  ${item.kind}  ${item.attribution}  ${item.reviewState}  ${oneLine(item.title ?? item.excerpt, 100)}\n`);
        }
        if (pack.continuation === null) break;
        pack = memory.recall({ maxTokens: LIMITS.maxTokens, continuation: pack.continuation });
      }
      if (pack.empty) process.stdout.write("(no eligible records)\n");
      return 0;
    }
    default:
      return usage(`unknown diag command ${subcommand}`);
  }
}

/** The hosts `debrief status` and `debrief import` act for: those Debrief installs into as a plugin. */
function installedHosts(): { host: HostId; facts: PluginFacts }[] {
  return HOST_IDS.flatMap((host) => {
    const facts = HOSTS[host].plugin;
    return facts === null ? [] : [{ host, facts }];
  });
}

/**
 * Each host's history imported to completion, under the user's choice (`choice` records it
 * first). Without a choice it puts the question and imports nothing; exit 1 then, or on a problem.
 */
function importHistory(choice: ImportChoice | undefined): number {
  let unsettled = false;
  for (const { host, facts } of installedHosts()) {
    const memory = openMemory({ cwd: process.cwd(), host, home: resolveHome(undefined) });
    try {
      const status = memory.importHistory(choice === undefined ? {} : { importChoice: choice });
      const lines = [`debrief import · ${facts.hostName}`];
      const row = (label: string, value: string): void => {
        lines.push(`  ${label.padEnd(13)}${value}`);
      };
      if (status.state === "consent_required") {
        const question = consentFacts(facts.hostName, status.transcripts ?? { found: 0, currentProject: 0, otherProjects: 0, unassigned: 0, unsupportedVersion: 0 });
        lines.push(question.found, "", question.ask, "", question.privacy, `Answer with debrief import --set ${IMPORT_CHOICES.join("|")}`);
      } else if (status.state === "declined") {
        row("choice", "none: no transcripts are imported");
      } else {
        row("choice", status.consent?.choice ?? status.state);
        const own = status.currentProject;
        if (own !== null) row("this project", `${own.complete} of ${own.transcripts} transcripts imported, ${own.counters.records} records`);
        if (status.backfill !== null && status.backfill.projects > 0) row("other", `${status.backfill.projects} projects, ${status.backfill.transcripts} transcripts${status.backfill.reconciled ? "" : " (still importing)"}`);
        if (status.gaps.length > 0) row("gaps", status.gaps.map((g) => g.message).join(" · "));
      }
      if (status.problem !== null) row("problem", `${status.problem.code}: ${status.problem.message}`);
      process.stdout.write(lines.join("\n") + "\n");
      unsettled ||= status.state === "consent_required" || status.problem !== null;
    } finally {
      memory.close();
    }
  }
  return unsettled ? 1 : 0;
}

/**
 * Shows what `debrief delete-data` deletes and, once confirmed, deletes it. On a terminal the
 * user types `delete`; without one only `--yes` confirms, so a script never deletes by accident.
 */
async function deleteData(yes: boolean): Promise<number> {
  const home = describeHome(resolveHome(undefined));
  if (home.owned.length === 0) {
    process.stdout.write(`No Debrief data at ${home.path}.\n`);
    return 0;
  }
  const size = home.bytes < 1024 * 1024 ? `${(home.bytes / 1024).toFixed(1)} KB` : `${(home.bytes / 1024 / 1024).toFixed(1)} MB`;
  process.stdout.write(
    [
      "debrief delete-data",
      `  path          ${home.path}`,
      `  size          ${size}`,
      `  workspaces    ${home.workspaces}`,
      "",
      "This deletes every repository's memory, the transcript-import choice and the hooks' logs. It cannot be undone.",
      "Close Claude Code sessions first: a running session writes new data as it goes.",
      "This does not uninstall Debrief: run /plugin uninstall debrief@debrief in Claude Code, then npm uninstall -g debrief-cli.",
      "",
    ].join("\n"),
  );
  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write("debrief: delete-data asks for confirmation on a terminal; pass --yes to delete without asking\n");
      return 64;
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    process.stdout.write("Type delete to confirm: ");
    // Ctrl-D closes the input without an answer, and the question would never settle.
    const answer = await new Promise<string | null>((resolve) => {
      prompt.once("close", () => {
        resolve(null);
      });
      prompt.question("").then(resolve, () => {
        resolve(null);
      });
    });
    prompt.close();
    if (answer?.trim() !== "delete") {
      process.stdout.write("Nothing was deleted.\n");
      return 1;
    }
  }
  const { kept, rewritten } = deleteHome(home.path);
  process.stdout.write(`Deleted Debrief's data from ${home.path}.\n`);
  if (kept.length > 0) process.stdout.write(`Kept ${kept.length} entries Debrief did not create: ${kept.join(", ")}\n`);
  if (rewritten.length === 0) return 0;
  process.stdout.write(`A running session wrote ${rewritten.join(", ")} again while deleting: close Claude Code sessions and run debrief delete-data again.\n`);
  return 1;
}

/** Each host Debrief installs into as a plugin, checked from this directory; exit 1 when any has a problem. */
async function status(): Promise<number> {
  let problems = 0;
  for (const { host, facts } of installedHosts()) {
    const memory = openMemory({ cwd: process.cwd(), host, home: resolveHome(undefined) });
    try {
      const report = await hostStatus(host, facts, memory.status(), { cwd: process.cwd(), env: process.env });
      process.stdout.write(report.text);
      problems += report.problems;
    } finally {
      memory.close();
    }
  }
  return problems === 0 ? 0 : 1;
}

/** The tracer-bullet flow through the public interface; returns the recalled pack. */
function demo(memory: Memory, home: string): unknown {
  process.stderr.write(`debrief demo: writing demo records to ${home}\n`);
  const { scope } = memory.bootstrap({ hostSessionId: "debrief-diag-demo" });
  const evidence = memory.record({
    kind: "evidence",
    title: "Debrief demo observation",
    body: "debrief demo tracer: the memory database opened in WAL mode with FTS5 available.",
    attribution: "direct_observation",
  });
  const decision = memory.record({
    kind: "decision",
    body: "debrief demo tracer: keep one SQLite database per workspace.",
    attribution: "agent_inference",
    supportedBy: [evidence.recordId],
  });
  memory.checkpoint({
    expectedRevision: scope.headRevision,
    goal: "debrief demo tracer",
    status: "Recorded one observation and one decision.",
    nextSteps: ["Recall them from a fresh session"],
    supportedBy: [evidence.recordId, decision.recordId],
  });
  return memory.recall({ query: "debrief demo tracer" });
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function usage(problem?: string): number {
  if (problem !== undefined) process.stderr.write(`debrief: ${problem}\n\n`);
  process.stderr.write(USAGE + "\n");
  return problem === undefined ? 0 : 64;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof DebriefError) {
      process.stderr.write(`debrief: ${error.message}\n${JSON.stringify(error.toEnvelope(), null, 2)}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`debrief: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 70;
    }
  },
);
