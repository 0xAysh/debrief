import type { ReportData, UsedTally } from "./collect.js";

/**
 * `debrief report` as plain aligned text, one section per question in #69. It never shows a
 * token "saving": Debrief cannot know what the agent would have spent without it.
 */

const CAVEATS = [
  "Debrief's net effect on tokens can be zero or negative: session-start context is paid every session, and a good agent re-reads files to verify.",
  "Only paired runs with and without Debrief give a causal number.",
  "One person's week finds failures; it does not prove value.",
];
const SIGNALS = '"Used after returned" and "Rediscovery" are signals to inspect, not measures of quality.';
const MAX_LISTED = 20;

export function renderReport(data: ReportData, window: { from: Date; to: Date; since: string }): string {
  const out: string[] = [];
  const row = (label: string, value: string, indent = 2): void => {
    out.push(`${" ".repeat(indent)}${label.padEnd(16)}${value}`);
  };
  const heading = (title: string): void => {
    out.push("", title);
  };
  const workspaces = data.labels.length === 1 ? (data.labels[0] ?? "") : `all workspaces (${data.labels.length}): ${data.labels.join(", ")}`;
  out.push(`debrief report · ${workspaces} · ${day(window.from)} → ${day(window.to)} (${window.since})`);
  const imported = data.importedSessions > 0;

  heading("Usage");
  row("sessions", `${count(data.sessions)}searched ${data.searchedSessions} · never ${data.sessions - data.searchedSessions}`);
  const perSession = data.sessions === 0 ? "0.0" : (data.searches / data.sessions).toFixed(1);
  const empty = data.searches === 0 ? `empty 0` : `empty ${data.emptySearches} (${Math.round((100 * data.emptySearches) / data.searches)}%)`;
  row("searches", `${count(data.searches)}${perSession} per session · ${empty}`);

  if (imported) {
    heading("Used after returned  (a signal, not a score)");
    row("recall", used(data.used.recall));
    if (data.used.start.returned > 0) row("session start", used(data.used.start));
  }

  heading("Correctness");
  row("later wrong", `${data.laterWrong.length} of ${data.returnedRecords} returned`);
  for (const record of data.laterWrong.slice(0, MAX_LISTED)) out.push(`    ${record.id}  ${record.lifecycle}`);
  more(out, data.laterWrong.length);

  heading("Freshness");
  row("returned", `current ${data.freshness.current} · stale ${data.freshness.stale} · unknown ${data.freshness.unknown}`);
  if (imported) {
    const { total, rechecked } = data.staleEdited;
    row("stale, edited", total === 0 ? "0" : `${count(total)}re-checked first ${rechecked} · not ${total - rechecked}`);
  }

  if (imported) {
    heading("Rediscovery  (a signal, not a score)");
    row("re-read", data.rediscovery.length === 0 ? "0" : `${count(data.rediscovery.length)}files memory already covered, read where that record was not returned`);
    for (const found of data.rediscovery.slice(0, MAX_LISTED)) out.push(`    ${found.id}  ${found.path}  session ${found.session.slice(0, 8)}`);
    more(out, data.rediscovery.length);
  }

  heading("Cost");
  out.push(`  ${"latency ms".padEnd(20)}${"calls".padStart(6)}${"p50".padStart(9)}${"p95".padStart(9)}`);
  const names = [...data.latency.keys()].sort((a, b) => (a === "memory_recall" ? -1 : b === "memory_recall" ? 1 : (data.latency.get(b)?.length ?? 0) - (data.latency.get(a)?.length ?? 0) || a.localeCompare(b)));
  for (const name of names) {
    const values = data.latency.get(name) ?? [];
    out.push(`    ${name.padEnd(18)}${String(values.length).padStart(6)}${ms(percentile(values, 0.5))}${ms(percentile(values, 0.95))}`);
    if (name !== "memory_recall") continue;
    for (const stage of ["rank", "load", "freshness", "pack"]) {
      const stageValues = data.stages.get(stage);
      if (stageValues !== undefined) out.push(`      ${stage.padEnd(16)}${"".padStart(6)}${ms(percentile(stageValues, 0.5))}${ms(percentile(stageValues, 0.95))}`);
    }
  }
  if (data.injected.length > 0) {
    row(
      "injected tokens",
      `p50 ${percentile(data.injected, 0.5).toLocaleString("en-US")} · p95 ${percentile(data.injected, 0.95).toLocaleString("en-US")} per session · ${plural(data.injected.length, "session")} (estimate: bytes ÷ 4)`,
    );
  }

  heading("Your reviews");
  const { good, partial, missed, notes, unrated } = data.reviews;
  row("rated", `${count(good + partial + missed)}good ${good} · partial ${partial} · missed ${missed}`);
  for (const note of notes.slice(0, MAX_LISTED)) out.push(`    ${note.rating.padEnd(8)} ${note.query === null ? "(query erased)" : JSON.stringify(note.query)}: ${note.note}`);
  more(out, notes.length);
  if (unrated > 0) row("unrated", `${count(unrated)}searches: debrief report --review`);

  if (!imported && data.sessions > 0) {
    out.push("", "What the agent did with what came back (use, stale edits, rediscovery) needs imported transcripts: run debrief import");
  } else if (imported && data.importedSessions < data.sessions) {
    out.push("", `Use, stale edits and rediscovery cover the ${data.importedSessions} of ${data.sessions} sessions with imported transcripts; the others need imported transcripts: run debrief import`);
  }

  heading("Caveats");
  for (const caveat of imported ? [...CAVEATS, SIGNALS] : CAVEATS) out.push(`  · ${caveat}`);
  return out.join("\n") + "\n";
}

function used(tally: UsedTally): string {
  return `${count(tally.returned)}used ${tally.used} (read ${tally.read} · cited ${tally.cited} · file edited ${tally.edited}) · unused ${tally.returned - tally.used}`;
}

function more(out: string[], total: number): void {
  if (total > MAX_LISTED) out.push(`    … and ${total - MAX_LISTED} more`);
}

/** Nearest rank: the smallest value with at least `p` of the values at or below it. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

function ms(value: number): string {
  return value.toFixed(1).padStart(9);
}

/** A count in the first column, always followed by a space. */
function count(n: number): string {
  return `${n} `.padEnd(5);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The local calendar day, as the user reads the window. */
export function day(date: Date): string {
  return localTime(date).slice(0, 10);
}

/** `YYYY-MM-DD HH:MM` in local time. */
export function localTime(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
