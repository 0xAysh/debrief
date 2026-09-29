import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../bootstrap/workspace-resolution.js";
import { JevLedger, type Usage, usageSummary } from "./ledger.js";

/**
 * Jev, TypeSafe AI's judgment model: the one seam through which Debrief asks a model anything
 * (issue #55). Jev returns typed answers (a Choice, a Score or a yes/no "Noul") with calibrated
 * probabilities; it cannot write text, so Debrief uses it only to judge. Everything about the
 * service lives here: who it is (endpoint, pinned model, price), whether the user turned it on
 * (`$DEBRIEF_HOME/jev.json`), and one request with a short timeout that never throws.
 *
 * The rules, and why:
 * - **Off by default, on only with the user's consent and key.** `debrief jev enable` shows what
 *   is sent, to whom and TypeSafe's retention terms, checks the key once, and records the consent
 *   *for that endpoint*: a different `DEBRIEF_JEV_ENDPOINT` (the tests' localhost stub) is off
 *   until enabled for itself, so an environment variable can never redirect consented data. The
 *   key comes only from `TYPESAFE_API_KEY`; it is never stored, logged or echoed. A repository
 *   can opt out (`debrief jev disable --here`).
 * - **A pinned model, never the moving alias.** `jev-latest` moves when TypeSafe ships a release,
 *   and the confidence thresholds Debrief acts on were chosen against one version. The response
 *   names the model that answered; an answer from any other is discarded.
 * - **Never in the way.** One attempt, a {@link JEV.timeoutMs} timeout, no retries: a timeout,
 *   a 429 or any error comes back as a failure the caller turns into "no verdict, and a notice".
 * - **Plain `fetch`, no SDK.** TypeSafe's JS SDK (`@typesafe-ai/sdk` 0.6.0, MIT, no deps) wraps
 *   the same two HTTP calls with retries and backoff, which Debrief turns off anyway; the wire
 *   format is two small JSON shapes (docs.typesafe.ai/api).
 * - **Visible cost.** Every request is counted in the ledger (calls, tokens, failures, per UTC
 *   day), which `debrief status` shows with the estimated dollars.
 */

export const JEV = {
  /** Jev 1.13, pinned: `jev-latest` points here today (docs.typesafe.ai/models, 2026-09-29). */
  model: "jev-1.13.0",
  endpoint: "https://api.typesafe.ai",
  /** US dollars per million input tokens; output tokens are free. */
  dollarsPerMillionInputTokens: 0.042,
  /** Per judgment: Jev answers in 70–500 ms, so this only cuts off a service in trouble. */
  timeoutMs: 3_000,
  /** The enable step's key check. */
  verifyTimeoutMs: 10_000,
} as const;

/** What `debrief jev enable` recorded. The key is not part of it. */
export interface JevConsent {
  version: 1;
  enabled: boolean;
  /** The endpoint the user consented to send to; judgments go nowhere else. */
  endpoint: string;
  model: string;
  consentedAt: string | null;
  /** Repository keys (the Git common directory) that opted out. */
  excluded: string[];
}

export type JevState =
  /** Not consented (or consented for another endpoint, or disabled). Nothing is read or sent. */
  | "off"
  /** Consented, but this repository opted out. Nothing is read or sent here. */
  | "excluded"
  /** Consented, but `TYPESAFE_API_KEY` is not set: cached verdicts show, nothing is sent. */
  | "no_key"
  | "on";

/** Where Debrief would send, and with which key: `DEBRIEF_JEV_ENDPOINT` (tests) or TypeSafe, `TYPESAFE_API_KEY`. */
export interface JevAccess {
  endpoint: string;
  apiKey: string | null;
}

export function jevAccessFromEnv(env: NodeJS.ProcessEnv): JevAccess {
  const key = env["TYPESAFE_API_KEY"]?.trim();
  return { endpoint: normalizeEndpoint(env["DEBRIEF_JEV_ENDPOINT"]?.trim() || JEV.endpoint), apiKey: key === undefined || key === "" ? null : key };
}

const consentPath = (home: string): string => join(home, "jev.json");

/** The recorded consent; null when never given. An unreadable file counts as none: nothing is sent. */
export function readJevConsent(home: string): JevConsent | null {
  const path = consentPath(home);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<JevConsent>;
    if (parsed.version !== 1 || typeof parsed.enabled !== "boolean" || typeof parsed.endpoint !== "string") return null;
    return {
      version: 1,
      enabled: parsed.enabled,
      endpoint: parsed.endpoint,
      model: typeof parsed.model === "string" ? parsed.model : JEV.model,
      consentedAt: typeof parsed.consentedAt === "string" ? parsed.consentedAt : null,
      excluded: Array.isArray(parsed.excluded) ? parsed.excluded.filter((key): key is string => typeof key === "string") : [],
    };
  } catch {
    return null;
  }
}

