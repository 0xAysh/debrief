import type { Attribution, Freshness } from "../schemas.js";

/**
 * How far a recalled record can be trusted, for ordering records that answer a query about
 * equally well (the bands of `rankSequence`). Fixed rules, no model; relevance always leads, so a
 * stale record that answers the question still comes back, below equally relevant current ones.
 *
 * Compared level by level, the first difference deciding:
 * 1. **Freshness now:** current, then unknown, then stale (`RecordFreshness.freshness`, the worst
 *    of its references and its test run, which already counts an asserted run as unknown at best).
 *    A reference the check's budget could not reach is unknown, so an unchecked record sits between
 *    current and stale, never with the stale ones.
 * 2. **Test-run evidence:** a run Debrief captured, then no run, then a run the agent only
 *    asserted. A record without a run is neutral: it claims nothing to verify, while an asserted
 *    run claims a result nobody saw.
 * 3. **Attribution:** what was observed and what the user said alike, then the agent's inference.
 * 4. **Corroboration:** more independent roots stating the same claim first. Copies (records
 *    `derived_from` or `supported_by` a record with the same claim) share its root and never count.
 *
 * Freshness comes first, so an asserted run at the current state (unknown) outranks a captured
 * run against an older commit (stale): a result about other code says less about this code.
 */
export interface TrustFacts {
  freshness: Freshness;
  /** The evidence for the record's test run; "none" when it reports no run. */
  evidence: Evidence;
  attribution: Attribution;
  /** Distinct independent roots among the compared records stating the same claim (at least 1). */
  roots: number;
}

type Evidence = "captured" | "none" | "asserted";

/**
 * What decided a lifted record's place: its own value at each level where it beat a record that
 * ranked before it on relevance alone. Levels that decided nothing are absent.
 */
export interface TrustReason {
  freshness?: Freshness;
  evidence?: Evidence;
  attribution?: Attribution;
  /** At least 2: one root never beats another. */
  roots?: number;
}

const FRESHNESS: readonly Freshness[] = ["current", "unknown", "stale"];
const EVIDENCE: readonly Evidence[] = ["captured", "none", "asserted"];
/** Observed and user-given rank alike; only an inference ranks below them. */
const ATTRIBUTION: Readonly<Record<Attribution, number>> = { direct_observation: 0, user_direction: 0, agent_inference: 1 };

/** Each level's order: negative when `a` is more trusted than `b` there. */
const LEVELS = [
  (a: TrustFacts, b: TrustFacts): number => FRESHNESS.indexOf(a.freshness) - FRESHNESS.indexOf(b.freshness),
  (a: TrustFacts, b: TrustFacts): number => EVIDENCE.indexOf(a.evidence) - EVIDENCE.indexOf(b.evidence),
  (a: TrustFacts, b: TrustFacts): number => ATTRIBUTION[a.attribution] - ATTRIBUTION[b.attribution],
  (a: TrustFacts, b: TrustFacts): number => b.roots - a.roots,
] as const;

/** The first level where `a` and `b` differ, or -1. */
function decidingLevel(a: TrustFacts, b: TrustFacts): number {
  return LEVELS.findIndex((level) => level(a, b) !== 0);
}

function compareTrust(a: TrustFacts, b: TrustFacts): number {
  const level = decidingLevel(a, b);
  return level === -1 ? 0 : (LEVELS[level]?.(a, b) ?? 0);
}

/**
 * Reorders each band of `seqs` (`bands[i]` is the band of `seqs[i]`, contiguous) by trust; records
 * trust cannot tell apart keep their order, so a sequence without trust differences is unchanged.
 * `lifted` says, for each record trust placed above a record that ranked before it, what decided
 * that. `factsOf` must answer for every record in a band of two or more.
 */
