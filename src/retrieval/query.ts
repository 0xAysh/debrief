import { RANKED_BY, splitIdentifier } from "./search.js";
import { describeTrust, type TrustReason } from "./trust.js";

/**
 * Reads what a recall query asks for beyond its words, with fixed rules and no model.
 *
 * - **Phrases:** a quoted phrase, or a code identifier (`rankSequence`, `rank_sequence`,
 *   `src/retrieval/freshness.ts`), is something the agent wants verbatim. Records that
 *   contain more of them rank first; bm25 orders the rest.
 * - **Time:** "yesterday", "last week", "in August", "before 2026-09-01" and the like name a
 *   window of `created_at`, read in local time against `now`. Relevant records from the
 *   window rank first; the rest still follow, because the agent's sense of when something
 *   happened is often a little off, and a boost cannot lose the answer the way a filter can.
 * - **Now:** "what do we use now for…", "currently", "latest" ask for the current state. Of
 *   records about equally relevant, the newest comes first: a later decision replaces an
 *   earlier one.
 *
 * The words searched are always the query's own (a record may itself say "last week"), so
 * these rules only reorder what keyword search finds. After them, trust (`retrieval/trust.ts`)
 * orders records the query's words match about equally well; that needs no reading of the query. The one exception is a query that is
 * only a time and question filler ("what did we do yesterday?"): searching "what did we do"
 * would match records at random, so it lists recent records, the time asked for first.
 */
export interface ParsedQuery {
  /** The text to search as words (see `toFtsQuery`): the query itself, or null when it asks only for a time. */
  words: string | null;
  /** Quoted phrases and identifiers, as written, deduplicated case-insensitively. */
  phrases: string[];
  /** Null when the query names no time. */
  window: TimeWindow | null;
  /** The query asks how things stand now ("what do we use now for…"). */
  current: boolean;
}

export interface TimeWindow {
  /** Inclusive lower bound (ISO 8601), or null for "any time before `to`". */
  from: string | null;
  /** Exclusive upper bound (ISO 8601), or null for "up to now". */
  to: string | null;
  /** The expressions that set it, as written ("last week"). */
  label: string;
}

/** Letters, digits and the characters identifiers and paths are joined with. */
const IDENTIFIER_RUN = /[\p{L}\p{N}_$./\\-]+/gu;
/** An inner `_`, `/`, `\` or `.` between word characters: snake_case, a path, a file name. */
const JOINED = /[\p{L}\p{N}][_/\\.][\p{L}\p{N}]/u;
/** Shorter dotted tokens are abbreviations ("e.g", "i.e"), not names. */
const MIN_JOINED_CHARS = 4;
const QUOTED = /"([^"]*)"|“([^”]*)”/gu;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** Full names, and abbreviations except "may", which only counts after a preposition anyway. */
const MONTH = String.raw`(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?`;
const DATE = String.raw`(\d{4})-(\d{2})-(\d{2})`;

type Range = { from: Date | null; to: Date | null };

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, days: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
/** Weeks start on Monday (ISO 8601). */
const startOfWeek = (d: Date): Date => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
const monthRange = (year: number, month: number): Range => ({ from: new Date(year, month, 1), to: new Date(year, month + 1, 1) });
const monthIndex = (name: string): number => MONTHS.indexOf(name.slice(0, 3).toLowerCase());
/** A month named without a year is the latest one that has begun. */
const namedMonth = (name: string, year: string | undefined, now: Date): Range => {
  const month = monthIndex(name);
  if (year !== undefined) return monthRange(Number(year), month);
  return monthRange(month <= now.getMonth() ? now.getFullYear() : now.getFullYear() - 1, month);
};
const dateRange = (y: string, m: string, d: string): Range | null => {
  const start = new Date(Number(y), Number(m) - 1, Number(d));
  if (start.getMonth() !== Number(m) - 1) return null; // 2026-02-30 is not a date
  return { from: start, to: addDays(start, 1) };
};
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30 };

/** Each rule is a whole expression; the first rule to claim a stretch of text wins it. */
const TIME_RULES: { pattern: RegExp; range: (m: RegExpMatchArray, now: Date) => Range | null }[] = [
  { pattern: /\btoday\b/giu, range: (_, now) => ({ from: startOfDay(now), to: addDays(startOfDay(now), 1) }) },
  { pattern: /\byesterday\b/giu, range: (_, now) => ({ from: addDays(startOfDay(now), -1), to: startOfDay(now) }) },
  { pattern: /\bthis week\b/giu, range: (_, now) => ({ from: startOfWeek(now), to: addDays(startOfWeek(now), 7) }) },
  { pattern: /\b(?:last|previous) week\b/giu, range: (_, now) => ({ from: addDays(startOfWeek(now), -7), to: startOfWeek(now) }) },
  { pattern: /\bthis month\b/giu, range: (_, now) => monthRange(now.getFullYear(), now.getMonth()) },
  { pattern: /\b(?:last|previous) month\b/giu, range: (_, now) => monthRange(now.getFullYear(), now.getMonth() - 1) },
  {
    pattern: /\b(?:last|past) (\d{1,3}) (day|week|month)s?\b/giu,
    range: (m, now) => ({ from: new Date(now.getTime() - Number(m[1]) * (UNIT_DAYS[m[2]?.toLowerCase() ?? ""] ?? 1) * 86_400_000), to: null }),
  },
  {
    pattern: new RegExp(String.raw`\b(before|until|after|since|on|in|during) (?:${DATE}|${MONTH}(?: (\d{4}))?)(?![\p{L}\p{N}])`, "giu"),
    range: (m, now) => {
      const [, preposition = "", y, mo, d, month, year] = m;
      const range = y !== undefined && mo !== undefined && d !== undefined ? dateRange(y, mo, d) : namedMonth(month ?? "", year, now);
      if (range === null) return null;
      switch (preposition.toLowerCase()) {
        case "before":
          return { from: null, to: range.from };
        case "until":
          return { from: null, to: range.to };
        case "after":
          return { from: range.to, to: null };
        case "since":
          return { from: range.from, to: null };
        default:
          return range;
      }
    },
  },
];

