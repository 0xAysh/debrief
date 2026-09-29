import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { boundPassage, redactSecrets, touchesSensitivePath } from "../import/privacy.js";
import { FRESHNESS_LIMITS, FRESHNESS_WARNINGS, hashFile, type RecordFreshness, type StoredRef, worktreePath } from "../retrieval/freshness.js";
import type { ChoiceQuestion, JevClient, JevFailure } from "./jev.js";
import type { JevLedger, VerdictKey } from "./ledger.js";

/**
 * "Changed, but still true" (#55 PR 2): when code a memory cites changed after Debrief observed
 * it, Jev reads the memory and the bounded diff between the observed version and now, and answers
 * whether the change invalidates the claim. Recall shows `stale · still holds (0.91)` or
 * `stale · invalidated (0.88)`. The label is advisory: freshness is computed exactly as without
 * Jev (still `stale`), and ranking never sees the verdict.
 *
 * Which references can be judged, and why only these:
 * - **Observed clean at a known commit** (`dirty: false`, `commit`, `observedHash`, all captured by
 *   Debrief at write time): then the commit holds exactly what the memory saw, and
 *   `git diff <commit> -- <file>` is the change since, bounded and exact. Debrief never stores
 *   content, so a reference observed dirty has no old text to diff against, and an imported
 *   reference was never fingerprinted at all: both get no verdict and cost no call. So does a
 *   caller-pinned reference (Debrief does not know it was clean).
 * - **Stale because its bytes changed** (`changed`, `lines_changed`), not because it is gone.
 *
 * Never sent (the memory is skipped, not redacted and sent): text holding Debrief's markers
 * (`[private]`, `[redacted:…]`, withheld output), a memory or diff in which the credential patterns
 * find anything, a sensitive path, and anything while this session is private. Records of private
 * sessions are forgotten, so they are never recalled or queued.
 *
 * How it stays out of the way: {@link StillTrue.annotate} runs inside recall and read and only
 * reads the ledger. A pair of versions with no verdict yet is queued; the MCP server drains the
 * queue between requests ({@link StillTrue.step}), a few calls at a time, and the next recall shows
 * the verdict. A failure (timeout, 429, error) pauses judging and puts a notice on recalls; it is
 * never retried in a loop. Hooks never step the queue.
 *
 * The re-read warning goes only for a verdict of "still holds" at {@link STILL_TRUE.holdsThreshold}
 * or above, on every stale reference of the record. Below it, and for "invalidated", the warning
 * stays exactly as freshness wrote it. 0.9: Jev's probabilities are calibrated (docs.typesafe.ai
 * /confidence), so at 0.9 one "still holds" in ten is wrong; a wrong one costs an agent acting on
 * outdated memory, and a missed one only a file read, so the bar is set high.
 */

export const STILL_TRUE = {
  /** A "still holds" at or above this lifts the re-read warning. */
  holdsThreshold: 0.9,
  /** Larger diffs are not sent: a cut diff could hide the change that matters, and Jev loses accuracy on long, irrelevant state. */
  diffBytes: 12_000,
  /** The memory's title and text, head and tail kept (as imported passages are bounded). */
  memoryBytes: 4_000,
  /** Pairs waiting for a verdict, per process. */
  queue: 64,
  /** Pauses after a failure, in ms. A 429's `retry-after` is honoured up to `rateLimitedMax`. */
  pause: { timeout: 30_000, unavailable: 30_000, malformed: 60_000, rateLimited: 60_000, rateLimitedMax: 300_000 },
} as const;

export interface Judgment {
  verdict: "still_holds" | "invalidated";
  /** Jev's probability for that verdict, to two decimals. */
  probability: number;
  model: string;
}

/** What `annotate` needs of a record: its stored references (as Debrief observed them). */
export interface JudgeSubject {
  recordId: string;
  refs: readonly StoredRef[];
  imported: boolean;
}

/** What a step needs from the memory module, read synchronously before each call. */
export interface JudgeSource {
  /** The record's title and text if it is still visible and current here; null otherwise. */
  memoryText(recordId: string): string | null;
  /** Whether this session is private: then nothing is sent. */
  sessionPrivate(): boolean;
}