export function orderByTrust(
  seqs: readonly number[],
  bands: readonly number[],
  factsOf: (seq: number) => TrustFacts | undefined,
): { seqs: number[]; lifted: Map<number, TrustReason> } {
  const ordered: number[] = [];
  const lifted = new Map<number, TrustReason>();
  for (let start = 0; start < seqs.length; ) {
    let end = start + 1;
    while (end < seqs.length && bands[end] === bands[start]) end++;
    if (end - start === 1) {
      ordered.push(...seqs.slice(start, end));
      start = end;
      continue;
    }
    const band = seqs.slice(start, end).map((seq, position) => {
      const facts = factsOf(seq);
      if (facts === undefined) throw new Error(`no trust facts for seq ${seq}`);
      return { seq, position, facts };
    });
    // Array.prototype.sort is stable: records trust cannot tell apart keep their bm25 order.
    band.sort((a, b) => compareTrust(a.facts, b.facts));
    band.forEach((entry, i) => {
      const reason: TrustReason = {};
      for (const passed of band.slice(i + 1)) {
        if (passed.position > entry.position) continue;
        const level = decidingLevel(entry.facts, passed.facts);
        if (level === 0) reason.freshness = entry.facts.freshness;
        else if (level === 1) reason.evidence = entry.facts.evidence;
        else if (level === 2) reason.attribution = entry.facts.attribution;
        else if (level === 3) reason.roots = entry.facts.roots;
      }
      if (Object.keys(reason).length > 0) lifted.set(entry.seq, reason);
    });
    ordered.push(...band.map((entry) => entry.seq));
    start = end;
  }
  return { seqs: ordered, lifted };
}

/** The pack's short reason for a record trust lifted, e.g. `trusted: current, captured`. */
export function describeTrust(reason: TrustReason): string {
  const words: string[] = [];
  // Unknown only ever beats stale, and no run only ever beats an asserted one.
  if (reason.freshness !== undefined) words.push(reason.freshness === "unknown" ? "not stale" : reason.freshness);
  if (reason.evidence !== undefined) words.push(reason.evidence === "none" ? "no asserted run" : reason.evidence);
  if (reason.attribution !== undefined) words.push(reason.attribution === "user_direction" ? "user-given" : reason.attribution === "direct_observation" ? "observed" : "inferred");
  if (reason.roots !== undefined) words.push(reason.roots >= MAX_ROOTS ? `${MAX_ROOTS}+ roots` : `${reason.roots} roots`);
  return `trusted: ${words.join(", ")}`;
}

/** A reason's roots are carried up to this many (see {@link encodeTrust}). */
const MAX_ROOTS = 20;

/**
 * Two base-36 digits (4 × 4 × 4 × 20 codes, each level 0 when absent): a continuation carries page
 * 1's reasons, so a later page explains its order as page 1 saw it.
 */
export function encodeTrust(reason: TrustReason): string {
  const at = <T>(values: readonly T[], value: T | undefined): number => (value === undefined ? 0 : values.indexOf(value) + 1);
  const roots = reason.roots === undefined ? 0 : Math.min(Math.max(reason.roots, 2), MAX_ROOTS) - 1;
  const code = at(FRESHNESS, reason.freshness) + 4 * (at(EVIDENCE, reason.evidence) + 4 * (at(ATTRIBUTION_VALUES, reason.attribution) + 4 * roots));
  return code.toString(36).padStart(2, "0");
}

const ATTRIBUTION_VALUES: readonly Attribution[] = ["direct_observation", "user_direction", "agent_inference"];

/** Inverse of {@link encodeTrust}; null for anything it could not have produced. */
export function decodeTrust(digits: string): TrustReason | null {
  if (!/^[0-9a-z]{2}$/.test(digits)) return null;
  const code = parseInt(digits, 36);
  const roots = Math.floor(code / 64);
  if (roots >= MAX_ROOTS) return null;
  const reason: TrustReason = {};
  const freshness = FRESHNESS[(code % 4) - 1];
  const evidence = EVIDENCE[(Math.floor(code / 4) % 4) - 1];
  const attribution = ATTRIBUTION_VALUES[(Math.floor(code / 16) % 4) - 1];
  if (freshness !== undefined) reason.freshness = freshness;
  if (evidence !== undefined) reason.evidence = evidence;
  if (attribution !== undefined) reason.attribution = attribution;
  if (roots > 0) reason.roots = roots + 1;
  return reason;
}