export function writeJevConsent(home: string, consent: JevConsent): void {
  writeFileAtomic(consentPath(home), JSON.stringify(consent, null, 2) + "\n");
}

/** Whether Jev may be used in this repository, and whether it may be called now. */
export function jevState(consent: JevConsent | null, access: JevAccess, repositoryKey: string | null): JevState {
  if (consent === null || !consent.enabled || normalizeEndpoint(consent.endpoint) !== access.endpoint) return "off";
  if (repositoryKey !== null && consent.excluded.includes(repositoryKey)) return "excluded";
  return access.apiKey === null ? "no_key" : "on";
}

/**
 * An endpoint as compared and requested: no trailing slash. Only https, except on the loopback
 * interface (the tests' stub), so a key and redacted text never cross a network in the clear.
 */
export function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return trimmed;
  } catch {
    // Not a URL: never an endpoint.
  }
  return "invalid:" + trimmed;
}

/** A question as TypeSafe's API takes it (docs.typesafe.ai/api). Only Choice is used so far. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string | Record<string, unknown>;
  criteria: Record<string, string | null>;
}

export interface ChoiceAnswer {
  choice: string;
  /** Each option's probability (they sum to 1). */
  probabilities: Record<string, number>;
}

export type JevFailure =
  /** No full answer within the timeout. */
  | "timeout"
  /** 429: TypeSafe's rate limits "change without notice" in early access. */
  | "rate_limited"
  /** 401/403: the key was refused. */
  | "rejected"
  /** A connection failure, a 5xx or 529 (overloaded), or any other status. */
  | "unavailable"
  /** A 2xx whose body is not the documented shape, or answered by another model. */
  | "malformed";

export type JevResult<T> =
  | { ok: true; value: T; model: string; usage: { inputTokens: number; outputTokens: number } }
  | { ok: false; failure: JevFailure; status: number | null; retryAfterMs: number | null };

/**
 * One client per process. Every request is counted in `ledger` when there is one (the enable
 * step's key check costs nothing and is not counted).
 */
export class JevClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly ledger: JevLedger | null;

  constructor(options: { endpoint: string; apiKey: string; ledger: JevLedger | null }) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.apiKey = options.apiKey;
    this.ledger = options.ledger;
  }

  /** Asks named Choice questions about `state` with the pinned model; never throws. */
  async choose(state: Record<string, unknown>, questions: Record<string, ChoiceQuestion>, now: Date): Promise<JevResult<Record<string, ChoiceAnswer>>> {
    const result = await this.request("POST", "/v1/systemone", { state, model: JEV.model, questions }, JEV.timeoutMs);
    const parsed = result.ok ? parseSystemOne(result.body, Object.keys(questions)) : null;
    const outcome: JevResult<Record<string, ChoiceAnswer>> = !result.ok
      ? result
      : parsed === null
        ? { ok: false, failure: "malformed", status: result.status, retryAfterMs: null }
        : { ok: true, ...parsed };
    this.ledger?.count(now, outcome.ok ? outcome.usage : null);
    return outcome;
  }

  /** The enable step: does the key work? (`GET /v1/models`, which lists the models and costs nothing.) */
  async verify(): Promise<JevResult<null>> {
    const result = await this.request("GET", "/v1/models", undefined, JEV.verifyTimeoutMs);
    if (!result.ok) return result;
    const models = (result.body as { models?: unknown } | null)?.models;
    return Array.isArray(models) ? { ok: true, value: null, model: JEV.model, usage: { inputTokens: 0, outputTokens: 0 } } : { ok: false, failure: "malformed", status: result.status, retryAfterMs: null };
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ ok: true; status: number; body: unknown } | { ok: false; failure: JevFailure; status: number | null; retryAfterMs: number | null }> {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${this.endpoint}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
      // The whole body within the same timeout: a stalled stream is a timeout too.
      text = await response.text();
    } catch {
      return { ok: false, failure: signal.aborted ? "timeout" : "unavailable", status: null, retryAfterMs: null };
    }
    if (response.status === 429) return { ok: false, failure: "rate_limited", status: 429, retryAfterMs: retryAfter(response.headers) };
    if (response.status === 401 || response.status === 403) return { ok: false, failure: "rejected", status: response.status, retryAfterMs: null };
    if (!response.ok) return { ok: false, failure: "unavailable", status: response.status, retryAfterMs: retryAfter(response.headers) };
    try {
      return { ok: true, status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, failure: "malformed", status: response.status, retryAfterMs: null };
    }
  }
}