export interface JudgeStep {
  calls: number;
  pending: number;
  /** A failure paused judging; stepping again before it ends does nothing. */
  paused: boolean;
}

interface Pending extends VerdictKey {
  path: string;
  commit: string;
  lines: [number, number] | undefined;
}

const QUESTION: Record<string, ChoiceQuestion> = {
  verdict: {
    type: "choice",
    instructions:
      "`memory` is a note an engineer wrote about the code in `file` (`cited_lines`, when present, are the lines it cites, numbered as the file was then). `diff` shows every change made to `file` since the note was written. After these changes, is everything `memory` says about this file still true?",
    criteria: {
      still_holds:
        "Still true: after the changes, everything the note says about this file is accurate. For example the change is a refactor that keeps the behaviour the note describes, or it edits code the note does not talk about.",
      invalidated:
        "No longer true: the changes alter, remove or rename something the note states or relies on, so an engineer following the note now would be misled.",
    },
  },
};

/** Debrief's own markers for text it hid: a memory holding one is never sent. */
const HIDDEN = /\[private\]|\[redacted:|\[output withheld by Debrief|\[sensitive arguments withheld\]/;
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

export class StillTrue {
  private readonly worktree: string;
  private readonly workspaceId: string;
  private readonly ledger: JevLedger;
  /** Null when there is no key: cached verdicts show, nothing is queued or sent. */
  private readonly client: JevClient | null;
  private readonly now: () => Date;
  private readonly queue = new Map<string, Pending>();
  private pausedUntil = 0;
  private failure: { kind: JevFailure; status: number | null } | null = null;
  private closed = false;

  constructor(options: { worktree: string; workspaceId: string; ledger: JevLedger; client: JevClient | null; now: () => Date }) {
    this.worktree = options.worktree;
    this.workspaceId = options.workspaceId;
    this.ledger = options.ledger;
    this.client = options.client;
    this.now = options.now;
  }

  /**
   * A checked record with its verdict, when every stale reference has one for the versions on
   * disk now; otherwise as checked, and the missing pairs are queued. Never calls out.
   */
  annotate(subject: JudgeSubject, checked: RecordFreshness): RecordFreshness & { judgment: Judgment | null } {
    if (checked.freshness !== "stale" || this.closed) return { ...checked, judgment: null };
    try {
      return this.judged(subject, checked);
    } catch {
      // A ledger that cannot be read (busy, damaged) costs the label, never the recall.
      return { ...checked, judgment: null };
    }
  }

  private judged(subject: JudgeSubject, checked: RecordFreshness): RecordFreshness & { judgment: Judgment | null } {
    const verdicts: Judgment[] = [];
    // A stale test run has no text to judge; a record resting on one gets no verdict.
    let complete = checked.testRun?.applies !== "stale";
    checked.externalRefs.forEach((ref, index) => {
      if (ref.freshness !== "stale") return;
      const stored = subject.refs[index];
      const key = stored === undefined || subject.imported || (ref.reason !== "changed" && ref.reason !== "lines_changed") ? null : this.judgeable(subject.recordId, index, stored);
      const cached = key === null ? undefined : this.ledger.verdict(key);
      if (key !== null && cached === undefined) this.enqueue(key);
      if (cached?.verdict === undefined || cached.verdict === null || cached.probability === null) {
        complete = false;
        return;
      }
      verdicts.push({ verdict: cached.verdict, probability: round(cached.probability), model: cached.model ?? "" });
    });
    if (!complete || verdicts.length === 0) return { ...checked, judgment: null };
    // The record's verdict is its weakest reference's: any "invalidated" (the surest), else the least sure "still holds".
    const invalidated = verdicts.filter((v) => v.verdict === "invalidated").sort((a, b) => b.probability - a.probability);
    const judgment = invalidated[0] ?? [...verdicts].sort((a, b) => a.probability - b.probability)[0] ?? null;
    if (judgment === null) return { ...checked, judgment: null };
    const lifted = judgment.verdict === "still_holds" && judgment.probability >= STILL_TRUE.holdsThreshold && checked.warning !== null;
    const warning = lifted ? (checked.warning?.replace(FRESHNESS_WARNINGS.stale, `Changed since observed; Jev judged the change leaves this claim true (${judgment.probability.toFixed(2)}).`) ?? null) : checked.warning;
    return { ...checked, warning, judgment };
  }

  pending(): number {
    return this.client === null ? 0 : this.queue.size;
  }

  /** Set after a failed call until one succeeds: recalls say why stale items may lack a verdict. */
  notice(): string | null {
    if (this.failure === null) return null;
    const status = this.failure.status === null ? "" : ` (HTTP ${this.failure.status})`;
    const why: Record<JevFailure, string> = {
      rate_limited: "TypeSafe is rate limiting this key",
      timeout: "TypeSafe did not answer in time",
      unavailable: `TypeSafe could not be reached${status}`,
      rejected: `TypeSafe refused the key${status}; judging is off until Debrief restarts`,
      malformed: "TypeSafe's answer was not what Debrief expects",
    };
    return `Jev's last judgment failed (${why[this.failure.kind]}), so stale items may show no verdict: read the current files before relying on them.`;
  }

  /** Sends up to `maxCalls` queued pairs, one at a time; stops at the first failure and pauses. Never throws for the service. */
  async step(maxCalls: number, source: JudgeSource): Promise<JudgeStep> {
    const done = (calls: number): JudgeStep => ({ calls, pending: this.pending(), paused: this.now().getTime() < this.pausedUntil });
    if (this.client === null || this.closed) return done(0);
    if (this.now().getTime() < this.pausedUntil) return done(0);
    if (source.sessionPrivate()) {
      this.queue.clear();
      return done(0);
    }
    let calls = 0;
    for (const [id, item] of [...this.queue]) {
      if (calls >= maxCalls || this.isClosed()) break;
      this.queue.delete(id);
      if (this.cached(item)) continue;
      // Edited again since it was queued: the next recall queues the new pair.
      if (currentHash(this.worktree, item.path) !== item.current) continue;
      const text = source.memoryText(item.recordId);
      if (text === null) continue;
      const request = this.request(item, text);
      if ("skipped" in request) {
        try {
          this.ledger.save(item, { verdict: null, probability: null, model: null, skipped: request.skipped }, this.now());
        } catch {
          break;
        }
        continue;
      }
      calls++;
      const result = await this.client.choose(request.state, QUESTION, this.now());
      // Closed while the call was out: the ledger is gone, and the answer is dropped.
      if (this.isClosed()) break;
      if (!result.ok) {
        this.failure = { kind: result.failure, status: result.status };
        this.pausedUntil = this.now().getTime() + pauseFor(result.failure, result.retryAfterMs);
        this.enqueue(item);
        break;
      }
      const answer = result.value["verdict"];
      if (answer?.choice !== "still_holds" && answer?.choice !== "invalidated") {
        this.failure = { kind: "malformed", status: null };
        this.pausedUntil = this.now().getTime() + STILL_TRUE.pause.malformed;
        break;
      }
      this.failure = null;
      try {
        this.ledger.save(item, { verdict: answer.choice, probability: answer.probabilities[answer.choice] ?? null, model: result.model, skipped: null }, this.now());
      } catch {
        // Not cached: a later recall queues the pair again.
        break;
      }
    }
    return done(calls);
  }

  /** The ledger belongs to the memory module, which closes it; a step in flight then stops. */
  close(): void {
    this.closed = true;
    this.queue.clear();
  }

  /** Whether the pair already has a verdict or a skip; a ledger that cannot be read counts as cached, so nothing is sent twice. */
  private cached(key: VerdictKey): boolean {
    try {
      return this.ledger.verdict(key) !== undefined;
    } catch {
      return true;
    }
  }

  /** Read through a call, so a close during an awaited request is seen. */
  private isClosed(): boolean {
    return this.closed;
  }

  /** The verdict key of a reference Debrief observed clean at a commit, as it is on disk now; null when it cannot be judged. */
  private judgeable(recordId: string, index: number, stored: StoredRef): Pending | null {
    if (stored.dirty !== false || stored.commit === undefined || stored.observedHash === undefined) return null;
    const path = worktreePath(this.worktree, stored.path ?? stored.locator);
    if (path === null || touchesSensitivePath([path])) return null;
    const current = currentHash(this.worktree, path);
    if (current === null) return null;
    return {
      workspaceId: this.workspaceId,
      recordId,
      ref: `${index}:${path}`,
      observed: `${stored.commit}:${stored.observedHash}`,
      current,
      path,
      commit: stored.commit,
      lines: stored.lines,
    };
  }

  private enqueue(item: Pending): void {
    if (this.client === null || this.closed) return;
    const id = `${item.recordId}\0${item.ref}\0${item.observed}\0${item.current}`;
    if (this.queue.has(id) || this.queue.size >= STILL_TRUE.queue) return;
    this.queue.set(id, item);
  }

  /** The request for one pair, or why it is not sent. */
  private request(item: Pending, text: string): { state: Record<string, unknown> } | { skipped: string } {
    if (HIDDEN.test(text) || redactSecrets(text).redactions > 0) return { skipped: "hidden_text" };
    const change = diffSince(this.worktree, item.commit, item.path);
    if (change === null) return { skipped: "no_diff" };
    if (change.tooLarge) return { skipped: "diff_too_large" };
    const diff = change.text;
    if (HIDDEN.test(diff) || redactSecrets(diff).redactions > 0) return { skipped: "hidden_text" };
    return {
      state: {
        memory: boundPassage(text, STILL_TRUE.memoryBytes).text,
        file: item.path,
        ...(item.lines === undefined ? {} : { cited_lines: `${item.lines[0]}-${item.lines[1]}` }),
        diff,
      },
    };
  }
}

function round(probability: number): number {
  return Math.round(probability * 100) / 100;
}

function pauseFor(failure: JevFailure, retryAfterMs: number | null): number {
  switch (failure) {
    case "rate_limited":
      return Math.min(Math.max(retryAfterMs ?? STILL_TRUE.pause.rateLimited, 1_000), STILL_TRUE.pause.rateLimitedMax);
    case "timeout":
      return STILL_TRUE.pause.timeout;
    case "unavailable":
      return Math.min(Math.max(retryAfterMs ?? STILL_TRUE.pause.unavailable, 1_000), STILL_TRUE.pause.rateLimitedMax);
    case "malformed":
      return STILL_TRUE.pause.malformed;
    case "rejected":
      return Number.POSITIVE_INFINITY;
  }
}

/** `sha256:` of the file now (bounded like freshness checks); null when it cannot be hashed. */
function currentHash(worktree: string, path: string): string | null {
  const file = hashFile(join(worktree, path), FRESHNESS_LIMITS.fileBytes);
  return file.kind === "hashed" ? file.hash : null;
}

/**
 * `git diff <commit> -- <path>`: the change from the observed version to the file on disk now.
 * Plain text only (no external diff drivers or textconv from the user's config), with the
 * pathspec taken literally. Null when Git fails or there is no textual change; `tooLarge` past
 * {@link STILL_TRUE.diffBytes}.
 */
function diffSince(worktree: string, commit: string, path: string): { tooLarge: false; text: string } | { tooLarge: true } | null {
  let out: string;
  try {
    out = execFileSync(
      "git",
      ["--literal-pathspecs", "-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=3", commit, "--", path],
      { cwd: worktree, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: STILL_TRUE.diffBytes * 4, timeout: 5_000 },
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOBUFS" ? { tooLarge: true } : null;
  }
  if (out.trim() === "" || /^Binary files /m.test(out)) return null;
  return Buffer.byteLength(out, "utf8") > STILL_TRUE.diffBytes ? { tooLarge: true } : { tooLarge: false, text: out };
}