/** Several time expressions narrow each other ("after 2026-08-01 before 2026-09-01"). */
export function parseQuery(query: string, now: Date): ParsedQuery {
  let words = query;
  const labels: { at: number; text: string }[] = [];
  let from: Date | null = null;
  let to: Date | null = null;
  for (const rule of TIME_RULES) {
    for (const match of words.matchAll(rule.pattern)) {
      const range = rule.range(match, now);
      if (range === null) continue;
      if (range.from !== null && (from === null || range.from > from)) from = range.from;
      if (range.to !== null && (to === null || range.to < to)) to = range.to;
      labels.push({ at: match.index, text: match[0] });
      // Blanked to the same length, so later matches keep their offsets.
      words = words.slice(0, match.index) + " ".repeat(match[0].length) + words.slice(match.index + match[0].length);
    }
  }
  const current = CURRENT.test(words);
  const phrases = phrasesIn(words);
  if (labels.length === 0 && !current) return { words: query, phrases, window: null, current: false };
  // "what did we do yesterday" asks only for a time: searching its filler would match records at random.
  const topical = words.replace(CURRENT_ALL, " ").replace(/[\p{L}\p{N}]+/gu, (word) => (FILLER.has(word.toLowerCase()) ? " " : word));
  const label = labels
    .sort((a, b) => a.at - b.at)
    .map((l) => l.text)
    .join(", ");
  return {
    words: /[\p{L}\p{N}]/u.test(topical) ? query : null,
    phrases,
    window: labels.length === 0 ? null : { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null, label },
    current,
  };
}

/** A question about how things stand now. */
const CURRENT_WORDS = String.raw`\b(?:right now|now|currently|current|nowadays|these days|at the moment|at present|anymore|latest)\b`;
const CURRENT = new RegExp(CURRENT_WORDS, "iu");
const CURRENT_ALL = new RegExp(CURRENT_WORDS, "giu");

/** Question filler: a query that names a time or asks about now with nothing but these left asks only for the time. */
const FILLER = new Set(
  (
    "what when which who why how did do does done doing we i you they us our me my the a an is are was were be been " +
    "happen happened happening change changed changes and or but on in at about of for to from with there anything something any some it that this"
  ).split(" "),
);

/**
 * The pack's short `why` for a record the query's tiers or trust lifted (`RANKED_BY` bits), naming
 * the phrases it `contains` and what trust saw on page 1 (`trusted`); undefined when bm25 alone placed it.
 */
export function explainRank(bits: number, query: ParsedQuery, contains: readonly string[], trusted?: TrustReason): string | undefined {
  const reasons: string[] = [];
  if ((bits & RANKED_BY.phrase) !== 0 && contains.length > 0) reasons.push(`exact ${contains.map((phrase) => JSON.stringify(phrase)).join(", ")}`);
  if ((bits & RANKED_BY.window) !== 0 && query.window !== null) reasons.push(`created ${query.window.label}`);
  if ((bits & RANKED_BY.newest) !== 0) reasons.push("newest first: asks about now");
  if ((bits & RANKED_BY.trust) !== 0 && trusted !== undefined) reasons.push(describeTrust(trusted));
  return reasons.length === 0 ? undefined : reasons.join("; ");
}

function phrasesIn(query: string): string[] {
  const phrases: string[] = [];
  const add = (phrase: string): void => {
    const normalized = phrase.replace(/\s+/gu, " ").trim();
    if (!/[\p{L}\p{N}]/u.test(normalized)) return;
    if (!phrases.some((known) => known.toLowerCase() === normalized.toLowerCase())) phrases.push(normalized);
  };
  for (const [, straight, curly] of query.matchAll(QUOTED)) add(straight ?? curly ?? "");
  for (const run of query.match(IDENTIFIER_RUN) ?? []) {
    const token = run.replace(/^[./\\-]+|[./\\-]+$/gu, "");
    const camel = (token.match(/[\p{L}\p{N}]+/gu) ?? []).some((word) => splitIdentifier(word).length > 1);
    if (camel || (JOINED.test(token) && token.length >= MIN_JOINED_CHARS)) add(token);
  }
  return phrases;
}
