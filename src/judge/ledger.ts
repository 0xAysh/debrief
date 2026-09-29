import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Db } from "../storage/database.js";

/**
 * `$DEBRIEF_HOME/jev.sqlite`: what Jev was asked and what it cost, shared by every Debrief
 * process on the machine (WAL, like the workspace databases). It holds no memory content:
 *
 * - `usage`: per UTC day, requests sent, how many failed, and the tokens TypeSafe reported.
 * - `verdicts`: one judgment per (workspace, record, reference, observed version, current
 *   version). A verdict is about one pair of versions, so the same pair is never asked twice,
 *   and a further edit (a new current version) is a new question. `skipped` marks a pair
 *   Debrief decided not to send (the diff is too large, the text holds a credential), so that
 *   decision is not re-made on every recall either.
 *
 * It is created by the first judgment, never by a read: `debrief status` opens it read-only if
 * it exists. It is a separate file, not a table in the workspace schema, because it is a cache
 * and a meter (deleting it loses no memory) and it stays out of the migration sequence.
 */

export interface Usage {
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
}

export interface VerdictKey {
  workspaceId: string;
  recordId: string;
  /** The reference: its index in the record and its path. */
  ref: string;
  /** `<commit>:<sha256 of the observed file>`. */
  observed: string;
  /** `sha256:` of the file now. */
  current: string;
}

export interface CachedVerdict {
  verdict: "still_holds" | "invalidated" | null;
  probability: number | null;
  model: string | null;
  /** Why the pair was not sent; null for a verdict. */
  skipped: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS verdicts (
  workspace_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  observed TEXT NOT NULL,
  current TEXT NOT NULL,
  verdict TEXT CHECK (verdict IN ('still_holds', 'invalidated')),
  probability REAL,
  model TEXT,
  skipped TEXT,
  judged_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, record_id, ref, observed, current)
) STRICT;`;

export const LEDGER_FILE = "jev.sqlite";

export class JevLedger {
  private readonly db: Db;

  private constructor(db: Db) {
    this.db = db;
  }

  /** Opens (creating) the ledger for writing. */
  static open(home: string, busyTimeoutMs = 5_000): JevLedger {
    mkdirSync(home, { recursive: true });
    const db = new Database(join(home, LEDGER_FILE), { timeout: busyTimeoutMs });
    try {
      db.pragma(`busy_timeout = ${busyTimeoutMs}`);
      db.pragma("journal_mode = WAL");
      db.exec(SCHEMA);
      return new JevLedger(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** Reads the ledger if one exists (status); null when there is none yet. */
  static openReadOnly(home: string): JevLedger | null {
    const path = join(home, LEDGER_FILE);
    if (!existsSync(path)) return null;
    try {
      return new JevLedger(new Database(path, { readonly: true, fileMustExist: true }));
    } catch {
      return null;
    }
  }

  /** One request sent: `usage` when it was answered, null when it failed. */
  count(at: Date, usage: { inputTokens: number; outputTokens: number } | null): void {
    this.db
      .prepare(
        `INSERT INTO usage (day, calls, failures, input_tokens, output_tokens) VALUES (?, 1, ?, ?, ?)
         ON CONFLICT (day) DO UPDATE SET calls = calls + 1, failures = failures + excluded.failures,
           input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`,
      )
      .run(at.toISOString().slice(0, 10), usage === null ? 1 : 0, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0);
  }

  /** Per UTC day, newest first. */
  days(): (Usage & { day: string })[] {
    return (
      this.db.prepare("SELECT day, calls, failures, input_tokens, output_tokens FROM usage ORDER BY day DESC").all() as {
        day: string;
        calls: number;
        failures: number;
        input_tokens: number;
        output_tokens: number;
      }[]
    ).map((row) => ({ day: row.day, calls: row.calls, failures: row.failures, inputTokens: row.input_tokens, outputTokens: row.output_tokens }));
  }

  verdict(key: VerdictKey): CachedVerdict | undefined {
    const row = this.db
      .prepare("SELECT verdict, probability, model, skipped FROM verdicts WHERE workspace_id = ? AND record_id = ? AND ref = ? AND observed = ? AND current = ?")
      .get(key.workspaceId, key.recordId, key.ref, key.observed, key.current) as CachedVerdict | undefined;
    return row;
  }

  save(key: VerdictKey, verdict: CachedVerdict, at: Date): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO verdicts (workspace_id, record_id, ref, observed, current, verdict, probability, model, skipped, judged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(key.workspaceId, key.recordId, key.ref, key.observed, key.current, verdict.verdict, verdict.probability, verdict.model, verdict.skipped, at.toISOString());
  }

  close(): void {
    this.db.close();
  }
}

/** Today's usage (UTC) and the total, from a ledger's days. */
export function usageSummary(days: readonly (Usage & { day: string })[], today: Date): { today: Usage; total: Usage } {
  const zero = (): Usage => ({ calls: 0, failures: 0, inputTokens: 0, outputTokens: 0 });
  const add = (sum: Usage, day: Usage): Usage => ({
    calls: sum.calls + day.calls,
    failures: sum.failures + day.failures,
    inputTokens: sum.inputTokens + day.inputTokens,
    outputTokens: sum.outputTokens + day.outputTokens,
  });
  const key = today.toISOString().slice(0, 10);
  return { today: days.filter((day) => day.day === key).reduce(add, zero()), total: days.reduce(add, zero()) };
}
