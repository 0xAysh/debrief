import { estimateTokens } from "../schemas.js";
import { type Db, prepared } from "./database.js";

/**
 * The call log (schema version 8): one row per call Debrief served, for `debrief report`.
 *
 * A row says what was asked and what came back as ids and labels, never a record's body: a
 * forgotten record cannot be rebuilt from the log. Writing one is best effort. It is one insert,
 * and a failure is swallowed, so logging can never change a call's result or a hook's output.
 */

/** One record a call returned, wrote or injected, in the order the host got them. */
export interface Returned {
  id: string;
  kind: string | null;
  freshness: string | null;
  position: number;
}

/** What only the call itself knows, collected while it runs (see `LocalMemory.trace`). */
export interface CallTrace {
  returned: Returned[];
  /** Milliseconds per stage of the call's work (recall: rank, load, freshness, pack). */
  stages: Record<string, number>;
}

/** A call as its transport saw it. */
export interface CallNote {
  source: "tool" | "hook";
  /** The tool (`memory_recall`) or hook event (`session-start`). */
  name: string;
  /** What the caller sent (a tool's arguments); only the fields `describe` names are kept. */
  args?: Record<string, unknown>;
  /** What the call returned, when it succeeded. */
  result?: unknown;
  /** The error code, when it failed. */
  error?: string | null;
  /** Time spent serving the call, without time spent waiting on the user. */
  ms: number;
  /** Bytes the host got back: the tool result's JSON, or the hook's stdout. */
  bytes: number;
  toolUseId?: string;
  hostSessionId?: string;
}

export interface CallRow {
  at: string;
  host: string;
  sessionId: string | null;
  hostSessionId: string | null;
  note: CallNote;
  trace: CallTrace | null;
  /** The call's session is private: the row keeps no query, parameters or ids. */
  private: boolean;
}

export function appendCall(db: Db, row: CallRow): void {
  const { note } = row;
  const described = row.private ? null : describe(note, row.trace);
  prepared(
    db,
    `INSERT INTO call_log (at, host, session_id, host_session_id, tool_use_id, source, name, outcome, query, params, returned, bytes, tokens,
       omitted, empty, continued, continues, ms, stages, erased)
     VALUES ($at, $host, $sessionId, $hostSessionId, $toolUseId, $source, $name, $outcome, $query, $params, $returned, $bytes, $tokens,
       $omitted, $empty, $continued, $continues, $ms, $stages, $erased)`,
  ).run({
    at: row.at,
    host: row.host,
    sessionId: row.sessionId,
    hostSessionId: row.hostSessionId,
    toolUseId: note.toolUseId ?? null,
    source: note.source,
    name: note.name,
    outcome: note.error ?? "ok",
    query: described?.query ?? null,
    params: JSON.stringify(described?.params ?? {}),
    returned: JSON.stringify(described?.returned ?? []),
    bytes: note.bytes,
    tokens: estimateTokens(note.bytes),
    omitted: JSON.stringify(described?.omitted ?? {}),
    empty: described?.empty === undefined ? null : described.empty ? 1 : 0,
    continued: described?.continued === true ? 1 : 0,
    continues: described?.continues === true ? 1 : 0,
    ms: note.ms,
    stages: JSON.stringify(row.trace?.stages ?? {}),
    erased: row.private ? "private" : null,
  });
}

/** Forgetting records blanks what the calls that returned or wrote them asked; their ids stay, as tombstones do. */
export function forgetCallsReturning(db: Db, recordIds: readonly string[]): void {
  prepared(
    db,
    `UPDATE call_log SET query = NULL, erased = coalesce(erased, 'forgotten')
     WHERE EXISTS (SELECT 1 FROM json_each(call_log.returned) r WHERE json_extract(r.value, '$.id') IN (SELECT value FROM json_each(?)))`,
  ).run(JSON.stringify(recordIds));
}

/**
 * A private session keeps no trace of what it asked or got: its rows keep only name, time, size
 * and outcome. Rows are found by Debrief session, and by host session (a hook's row may name only that).
 */
export function forgetSessionCalls(db: Db, host: string, sessions: readonly string[]): void {
  prepared(
    db,
    `UPDATE call_log SET query = NULL, params = '{}', returned = '[]', omitted = '{}', erased = 'private'
     WHERE session_id IN (SELECT value FROM json_each($sessions))
        OR (host = $host AND host_session_id IN (
          SELECT host_session_id FROM sessions WHERE id IN (SELECT value FROM json_each($sessions)) AND host_session_id IS NOT NULL))`,
  ).run({ host, sessions: JSON.stringify(sessions) });
}

interface Described {
  query?: string;
  params: Record<string, unknown>;
  returned: Returned[];
  omitted?: Record<string, number>;
  empty?: boolean;
  continued?: boolean;
  continues?: boolean;
}

/**
 * What a row keeps of a call. Only the fields named here: a record's body, a checkpoint's text or
 * a preference's wording is never kept, only its size.
 */
function describe(note: CallNote, trace: CallTrace | null): Described {
  const args = note.args ?? {};
  const result = (note.result ?? {}) as Record<string, unknown>;
  const returned = trace?.returned ?? [];
  const pick = (...keys: string[]): Record<string, unknown> => Object.fromEntries(keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
  switch (note.name) {
    case "memory_recall":
      return {
        ...(typeof args["query"] === "string" ? { query: args["query"] } : {}),
        params: pick("kinds", "mode", "maxBytes", "maxTokens"),
        returned,
        ...packShape(result),
        continued: typeof args["continuation"] === "string",
      };
    case "memory_bootstrap":
      return { params: pick("maxBytes", "maxTokens", "importChoice", "workstream"), returned, ...packShape((result["context"] ?? {}) as Record<string, unknown>) };
    case "memory_read":
      return { params: pick("recordId", "around", "offset", "maxBytes", "maxTokens"), returned, continues: result["nextOffset"] !== undefined && result["nextOffset"] !== null };
    case "memory_record":
    case "memory_checkpoint": {
      const written = typeof result["recordId"] === "string" ? [{ id: result["recordId"], kind: typeof result["kind"] === "string" ? result["kind"] : note.name === "memory_checkpoint" ? "checkpoint" : null, freshness: null, position: 0 }] : [];
      const text = ["body", "goal", "status"].map((key) => args[key]).filter((value): value is string => typeof value === "string");
      return {
        params: { ...pick("kind", "attribution", "workspaceLevel", "expectedRevision"), textBytes: text.reduce((n, value) => n + Buffer.byteLength(value, "utf8"), 0) },
        returned: written,
      };
    }
    case "memory_manage": {
      const ids = [...(typeof args["recordId"] === "string" ? [args["recordId"]] : []), ...(Array.isArray(args["recordIds"]) ? args["recordIds"].filter((id): id is string => typeof id === "string") : [])];
      return { params: pick("action"), returned: ids.map((id, position) => ({ id, kind: null, freshness: null, position })) };
    }
    default:
      // Hooks and memory_status: what was injected, if anything (the trace).
      return { params: {}, returned };
  }
}

function packShape(pack: Record<string, unknown>): Pick<Described, "omitted" | "empty" | "continues"> {
  const omissions = Array.isArray(pack["omissions"]) ? (pack["omissions"] as { reason: string; count: number }[]) : [];
  return {
    omitted: Object.fromEntries(omissions.map((omission) => [omission.reason, omission.count])),
    ...(typeof pack["empty"] === "boolean" ? { empty: pack["empty"] } : {}),
    continues: typeof pack["continuation"] === "string",
  };
}
