import { approves, readConsent } from "../import/consent.js";
import { type Db, prepared } from "../storage/database.js";

/**
 * What `debrief report` computes from one workspace database: the call log (#69) joined with what
 * Debrief imported from the host's transcripts. Offline and read only.
 *
 * Times: a call's time is `call_log.at`, Debrief's clock when it served the call. A transcript
 * action's time is its result's record `created_at` (the transcript's timestamp). Both come from
 * the same machine's clock; Debrief's own calls have no transcript timestamp (their results are
 * echoes, never records).
 */

/** A workspace the report covers. */
export interface ReportWorkspace {
  label: string;
  /** Consent names repositories: the current key and former ones. */
  repositoryKeys: string[];
  dbPath: string;
}

export interface ReportData {
  labels: string[];
  sessions: number;
  searchedSessions: number;
  searches: number;
  emptySearches: number;
  /** Sessions whose transcripts were imported (consent): the sections that need them cover only these. */
  importedSessions: number;
  used: Record<ReturnSource, UsedTally>;
  returnedRecords: number;
  laterWrong: { id: string; lifecycle: string }[];
  freshness: { current: number; stale: number; unknown: number };
  staleEdited: { total: number; rechecked: number };
  rediscovery: { id: string; path: string; session: string }[];
  /** Milliseconds per call name, and per recall stage. */
  latency: Map<string, number[]>;
  stages: Map<string, number[]>;
  /** Estimated tokens Debrief put into each session (everything but Stop). */
  injected: number[];
  reviews: { good: number; partial: number; missed: number; notes: { rating: string; query: string | null; note: string }[]; unrated: number };
}

export type ReturnSource = "recall" | "start";
export interface UsedTally {
  returned: number;
  used: number;
  read: number;
  cited: number;
  edited: number;
}

/** The recalls `--review` offers: first pages that succeeded, not in a private session, not yet rated. */
export const REVIEWABLE = `name = 'memory_recall' AND continued = 0 AND outcome = 'ok' AND (erased IS NULL OR erased = 'forgotten')
  AND NOT EXISTS (SELECT 1 FROM call_reviews r WHERE r.call_id = call_log.id)`;

/** Calls whose `returned` puts records in front of the agent (a read's record was asked for; a write's was written). */
const RETURNING: Record<string, ReturnSource> = { memory_recall: "recall", memory_bootstrap: "recall", "session-start": "start", "subagent-start": "start" };
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

interface CallRow {
  id: number;
  at: string;
  host: string;
  session: string;
  name: string;
  query: string | null;
  params: Record<string, unknown>;
  returned: { id: string; kind: string | null; freshness: string | null }[];
  tokens: number;
  empty: number | null;
  continued: number;
  ms: number;
  stages: Record<string, number>;
}

interface Activity {
  session: string;
  kind: "read" | "edit";
  path: string;
  at: string;
}

export function emptyReport(labels: string[]): ReportData {
  const tally = (): UsedTally => ({ returned: 0, used: 0, read: 0, cited: 0, edited: 0 });
  return {
    labels,
    sessions: 0,
    searchedSessions: 0,
    searches: 0,
    emptySearches: 0,
    importedSessions: 0,
    used: { recall: tally(), start: tally() },
    returnedRecords: 0,
    laterWrong: [],
    freshness: { current: 0, stale: 0, unknown: 0 },
    staleEdited: { total: 0, rechecked: 0 },
    rediscovery: [],
    latency: new Map(),
    stages: new Map(),
    injected: [],
    reviews: { good: 0, partial: 0, missed: 0, notes: [], unrated: 0 },
  };
}

