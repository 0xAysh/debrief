import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";

function open(cwd: string, home: string): Memory {
  const memory = openMemory({ cwd, host: "claude-code", home });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

const note = (memory: Memory, body: string): string => memory.record({ kind: "note", body, attribution: "agent_inference" }).recordId;
const ranked = (memory: Memory, query: string): string[] => memory.recall({ query, maxTokens: 8000 }).items.map((item) => item.recordId);

describe("recall ranking: plain queries", () => {
  /** A small workspace of ordinary notes, a few of them naming identifiers and paths. */
  const NOTES: Record<string, string> = {
    retries: "the gateway retries twice with exponential backoff before it gives up",
    backoff: "backoff is capped at thirty seconds; retries past that are dropped",
    flaky: "the payments test is flaky when the clock crosses midnight",
    payments: "payments settle nightly; a failed settlement retries the next night",
    migration: "the database migration adds a column and rebuilds the search index",
    index: "rebuildSearchIndex regenerates chunks from canonical records",
    wal: "the database runs in WAL mode so several processes can share one file",
    timeout: "the gateway timeout is five seconds for reads and thirty for writes",
    docs: "docs live in docs/architecture.md and docs/development.md",
    budget: "a small budget truncates the pack and returns a continuation",
    cache: "the cache is warmed at startup and evicted every hour",
    lint: "lint runs eslint with the strict type-checked config",
  };
  /** Recorded on main (0.1.0), before identifier, phrase and time ranking existed. */
  const MAIN_ORDERS: [string, string[]][] = [
    ["retry backoff", ["backoff", "retries", "payments"]],
    ["gateway timeout seconds", ["timeout", "backoff", "retries"]],
    ["payments flaky nightly", ["payments", "flaky"]],
    ["the pack budget", ["budget", "flaky", "migration", "lint", "cache", "payments", "retries", "timeout", "wal"]],
    ["docs architecture", ["docs"]],
  ];

  test("a query with no time words, quotes or identifiers ranks exactly as on main", () => {
    const memory = open(initRepo(), tempDir());
    const names = new Map(Object.entries(NOTES).map(([name, body]) => [note(memory, body), name]));
    const order = (query: string): (string | undefined)[] => ranked(memory, query).map((id) => names.get(id));
    expect(MAIN_ORDERS.map(([query]) => [query, order(query)])).toEqual(MAIN_ORDERS);
  });

  test("a plain word that occurs inside an identifier now finds it too, and what main found keeps its order", () => {
    const memory = open(initRepo(), tempDir());
    const names = new Map(Object.entries(NOTES).map(([name, body]) => [note(memory, body), name]));
    // main: ["migration", "wal"]
    expect(ranked(memory, "database index rebuild").map((id) => names.get(id))).toEqual(["migration", "index", "wal"]);
  });
});

describe("recall ranking: code identifiers", () => {
  test.each(["rankSequence", "rank_sequence", "RankSequence"])('a query for "rank sequence" finds a record that only says %s', (identifier) => {
    const memory = open(initRepo(), tempDir());
    note(memory, "the weather service times out");
    const id = note(memory, `recall freezes its order in ${identifier}() on page one`);
    expect(ranked(memory, "rank sequence")).toEqual([id]);
  });

  test("the exact identifier ranks above records that only have its words apart", () => {
    const memory = open(initRepo(), tempDir());
    const words = note(memory, "rank the sequence of sequence steps by rank, then sequence them again");
    const spaced = note(memory, "each sequence has a rank");
    const exact = note(memory, "rankSequence freezes the order");
    const order = ranked(memory, "rankSequence");
    expect(order[0]).toBe(exact);
    expect(order.slice(1).sort()).toEqual([words, spaced].sort());
  });

  test.each(["freshness.ts", "retrieval/freshness"])("a query for the path fragment %s ranks the record that cites the path first", (query) => {
    const memory = open(initRepo(), tempDir());
    note(memory, "retrieval freshness: TS types for freshness");
    note(memory, "retrieval returns freshness per reference");
    const cites = note(
      memory,
      "after the review we moved the reference check into src/retrieval/freshness.ts, where it runs once per recall and is cached for the page, which keeps the budget pass cheap",
    );
    expect(ranked(memory, query)[0]).toBe(cites);
  });
});

describe("recall ranking: exact phrases", () => {
  test("a quoted phrase ranks the verbatim record above one with the same words scattered", () => {
    const memory = open(initRepo(), tempDir());
    const scattered = note(memory, "backoff tuning: the retry backoff is not exponential yet; retry backoff stays linear");
    const verbatim = note(memory, "after the outage the team agreed that every client call should retry with exponential backoff and a jitter of up to one second");
    expect(ranked(memory, "retry backoff exponential")[0]).toBe(scattered);
    expect(ranked(memory, '"exponential backoff" retry')).toEqual([verbatim, scattered]);
    // The pack says why, and says nothing when bm25 alone decided.
    expect(memory.recall({ query: '"exponential backoff" retry' }).items.map((item) => item.why)).toEqual(['exact "exponential backoff"', undefined]);
    expect(memory.recall({ query: "retry backoff exponential" }).items.every((item) => !("why" in item))).toBe(true);
  });
});

describe("recall ranking: time", () => {
  /** A Memory whose clock the test sets: records are stamped with it, and recall reads relative dates against it. */
  function clocked(): { memory: Memory; at: (date: Date) => void } {
    let now = new Date();
    const memory = openMemory({ cwd: initRepo(), host: "claude-code", home: tempDir(), now: () => now });
    onCleanup(() => {
      memory.close();
    });
    return {
      memory,
      at: (date) => {
        now = date;
      },
    };
  }

  test('"yesterday", "last week", "in August" and "before 2026-09-01" rank records from that time first, relative to now', () => {
    const { memory, at } = clocked();
    const written = (date: Date, word: string): string => {
      at(date);
      return note(memory, `cache eviction moved to ${word}`);
    };
    const july = written(new Date(2026, 6, 1, 12), "alpha");
    const august = written(new Date(2026, 7, 10, 12), "bravo");
    const lastWeek = written(new Date(2026, 8, 16, 12), "delta");
    const yesterday = written(new Date(2026, 8, 26, 12), "gamma");
    const today = written(new Date(2026, 8, 27, 9), "kilos");
    at(new Date(2026, 8, 27, 12)); // Sunday 27 September 2026, local time

    // Equally relevant records, so without time words the newest leads.
    expect(ranked(memory, "cache eviction")).toEqual([today, yesterday, lastWeek, august, july]);
    // Records outside the time still come back, after the ones inside it.
    expect(ranked(memory, "cache eviction yesterday")).toEqual([yesterday, today, lastWeek, august, july]);
    expect(ranked(memory, "what changed in cache eviction last week")).toEqual([lastWeek, today, yesterday, august, july]);
    expect(ranked(memory, "cache eviction in August")).toEqual([august, today, yesterday, lastWeek, july]);
    expect(ranked(memory, "cache eviction before 2026-09-01")).toEqual([august, july, today, yesterday, lastWeek]);
    // Time words alone list by recency, the time asked for first.
    expect(ranked(memory, "yesterday")).toEqual([yesterday, today, lastWeek, august, july]);
    expect(ranked(memory, "what did we do yesterday?")).toEqual([yesterday, today, lastWeek, august, july]);

    // Page 1 freezes the order and the reasons; a continuation read on a later day keeps both.
    const first = memory.recall({ query: "cache eviction before 2026-09-01", maxBytes: 3_000 });
    expect(first.items.length).toBeLessThan(5);
    at(new Date(2026, 9, 5, 12));
    const pages = [first];
    for (let token = first.continuation; token !== null; token = pages.at(-1)?.continuation ?? null) {
      pages.push(memory.recall({ continuation: token, maxBytes: 3_000 }));
    }
    const items = pages.flatMap((page) => page.items);
    expect(items.map((item) => item.recordId)).toEqual([august, july, today, yesterday, lastWeek]);
    expect(items.map((item) => item.why)).toEqual(["created before 2026-09-01", "created before 2026-09-01", undefined, undefined, undefined]);
  });

  test('"what do we use now for X" prefers the newest of three matching records', () => {
    const { memory, at } = clocked();
    at(new Date(2026, 5, 1, 12));
    for (const topic of ["the gateway retries twice", "payments run nightly", "the docs site is static", "logs rotate daily", "tokens expire hourly"]) {
      note(memory, topic);
    }
    at(new Date(2026, 6, 1, 12));
    const oldest = note(memory, "we use webpack for bundling");
    at(new Date(2026, 7, 1, 12));
    const middle = note(memory, "we use rollup for bundling here");
    at(new Date(2026, 8, 20, 12));
    const newest = note(memory, "we use esbuild for bundling here");
    at(new Date(2026, 8, 25, 12));
    const unrelated = note(memory, "we use pnpm for installs");
    at(new Date(2026, 8, 27, 12));

    expect(ranked(memory, "what do we use for bundling")[0]).toBe(oldest);
    expect(ranked(memory, "what do we use now for bundling")).toEqual([newest, middle, oldest, unrelated]);
    expect(memory.recall({ query: "what do we use now for bundling" }).items.map((item) => item.why)).toEqual([
      "newest first: asks about now",
      "newest first: asks about now",
      "newest first: asks about now",
      undefined,
    ]);
  });
});
