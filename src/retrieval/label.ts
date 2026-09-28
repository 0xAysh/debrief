import type { Freshness } from "../schemas.js";
import type { Packable } from "./context-pack.js";

/**
 * One line per pack entry: what it is, how old, which host wrote it (and which of its
 * sub-agents, if one did), and whether its code references still hold, e.g.
 * `checkpoint r7 · 2d · codex · current` or `evidence · 5m · claude-code/general-purpose · unknown`.
 * Built from fields every pack entry already carries (the JSON pack keeps them structured, without this duplicate), for
 * text context such as session start.
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

export function itemLabel(item: { kind: string; createdAt: string; host: string; freshness: Freshness; source?: { agentType: string | null } | null }, now: Date): string {
  const agent = item.source?.agentType ?? null;
  return `${item.kind} · ${age(item.createdAt, now)} · ${item.host}${agent === null ? "" : `/${agent}`} · ${item.freshness}`;
}

export function checkpointLabel(checkpoint: { revision: number; createdAt: string; host: string; freshness: Freshness }, now: Date): string {
  return itemLabel({ ...checkpoint, kind: `checkpoint r${checkpoint.revision}` }, now);
}

/** An index line's excerpt, in bytes: with its ~120 bytes of fields a line stays near 70 tokens. */
export const INDEX_EXCERPT_BYTES = 160;

type IndexedEntry = { recordId: string; createdAt: string; host: string; freshness: Freshness } & (
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
  const what = "revision" in fields ? [`checkpoint r${fields.revision}`] : [fields.kind, fields.attribution];
  const agent = "source" in fields ? (fields.source?.agentType ?? null) : null;
  const head = `${fields.recordId} [${[fields.createdAt.slice(0, 10), ...what, agent === null ? fields.host : `${fields.host}/${agent}`, fields.freshness].join(" · ")}]`;
  const text = ("title" in fields ? (fields.title ?? entry.source) : entry.source).replace(/\s+/gu, " ").trim();
  return { recordId: entry.recordId, source: text, maxExcerptBytes: INDEX_EXCERPT_BYTES, build: (excerpt, cut) => `${head} ${excerpt}${cut ? "…" : ""}` };
}
