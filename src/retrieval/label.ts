import type { Freshness } from "../schemas.js";

/**
 * One line per pack entry: what it is, how old, which host wrote it, and whether its code
 * references still hold, e.g. `checkpoint r7 · 2d · codex · current`. Built from fields every
 * pack entry already carries (the JSON pack keeps them structured, without this duplicate), for
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

export function itemLabel(item: { kind: string; createdAt: string; host: string; freshness: Freshness }, now: Date): string {
  return `${item.kind} · ${age(item.createdAt, now)} · ${item.host} · ${item.freshness}`;
}

export function checkpointLabel(checkpoint: { revision: number; createdAt: string; host: string; freshness: Freshness }, now: Date): string {
  return `checkpoint r${checkpoint.revision} · ${age(checkpoint.createdAt, now)} · ${checkpoint.host} · ${checkpoint.freshness}`;
}