export function hasTable(db: Db, name: string): boolean {
  return prepared(db, "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** One workspace's report for calls at or after `since` (ISO time). `home` holds the consent file. */
export function collect(db: Db, workspace: ReportWorkspace, since: string, home: string): ReportData {
  const data = emptyReport([workspace.label]);
  const calls = (prepared(db, "SELECT * FROM call_log WHERE at >= ? ORDER BY at, id").all(since) as Record<string, unknown>[]).map(toCallRow);

  // ── Usage and cost: the call log alone ──
  const sessions = group(calls, (call) => call.session);
  data.sessions = sessions.size;
  for (const rows of sessions.values()) {
    const searches = rows.filter((row) => row.name === "memory_recall" && row.continued === 0);
    if (searches.length > 0) data.searchedSessions++;
    data.searches += searches.length;
    data.emptySearches += searches.filter((row) => row.empty === 1).length;
    data.injected.push(rows.filter((row) => row.name !== "stop").reduce((sum, row) => sum + row.tokens, 0));
  }
  for (const call of calls) {
    push(data.latency, call.name, call.ms);
    if (call.name === "memory_recall") for (const [stage, ms] of Object.entries(call.stages)) push(data.stages, stage, ms);
  }

  // ── What was returned: first time each record reached each session, per source ──
  const units = new Map<string, { session: string; id: string; source: ReturnSource; at: string; freshness: string | null }>();
  for (const call of calls) {
    const source = RETURNING[call.name];
    if (source === undefined) continue;
    for (const item of call.returned) {
      if (item.freshness === "current" || item.freshness === "stale" || item.freshness === "unknown") data.freshness[item.freshness]++;
      const key = `${call.session}\u0000${item.id}\u0000${source}`;
      if (!units.has(key)) units.set(key, { session: call.session, id: item.id, source, at: call.at, freshness: item.freshness });
    }
  }
  const returnedIds = [...new Set([...units.values()].map((unit) => unit.id))];
  data.returnedRecords = returnedIds.length;
  const records = recordsById(db, returnedIds);
  data.laterWrong = returnedIds
    .map((id) => ({ id, lifecycle: records.get(id)?.lifecycle ?? "forgotten" }))
    .filter((record) => record.lifecycle !== "active");

  // ── What needs imported transcripts: sessions whose host's consent covers this repository and whose transcript is in ──
  const approvedHosts = new Set([...new Set(calls.map((call) => call.host))].filter((host) => workspace.repositoryKeys.some((key) => approves(readConsent(home, host), key))));
  const transcripts = importedTranscripts(db);
  const imported = new Set([...sessions].filter(([session, rows]) => rows.some((row) => approvedHosts.has(row.host) && transcripts.has(`${row.host}\u0000${session}`))).map(([session]) => session));
  data.importedSessions = imported.size;
  if (imported.size === 0) {
    fillReviews(db, data, since);
    return data;
  }
  const activity = group(transcriptActivity(db, since).filter((a) => imported.has(a.session)), (a) => a.session);
  const cites = group(citations(db, since), (cite) => cite.id);

  for (const unit of units.values()) {
    if (!imported.has(unit.session)) continue;
    const tally = data.used[unit.source];
    tally.returned++;
    const read = (sessions.get(unit.session) ?? []).some((call) => call.name === "memory_read" && call.at > unit.at && call.params["recordId"] === unit.id);
    const cited = (cites.get(unit.id) ?? []).some((cite) => cite.session === unit.session && cite.at > unit.at);
    const paths = codePaths(records.get(unit.id)?.external_refs);
    const edited = (activity.get(unit.session) ?? []).some((a) => a.kind === "edit" && a.at > unit.at && paths.has(a.path));
    if (read) tally.read++;
    if (cited) tally.cited++;
    if (edited) tally.edited++;
    if (read || cited || edited) tally.used++;
  }

  // A stale record: did the agent read the file before it first edited it?
  const stale = new Map<string, { session: string; id: string; at: string }>();
  for (const unit of units.values()) {
    const key = `${unit.session}\u0000${unit.id}`;
    const seen = stale.get(key);
    if (unit.freshness === "stale" && imported.has(unit.session) && (seen === undefined || unit.at < seen.at)) stale.set(key, unit);
  }
  for (const unit of stale.values()) {
    const paths = codePaths(records.get(unit.id)?.external_refs);
    const inSession = activity.get(unit.session) ?? [];
    const edit = inSession.filter((a) => a.kind === "edit" && a.at > unit.at && paths.has(a.path)).sort(byTime)[0];
    if (edit === undefined) continue;
    data.staleEdited.total++;
    if (inSession.some((a) => a.kind === "read" && a.path === edit.path && a.at > unit.at && a.at < edit.at)) data.staleEdited.rechecked++;
  }

  // Rediscovery: a file read in a session where the agent-written record covering it never came back.
  const covering = group(
    agentWrittenCode(db).flatMap((record) => [...record.paths].map((path) => ({ ...record, path }))),
    (record) => record.path,
  );
  const seenIn = new Map<string, Set<string>>();
  for (const call of calls) {
    const ids = seenIn.get(call.session) ?? new Set<string>();
    for (const item of call.returned) ids.add(item.id);
    seenIn.set(call.session, ids);
  }
  const listed = new Set<string>();
  for (const read of [...activity.values()].flat().filter((a) => a.kind === "read").sort(byTime)) {
    for (const record of covering.get(read.path) ?? []) {
      const key = `${record.id}\u0000${read.path}\u0000${read.session}`;
      if (listed.has(key) || record.createdAt >= read.at || seenIn.get(read.session)?.has(record.id) === true) continue;
      listed.add(key);
      data.rediscovery.push({ id: record.id, path: read.path, session: read.session });
    }
  }

  fillReviews(db, data, since);
  return data;
}

function fillReviews(db: Db, data: ReportData, since: string): void {
  if (!hasTable(db, "call_reviews")) {
    data.reviews.unrated = (prepared(db, "SELECT count(*) AS n FROM call_log WHERE at >= ? AND name = 'memory_recall' AND continued = 0 AND outcome = 'ok' AND (erased IS NULL OR erased = 'forgotten')").get(since) as { n: number }).n;
    return;
  }
  const rated = prepared(db, "SELECT r.rating, r.note, c.query FROM call_reviews r JOIN call_log c ON c.id = r.call_id WHERE c.at >= ? ORDER BY c.at, c.id").all(since) as { rating: "good" | "partial" | "missed"; note: string | null; query: string | null }[];
  for (const review of rated) {
    data.reviews[review.rating]++;
    if (review.note !== null) data.reviews.notes.push({ rating: review.rating, query: review.query, note: review.note });
  }
  data.reviews.unrated = (prepared(db, `SELECT count(*) AS n FROM call_log WHERE at >= ? AND ${REVIEWABLE}`).get(since) as { n: number }).n;
}

/** Several workspaces' reports as one. */
export function merge(reports: ReportData[]): ReportData {
  const all = emptyReport(reports.flatMap((report) => report.labels));
  for (const report of reports) {
    all.sessions += report.sessions;
    all.searchedSessions += report.searchedSessions;
    all.searches += report.searches;
    all.emptySearches += report.emptySearches;
    all.importedSessions += report.importedSessions;
    for (const source of ["recall", "start"] as const) for (const key of Object.keys(all.used[source]) as (keyof UsedTally)[]) all.used[source][key] += report.used[source][key];
    all.returnedRecords += report.returnedRecords;
    all.laterWrong.push(...report.laterWrong);
    for (const label of ["current", "stale", "unknown"] as const) all.freshness[label] += report.freshness[label];
    all.staleEdited.total += report.staleEdited.total;
    all.staleEdited.rechecked += report.staleEdited.rechecked;
    all.rediscovery.push(...report.rediscovery);
    for (const [name, values] of report.latency) for (const ms of values) push(all.latency, name, ms);
    for (const [name, values] of report.stages) for (const ms of values) push(all.stages, name, ms);
    all.injected.push(...report.injected);
    for (const rating of ["good", "partial", "missed"] as const) all.reviews[rating] += report.reviews[rating];
    all.reviews.notes.push(...report.reviews.notes);
    all.reviews.unrated += report.reviews.unrated;
  }
  return all;
}

function toCallRow(row: Record<string, unknown>): CallRow {
  const json = <T>(value: unknown, fallback: T): T => (typeof value === "string" ? (JSON.parse(value) as T) : fallback);
  const hostSession = row["host_session_id"] as string | null;
  const session = row["session_id"] as string | null;
  return {
    id: row["id"] as number,
    at: row["at"] as string,
    host: row["host"] as string,
    // A call a host session made; without one, its Debrief session; without either, its own.
    session: hostSession ?? session ?? `call:${String(row["id"])}`,
    name: row["name"] as string,
    query: row["query"] as string | null,
    params: json(row["params"], {}),
    returned: json(row["returned"], []),
    tokens: row["tokens"] as number,
    empty: row["empty"] as number | null,
    continued: row["continued"] as number,
    ms: row["ms"] as number,
    stages: json(row["stages"], {}),
  };
}

function recordsById(db: Db, ids: readonly string[]): Map<string, { lifecycle: string; external_refs: string }> {
  const rows = prepared(db, "SELECT id, lifecycle, external_refs FROM records WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as { id: string; lifecycle: string; external_refs: string }[];
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The files an imported session read and edited, each at its result's time. A call and its result
 * are two `import_events` rows sharing `meta.callId`; they are joined here rather than in SQL,
 * which has no index on that key. A sub-agent's transcript (`<session>/agent-<id>`) counts as its
 * parent's session.
 */
function transcriptActivity(db: Db, since: string): Activity[] {
  const calls = prepared(
    db,
    `SELECT host, transcript_id AS transcript, json_extract(meta, '$.callId') AS callId, json_extract(meta, '$.tool') AS tool,
            json_extract(meta, '$.paths') AS paths, json_extract(meta, '$.read.path') AS readPath
     FROM import_events WHERE disposition = 'tool_call'`,
  ).all() as { host: string; transcript: string; callId: string | null; tool: string | null; paths: string | null; readPath: string | null }[];
  const wanted = new Map<string, { transcript: string; kind: Activity["kind"]; paths: string[] }>();
  for (const call of calls) {
    if (call.callId === null) continue;
    const paths = call.paths === null ? [] : (JSON.parse(call.paths) as string[]);
    if (call.tool !== null && EDIT_TOOLS.has(call.tool) && paths.length > 0) wanted.set(`${call.host}\u0000${call.transcript}\u0000${call.callId}`, { transcript: call.transcript, kind: "edit", paths });
    else if (call.readPath !== null || (call.tool === "Read" && paths.length > 0)) wanted.set(`${call.host}\u0000${call.transcript}\u0000${call.callId}`, { transcript: call.transcript, kind: "read", paths: call.readPath === null ? paths.slice(0, 1) : [call.readPath] });
  }
  if (wanted.size === 0) return [];
  const results = prepared(
    db,
    `SELECT e.host, e.transcript_id AS transcript, json_extract(e.meta, '$.callId') AS callId, r.created_at AS at
     FROM import_events e JOIN records r ON r.id = e.record_id
     WHERE e.disposition = 'record' AND r.created_at >= ? AND json_extract(e.meta, '$.callId') IS NOT NULL`,
  ).all(since) as { host: string; transcript: string; callId: string; at: string }[];
  const activity: Activity[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const key = `${result.host}\u0000${result.transcript}\u0000${result.callId}`;
    const call = wanted.get(key);
    if (call === undefined || seen.has(key)) continue;
    seen.add(key);
    const session = call.transcript.split("/agent-")[0] ?? call.transcript;
    for (const path of call.paths) activity.push({ session, kind: call.kind, path: normalPath(path), at: result.at });
  }
  return activity;
}

/** `host\0session` of every transcript Debrief imported; a sub-agent's counts as its parent session's. */
function importedTranscripts(db: Db): Set<string> {
  const rows = prepared(db, "SELECT host, transcript_id AS transcript FROM import_cursors").all() as { host: string; transcript: string }[];
  return new Set(rows.map((row) => `${row.host}\u0000${row.transcript.split("/agent-")[0] ?? row.transcript}`));
}

/** Records an agent wrote (not imported) that cite others, with when and in which session. `supersedes` is a lifecycle change, not a citation. */
function citations(db: Db, since: string): { id: string; at: string; session: string }[] {
  return prepared(
    db,
    `SELECT l.to_id AS id, f.created_at AS at, coalesce(s.host_session_id, f.session_id) AS session
     FROM links l JOIN records f ON f.id = l.from_id LEFT JOIN sessions s ON s.id = f.session_id
     WHERE l.relation <> 'supersedes' AND f.created_at >= ? AND NOT EXISTS (SELECT 1 FROM import_events e WHERE e.record_id = f.id)`,
  ).all(since) as { id: string; at: string; session: string }[];
}

/** Active agent-written records citing code, with the files they cite. Imported evidence never counts. */
function agentWrittenCode(db: Db): { id: string; createdAt: string; paths: Set<string> }[] {
  const rows = prepared(
    db,
    `SELECT r.id, r.created_at AS createdAt, r.external_refs AS refs FROM records r
     WHERE r.lifecycle = 'active' AND r.external_refs <> '[]' AND NOT EXISTS (SELECT 1 FROM import_events e WHERE e.record_id = r.id)`,
  ).all() as { id: string; createdAt: string; refs: string }[];
  return rows.map((row) => ({ id: row.id, createdAt: row.createdAt, paths: codePaths(row.refs) })).filter((row) => row.paths.size > 0);
}

/** The repository files a record's references cite (`locator`, since `path` is optional). */
function codePaths(refs: string | undefined): Set<string> {
  if (refs === undefined) return new Set();
  const parsed = JSON.parse(refs) as { kind?: string; locator?: string; path?: string }[];
  return new Set(parsed.filter((ref) => ref.kind === "code").flatMap((ref) => [ref.locator, ref.path].filter((p): p is string => typeof p === "string").map(normalPath)));
}

function normalPath(path: string): string {
  return path.replace(/^(\.\/)+/, "");
}

function group<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const values = groups.get(key(item));
    if (values === undefined) groups.set(key(item), [item]);
    else values.push(item);
  }
  return groups;
}

function push(map: Map<string, number[]>, key: string, value: number): void {
  const values = map.get(key);
  if (values === undefined) map.set(key, [value]);
  else values.push(value);
}

function byTime(a: { at: string }, b: { at: string }): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
}
