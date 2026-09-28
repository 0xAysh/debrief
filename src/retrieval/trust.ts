import type { Attribution, Freshness } from "../schemas.js";

/**
 * How far a recalled record can be trusted, for ordering records that answer a query about
 * equally well (the bands of `rankSequence`). Fixed rules, no model; relevance always leads, so a
 * stale record that answers the question still comes back, below equally relevant current ones.
 *
 * Compared in this order, the first difference deciding:
 * 1. **Freshness now:** current, then unknown, then stale (`RecordFreshness.freshness`, the worst
 *    of its references and its test run, which already counts an asserted run as unknown at best).
 *    A reference the check's budget could not reach is unknown, so an unchecked record sits between
 *    current and stale, never with the stale ones.
 * 2. **Test-run evidence:** a run Debrief captured, then no run, then a run the agent only
 *    asserted. A record without a run is neutral: it claims nothing to verify, while an asserted
 *    run claims a result nobody saw.
 * 3. **Attribution:** what was observed and what the user said, then the agent's inference.
 * 4. **Corroboration:** more independent roots stating the same claim first. Copies (records
 *    `derived_from` or `supported_by` a record with the same claim) share its root and never count.
 *
 * Freshness comes first, so an asserted run at the current state (unknown) outranks a captured
 * run against an older commit (stale): a result about other code says less about this code.
 */
export interface TrustFacts {
  freshness: Freshness;
  /** The evidence for the record's test run; null when it reports none. */
  evidence: "captured" | "asserted" | null;
  attribution: Attribution;
  /** Distinct independent roots among the ranked records stating the same claim (at least 1). */
  roots: number;
}

const FRESHNESS: readonly Freshness[] = ["current", "unknown", "stale"];
const EVIDENCE: readonly TrustFacts["evidence"][] = ["captured", null, "asserted"];
const ATTRIBUTION: readonly Attribution[] = ["direct_observation", "user_direction", "agent_inference"];
/** Observed and user-given rank alike; only an inference ranks below them. */
const ATTRIBUTION_RANK: Readonly<Record<Attribution, number>> = { direct_observation: 0, user_direction: 0, agent_inference: 1 };

/** Negative when `a` is more trusted than `b`, 0 when trust cannot tell them apart. */
function compareTrust(a: TrustFacts, b: TrustFacts): number {
  return (
    FRESHNESS.indexOf(a.freshness) - FRESHNESS.indexOf(b.freshness) ||
    EVIDENCE.indexOf(a.evidence) - EVIDENCE.indexOf(b.evidence) ||
    ATTRIBUTION_RANK[a.attribution] - ATTRIBUTION_RANK[b.attribution] ||
    b.roots - a.roots
  );
}

/**
 * Reorders each band of `seqs` (`bands[i]` is the band of `seqs[i]`, contiguous) by trust; records
 * trust cannot tell apart keep their order, so a sequence without trust differences is unchanged.
 * `lifted` holds the facts of each record trust placed above a record that ranked before it.
 * `factsOf` must answer for every record in a band of two or more.
 */
export function orderByTrust(
  seqs: readonly number[],
  bands: readonly number[],
  factsOf: (seq: number) => TrustFacts | undefined,
): { seqs: number[]; lifted: Map<number, TrustFacts> } {
  const ordered: number[] = [];
  const lifted = new Map<number, TrustFacts>();
  for (let start = 0; start < seqs.length; ) {
    let end = start + 1;
    while (end < seqs.length && bands[end] === bands[start]) end++;
    const band = seqs.slice(start, end).map((seq, position) => {
      if (end - start === 1) return { seq, position, facts: null };
      const facts = factsOf(seq);
      if (facts === undefined) throw new Error(`no trust facts for seq ${seq}`);
      return { seq, position, facts };
    });
    // Array.prototype.sort is stable: equal trust keeps bm25 order.
    band.sort((a, b) => (a.facts === null || b.facts === null ? 0 : compareTrust(a.facts, b.facts)));
    // A record is lifted when a record ranked before it now follows it.
    let earliestAfter = Infinity;
    for (let i = band.length - 1; i >= 0; i--) {
      const entry = band[i];
      if (entry === undefined) continue;
      if (entry.facts !== null && earliestAfter < entry.position) lifted.set(entry.seq, entry.facts);
      earliestAfter = Math.min(earliestAfter, entry.position);
    }
    ordered.push(...band.map((entry) => entry.seq));
    start = end;
  }
  return { seqs: ordered, lifted };
}

/** The pack's short reason for a record trust lifted: `trusted: current, captured`. */
export function describeTrust(facts: TrustFacts): string {
  const reasons: string[] = [facts.freshness];
  if (facts.evidence === "captured") reasons.push("captured");
  if (facts.attribution === "direct_observation") reasons.push("observed");
  if (facts.attribution === "user_direction") reasons.push("user-given");
  if (facts.roots > 1) reasons.push(`${facts.roots === MAX_ROOTS ? `${MAX_ROOTS}+` : facts.roots} roots`);
  return `trusted: ${reasons.join(", ")}`;
}

/** Roots are carried up to this many (two base-36 digits hold 3 × 3 × 3 × 48 codes). */
const MAX_ROOTS = 48;

/** Two base-36 digits: a continuation carries page 1's facts, so a later page explains its order as page 1 saw it. */
export function encodeTrust(facts: TrustFacts): string {
  const roots = Math.min(Math.max(facts.roots, 1), MAX_ROOTS) - 1;
  const code = FRESHNESS.indexOf(facts.freshness) + 3 * (EVIDENCE.indexOf(facts.evidence) + 3 * (ATTRIBUTION.indexOf(facts.attribution) + 3 * roots));
  return code.toString(36).padStart(2, "0");
}

/** Inverse of {@link encodeTrust}; null for anything it could not have produced. */
export function decodeTrust(digits: string): TrustFacts | null {
  const code = /^[0-9a-z]{2}$/.test(digits) ? parseInt(digits, 36) : NaN;
  const freshness = FRESHNESS[code % 3];
  const evidence = EVIDENCE[Math.floor(code / 3) % 3];
  const attribution = ATTRIBUTION[Math.floor(code / 9) % 3];
  const roots = Math.floor(code / 27) + 1;
  if (Number.isNaN(code) || freshness === undefined || evidence === undefined || attribution === undefined || roots > MAX_ROOTS) return null;
  return { freshness, evidence, attribution, roots };
}