/** `retry-after-ms`, else `Retry-After` in seconds (TypeSafe's SDK reads both); null when absent. */
function retryAfter(headers: Headers): number | null {
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.has("retry-after-ms") && Number.isFinite(ms) && ms >= 0) return ms;
  const seconds = Number(headers.get("retry-after"));
  return headers.has("retry-after") && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/** `{ model, answers, usage }` with a Choice answer for every question asked, from the pinned model; else null. */
function parseSystemOne(body: unknown, names: readonly string[]): { value: Record<string, ChoiceAnswer>; model: string; usage: { inputTokens: number; outputTokens: number } } | null {
  if (body === null || typeof body !== "object") return null;
  const { model, answers, usage } = body as { model?: unknown; answers?: unknown; usage?: unknown };
  if (model !== JEV.model || answers === null || typeof answers !== "object") return null;
  const value: Record<string, ChoiceAnswer> = {};
  for (const name of names) {
    const answer = (answers as Record<string, unknown>)[name] as { type?: unknown; choice?: unknown; probabilities?: unknown } | undefined;
    if (answer?.type !== "choice" || typeof answer.choice !== "string" || answer.probabilities === null || typeof answer.probabilities !== "object") return null;
    const probabilities = Object.fromEntries(Object.entries(answer.probabilities as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
    const chosen = probabilities[answer.choice];
    if (chosen === undefined || chosen < 0 || chosen > 1) return null;
    value[name] = { choice: answer.choice, probabilities };
  }
  const tokens = (usage ?? {}) as { input_tokens?: unknown; output_tokens?: unknown };
  const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : 0);
  return { value, model, usage: { inputTokens: count(tokens.input_tokens), outputTokens: count(tokens.output_tokens) } };
}

/** Estimated US dollars for a number of input tokens (output is free). */
export function jevDollars(inputTokens: number): number {
  return (inputTokens * JEV.dollarsPerMillionInputTokens) / 1_000_000;
}

/**
 * What `debrief jev enable` shows before asking: what is sent, to whom, and TypeSafe's retention
 * terms as its legal pages state them (checked 2026-09-29: Privacy Policy updated 2025-11-19, Data
 * Processing Agreement updated 2026-04-24, docs.typesafe.ai/models). Update it when they change.
 */
export function consentScreen(endpoint: string): string {
  return [
    "debrief jev enable",
    "",
    "Jev, TypeSafe AI's judgment model, answers one question for Debrief: when code a memory cites has",
    "changed since the memory was written, does the change make the memory wrong? Recall then shows",
    "`stale · still holds (0.91)` or `stale · invalidated (0.88)`. It is off unless you turn it on here.",
    "",
    `  to            TypeSafe AI at ${endpoint}, model ${JEV.model}, with your TYPESAFE_API_KEY`,
    "  what is sent  for a recalled memory citing a file that changed since Debrief saw it clean at a",
    "                commit: the memory's title and text, the file's path and cited lines, and",
    "                `git diff <commit> -- <file>` (only when it is at most 12,000 bytes)",
    "  never sent    private sessions, sensitive paths (.env, keys, credential files), withheld tool",
    "                output, imported transcripts, and any text holding a credential or Debrief's",
    "                [redacted]/[private] markers: such a memory is skipped, not redacted and sent",
    "  when          in the background of Debrief's MCP server, between requests, only for memory an",
    "                agent recalled; never from hooks, and recall never waits for it",
    "  retention     TypeSafe says it does not train or fine-tune models on API input (Privacy Policy).",
    '                It keeps customer data "for as long as necessary" for the processing (Data',
    "                Processing Agreement): there is no fixed deletion period. Zero data retention is",
    "                offered only on enterprise plans.",
    `  cost          $${JEV.dollarsPerMillionInputTokens} per million input tokens (output is free), billed to your key;`,
    "                `debrief status` shows calls, tokens and estimated dollars",
    "",
    "Turn it off with `debrief jev disable`; keep one repository out with `debrief jev disable --here`.",
    "",
  ].join("\n");
}

/**
 * Records consent for `access.endpoint` once the key works there (one `GET /v1/models`), and
 * takes `repositoryKey` (where it was run) off the opt-out list. Nothing is recorded on failure.
 */
export async function enableJev(home: string, access: JevAccess, repositoryKey: string | null, now: Date): Promise<{ ok: true } | { ok: false; message: string }> {
  if (access.endpoint.startsWith("invalid:")) return { ok: false, message: `DEBRIEF_JEV_ENDPOINT must be an https URL (got ${access.endpoint.slice(8)}).` };
  if (access.apiKey === null) return { ok: false, message: "TYPESAFE_API_KEY is not set. Create a key at console.typesafe.ai, export it, and run debrief jev enable again." };
  const checked = await new JevClient({ endpoint: access.endpoint, apiKey: access.apiKey, ledger: null }).verify();
  if (!checked.ok) {
    const why: Record<JevFailure, string> = {
      rejected: "TypeSafe refused the key",
      rate_limited: "TypeSafe is rate limiting this key; try again shortly",
      timeout: `TypeSafe did not answer within ${JEV.verifyTimeoutMs / 1000} s`,
      unavailable: `TypeSafe could not be reached${checked.status === null ? "" : ` (HTTP ${checked.status})`}`,
      malformed: "TypeSafe's answer was not what Debrief expects",
    };
    return { ok: false, message: `${why[checked.failure]}. Nothing was recorded.` };
  }
  const previous = readJevConsent(home);
  writeJevConsent(home, {
    version: 1,
    enabled: true,
    endpoint: access.endpoint,
    model: JEV.model,
    consentedAt: now.toISOString(),
    excluded: (previous?.excluded ?? []).filter((key) => key !== repositoryKey),
  });
  return { ok: true };
}

/** Turns Jev off everywhere; the opt-out list stays for a later enable. */
export function disableJev(home: string): void {
  const previous = readJevConsent(home);
  if (previous === null) return;
  writeJevConsent(home, { ...previous, enabled: false });
}

/** Opts one repository out (`exclude`) or back in; back in needs consent already given. */
export function excludeRepository(home: string, repositoryKey: string, exclude: boolean): { ok: true } | { ok: false; message: string } {
  const previous = readJevConsent(home);
  if (previous === null || (!exclude && !previous.enabled)) return { ok: false, message: "Jev is not on: run debrief jev enable first." };
  const others = previous.excluded.filter((key) => key !== repositoryKey);
  writeJevConsent(home, { ...previous, excluded: exclude ? [...others, repositoryKey].sort() : others });
  return { ok: true };
}

export interface JevUsage extends Usage {
  /** Estimated from input tokens at {@link JEV.dollarsPerMillionInputTokens}. */
  dollars: number;
}

export interface JevStatus {
  state: JevState;
  endpoint: string;
  model: string;
  today: JevUsage;
  total: JevUsage;
  /** Per UTC day, newest first. */
  days: (JevUsage & { day: string })[];
}

/** Read-only: the consent file and, when it exists, the ledger. */
export function jevStatus(home: string, access: JevAccess, repositoryKey: string | null, now: Date): JevStatus {
  const ledger = JevLedger.openReadOnly(home);
  let days: (Usage & { day: string })[] = [];
  try {
    days = ledger?.days() ?? [];
  } catch {
    // An unreadable ledger reports no usage rather than failing status.
  } finally {
    ledger?.close();
  }
  const priced = <T extends Usage>(usage: T): T & { dollars: number } => ({ ...usage, dollars: jevDollars(usage.inputTokens) });
  const summary = usageSummary(days, now);
  return {
    state: jevState(readJevConsent(home), access, repositoryKey),
    endpoint: access.endpoint,
    model: JEV.model,
    today: priced(summary.today),
    total: priced(summary.total),
    days: days.map(priced),
  };
}

/** `3 calls, 3,060 tokens, ~$0.00013` (with the failures, when some calls failed). */
export function describeUsage(usage: JevUsage): string {
  const n = (value: number): string => value.toLocaleString("en-US");
  const failed = usage.failures === 0 ? "" : ` (${n(usage.failures)} failed)`;
  return `${n(usage.calls)} call${usage.calls === 1 ? "" : "s"}${failed}, ${n(usage.inputTokens + usage.outputTokens)} tokens, ~$${usage.dollars.toFixed(usage.dollars === 0 ? 2 : 5)}`;
}

/** The state as one phrase: `on · jev-1.13.0 at …`, `off …`, `off in this repository …`, `on, but TYPESAFE_API_KEY is not set …`. */
export function describeJevState(status: JevStatus): string {
  switch (status.state) {
    case "off":
      return "off (turn on: debrief jev enable)";
    case "excluded":
      return "off in this repository (debrief jev enable --here)";
    case "no_key":
      return "on, but TYPESAFE_API_KEY is not set: no judgments";
    case "on":
      return `on · ${status.model} at ${status.endpoint}`;
  }
}
