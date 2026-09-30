import { randomInt } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { type Db, prepared } from "../storage/database.js";
import { REVIEWABLE } from "./collect.js";
import { localTime } from "./render.js";

/**
 * `debrief report --review`: the user rates up to 10 searches sampled at random from the window,
 * each shown with what came back as it is now (a forgotten record shows as `[forgotten]`, never
 * its old text). Answers are read line by line from stdin, a terminal or a pipe; each rating is
 * stored as it is given, so quitting keeps the ones before.
 */

export const REVIEW_SAMPLE = 10;
const NOTE_CHARS = 500;
const RATINGS = { g: "good", p: "partial", m: "missed" } as const;

export interface ReviewSource {
  label: string;
  db: Db;
}

interface Candidate {
  source: ReviewSource;
  id: number;
  at: string;
  query: string | null;
  returned: { id: string; freshness: string | null }[];
}

export async function review(sources: readonly ReviewSource[], since: string, window: string, input: NodeJS.ReadableStream, write: (text: string) => void): Promise<number> {
  const candidates = sources.flatMap((source) =>
    (prepared(source.db, `SELECT id, at, query, returned FROM call_log WHERE at >= ? AND ${REVIEWABLE}`).all(since) as { id: number; at: string; query: string | null; returned: string }[]).map(
      (row): Candidate => ({ source, id: row.id, at: row.at, query: row.query, returned: JSON.parse(row.returned) as Candidate["returned"] }),
    ),
  );
  if (candidates.length === 0) {
    write(`No unrated searches from ${window}.\n`);
    return 0;
  }
  const offered = sample(candidates, REVIEW_SAMPLE);
  write(`debrief report --review · ${offered.length} of ${candidates.length} unrated searches from ${window}\n`);
  const reader = createInterface({ input, terminal: false });
  const lines = reader[Symbol.asyncIterator]();
  const next = async (prompt: string): Promise<string | null> => {
    write(prompt);
    const answer = await lines.next();
    return answer.done === true ? null : answer.value.trim();
  };

  let stored: number;
  try {
    stored = await rate(offered, sources.length > 1, write, next);
  } finally {
    // A terminal's stdin stays open: without this the command never exits.
    reader.close();
  }
  write(`\nStored ${stored} rating${stored === 1 ? "" : "s"}. debrief report shows them.\n`);
  return 0;
}

/** Asks for each offered search in turn and stores each rating as it is given; returns how many were stored. */
async function rate(offered: readonly Candidate[], showLabel: boolean, write: (text: string) => void, next: (prompt: string) => Promise<string | null>): Promise<number> {
  let stored = 0;
  for (const [index, candidate] of offered.entries()) {
    write(`\n[${index + 1}/${offered.length}] ${localTime(new Date(candidate.at))}  ${candidate.query === null ? "(query erased)" : JSON.stringify(candidate.query)}${showLabel ? `  · ${candidate.source.label}` : ""}\n`);
    write(describeReturned(candidate));
    let rating: (typeof RATINGS)[keyof typeof RATINGS] | "skip" | "quit" | null = null;
    while (rating === null) {
      const answer = await next("Rate it: g good · p partial · m missed something · s skip · q quit > ");
      if (answer === null) rating = "quit";
      else {
        const key = answer.toLowerCase().charAt(0);
        rating = key in RATINGS ? RATINGS[key as keyof typeof RATINGS] : key === "s" ? "skip" : key === "q" ? "quit" : null;
      }
    }
    if (rating === "quit") break;
    if (rating === "skip") continue;
    const note = rating === "good" ? null : await next("What was missing? (Enter to skip) > ");
    prepared(candidate.source.db, "INSERT INTO call_reviews (call_id, rating, note, rated_at) VALUES (?, ?, ?, ?) ON CONFLICT (call_id) DO NOTHING").run(
      candidate.id,
      rating,
      note === null || note === "" ? null : note.slice(0, NOTE_CHARS),
      new Date().toISOString(),
    );
    stored++;
  }
  return stored;
}

/** What the search returned, resolved now: a record forgotten since shows as [forgotten]. */
function describeReturned(candidate: Candidate): string {
  if (candidate.returned.length === 0) return "    (nothing came back)\n";
  const rows = prepared(candidate.source.db, "SELECT id, kind, title, body, lifecycle FROM records WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(candidate.returned.map((r) => r.id))) as {
    id: string;
    kind: string;
    title: string | null;
    body: string;
    lifecycle: string;
  }[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return candidate.returned
    .map((item, i) => {
      const record = byId.get(item.id);
      const shown = record === undefined || record.lifecycle === "forgotten" ? "[forgotten]" : `${record.kind}  ${item.freshness ?? "-"}  ${oneLine(record.title ?? record.body)}${record.lifecycle === "active" ? "" : `  (${record.lifecycle} since)`}`;
      return `    ${String(i + 1).padStart(2)}. ${item.id}  ${shown}\n`;
    })
    .join("");
}

function sample<T>(items: readonly T[], count: number): T[] {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j] as T, pool[i] as T];
  }
  return pool.slice(0, count);
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
}
