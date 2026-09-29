import type { Freshness } from "../schemas.js";
import type { Packable } from "./context-pack.js";

/**
 * One line per pack entry: what it is, how old, which host wrote it (and which of its
 * sub-agents, if one did), and whether its code references still hold, e.g.
 * `checkpoint r7 · 2d · codex · current` or `evidence · 5m · claude-code/general-purpose · unknown`.
 * Built from fields every pack entry already carries (the JSON pack keeps them structured, without this duplicate), for
 * text context such as session start. A compact recall's index lines ({@link asIndexLine}) use the same fields.
 */

const UNITS: [suffix: string, ms: number][] = [
  ["y", 365 * 86_400_000],
  ["mo", 30 * 86_400_000],
  ["w", 7 * 86_400_000],
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
];

/** How long ago, in the largest whole unit; "now" under a minute (and for clock skew). */
export function age(iso: string, now: Date): string {
  const elapsed = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(elapsed)) return "?";
  for (const [suffix, ms] of UNITS) if (elapsed >= ms) return `${Math.floor(elapsed / ms)}${suffix}`;
  return "now";
}

/** The host that wrote an entry, with the sub-agent if one did: `claude-code/general-purpose`. */
function writer(entry: { host: string; source?: { agentType: string | null } | null }): string {
  const agent = entry.source?.agentType ?? null;
  return agent === null ? entry.host : `${entry.host}/${agent}`;
}

const checkpointKind = (revision: number): string => `checkpoint r${revision}`;

/** Jev's verdict on a stale entry, when it has one (see `judge/still-true.ts`). */
interface Verdict {
  verdict: "still_holds" | "invalidated";
  probability: number;
}

/** `stale`, or with Jev's verdict `stale · still holds (0.91)` / `stale · invalidated (0.88)`. */
function freshnessLabel(entry: { freshness: Freshness; judgment?: Verdict }): string {
  const judgment = entry.judgment;
  if (judgment === undefined) return entry.freshness;
  return `${entry.freshness} · ${judgment.verdict === "still_holds" ? "still holds" : "invalidated"} (${judgment.probability.toFixed(2)})`;
}

export function itemLabel(item: { kind: string; createdAt: string; host: string; freshness: Freshness; judgment?: Verdict; source?: { agentType: string | null } | null }, now: Date): string {
  return `${item.kind} · ${age(item.createdAt, now)} · ${writer(item)} · ${freshnessLabel(item)}`;
}

export function checkpointLabel(checkpoint: { revision: number; createdAt: string; host: string; freshness: Freshness; judgment?: Verdict }, now: Date): string {
  return itemLabel({ ...checkpoint, kind: checkpointKind(checkpoint.revision) }, now);
}

/** An index line's excerpt, in bytes: with its ~120 bytes of fields a line stays near 70 tokens. */
export const INDEX_EXCERPT_BYTES = 160;

type IndexedEntry = { recordId: string; createdAt: string; host: string; freshness: Freshness; judgment?: Verdict } & (
  | { kind: string; attribution: string; title: string | null; source: { agentType: string | null } | null }
  | { revision: number }
);

/**
 * A compact recall's entry: the full entry's record as one line,
 * `rec_… [2026-09-27 · decision · user_direction · claude-code · stale] Retry failed jobs…`
 * (the checkpoint `rec_… [2026-09-27 · checkpoint r3 · codex · current] …`). Its fields come from
 * the full entry, so freshness and attribution are exactly what the full pack shows; the excerpt
 * is the title, else the best-matching passage, flattened to one line and cut with "…".
 * `memory_read` has the body, citations and warnings.
 */
export function asIndexLine(entry: Packable<IndexedEntry>): Packable<string> {
  const fields = entry.build("", false);
  const what = "revision" in fields ? [checkpointKind(fields.revision)] : [fields.kind, fields.attribution];
  const head = `${fields.recordId} [${[fields.createdAt.slice(0, 10), ...what, writer(fields), freshnessLabel(fields)].join(" · ")}]`;
  const text = ("title" in fields ? (fields.title ?? entry.source) : entry.source).replace(/\s+/gu, " ").trim();
  return { recordId: entry.recordId, source: text, maxExcerptBytes: INDEX_EXCERPT_BYTES, build: (excerpt, cut) => `${head} ${excerpt}${cut ? "…" : ""}` };
}
