import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { type ContextPack, type Memory, openMemory } from "../../src/memory.js";
import type { RecordInput } from "../../src/schemas.js";
import { git, initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeConfigDir, claudeReadStep, claudeSession, installTranscript, type SessionStep } from "../import/fixtures.js";
import { CLI, spawnServer } from "./harness.js";

/**
 * `debrief report` (#69, PR B), run as the built CLI over a workspace built with real calls: the
 * memory module logs them as the transports do (`noteCall`, with the clock it is given), the MCP
 * server for the review (R9), and hand-written Claude Code transcripts imported with consent.
 */

interface Env {
  repo: string;
  home: string;
  config: string;
}

/** The clock every Memory of a test reads; moving `clock.at` backdates what they log and write. */
const clock = { at: new Date() };
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** A few hours ago: inside the default 7-day window, and before every transcript a test writes. */
const base = (): number => Date.now() - 6 * HOUR;

const S1 = "5e550000-0000-4000-8000-0000000000b1";
const S2 = "5e550000-0000-4000-8000-0000000000b2";
const S3 = "5e550000-0000-4000-8000-0000000000b3";
const S4 = "5e550000-0000-4000-8000-0000000000b4";

const ON_PTY = resolve(import.meta.dirname, "on-pty.py");
const PYTHON = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;
if (PYTHON === null) process.stderr.write("report terminal test skipped: python3 (for a pty) is not on PATH\n");

function open(e: Env, hostSessionId?: string): Memory {
  const memory = openMemory({ cwd: e.repo, home: e.home, host: "claude-code", claudeConfigDir: e.config, now: () => clock.at, ...(hostSessionId === undefined ? {} : { hostSessionId }) });
  onCleanup(() => {
    memory.close();
  });
  memory.bootstrap();
  return memory;
}

/** A repository with `files` committed and a workspace whose transcript import is approved (or declined). */
function env(options: { consent?: boolean; files?: Record<string, string>; home?: string } = {}): Env {
  const repo = initRepo({ branch: "main" });
  for (const [path, content] of Object.entries(options.files ?? {})) writeFile(repo, path, content);
  if (options.files !== undefined) {
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "files");
  }
  const e = { repo, home: options.home ?? tempDir(), config: claudeConfigDir() };
  clock.at = new Date();
  const memory = openMemory({ cwd: e.repo, home: e.home, host: "claude-code", claudeConfigDir: e.config });
  memory.bootstrap({ importChoice: options.consent === false ? "none" : "current_project" });
  memory.close();
  return e;
}

function writeFile(repo: string, path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function report(e: Env, args: string[] = [], input?: string): { code: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [CLI, "report", ...args], {
    cwd: e.repo,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, DEBRIEF_HOME: e.home, CLAUDE_CONFIG_DIR: e.config },
    ...(input === undefined ? {} : { input }),
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

function ok(e: Env, args: string[] = [], input?: string): string {
  const run = report(e, args, input);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(0);
  return run.stdout;
}

/** The value after a report line's label: `  sessions       3   searched 2` → `3   searched 2`. */
function line(out: string, label: string): string {
  const found = out.split("\n").find((l) => l.trimStart().startsWith(`${label} `) && l.startsWith("  "));
  if (found === undefined) throw new Error(`no "${label}" line in:\n${out}`);
  return found.trimStart().slice(label.length).trim().replace(/\s+/g, " ");
}

/** A note, stamped with the shared clock's time. */
function note(memory: Memory, body: string, extra: { externalRefs?: RecordInput["externalRefs"] } = {}): string {
  return memory.record({ kind: "note", body, attribution: "agent_inference", ...extra }).recordId;
}

/** A recall at `at`, logged as the MCP transport logs it; returns what it returned. */
function recall(memory: Memory, query: string, at: number, options: { ms?: number; bytes?: number } = {}): ContextPack {
  clock.at = new Date(at);
  const pack = memory.recall({ query });
  memory.noteCall({ source: "tool", name: "memory_recall", args: { query }, result: pack, ms: options.ms ?? 2, bytes: options.bytes ?? 400 });
  return pack;
}

function readCall(memory: Memory, recordId: string, at: number): void {
  clock.at = new Date(at);
  memory.noteCall({ source: "tool", name: "memory_read", args: { recordId }, result: memory.read({ recordId }), ms: 1, bytes: 100 });
}

function sessionStart(memory: Memory, at: number, bytes: number): void {
  clock.at = new Date(at);
  memory.sessionStart({});
  memory.noteCall({ source: "hook", name: "session-start", ms: 5, bytes });
}

/** Installs a hand-written transcript of host session `sessionId` and imports every approved transcript. */
function transcript(e: Env, sessionId: string, at: number, steps: readonly SessionStep[]): void {
  installTranscript(e.config, "", { cwd: e.repo, sessionId, content: claudeSession({ cwd: e.repo, sessionId, at: new Date(at), steps }) });
}

function importAll(e: Env): void {
  const memory = openMemory({ cwd: e.repo, home: e.home, host: "claude-code", claudeConfigDir: e.config });
  try {
    expect(memory.importHistory().problem).toBeNull();
  } finally {
    memory.close();
  }
}

const editStep = (e: Env, path: string): SessionStep => ({ tool: "Edit", input: { file_path: join(e.repo, path), old_string: "a", new_string: "b" }, result: `The file ${join(e.repo, path)} has been updated successfully.` });
const readStep = (e: Env, path: string, text: string): SessionStep => claudeReadStep(join(e.repo, path), text);
const code = (path: string) => [{ kind: "code" as const, locator: path }];

function forget(memory: Memory, recordId: string): void {
  const preview = memory.manage({ action: "forget_preview", recordIds: [recordId] });
  if (preview.action !== "forget_preview") throw new Error("unreachable");
  memory.manage({ action: "forget", confirmToken: preview.confirmToken, reason: "The user asked to forget it.", attribution: "user_direction" });
}

describe("debrief report", () => {
  test("R1: usage counts sessions, sessions that searched, searches per session and the empty rate; rows older than --since are left out", () => {
    const e = env();
    const t = base();
    const writer = open(e);
    note(writer, "The gateway retries a 504 three times.");
    writer.close();

    const one = open(e, S1);
    sessionStart(one, t, 800);
    recall(one, "gateway retries", t + MINUTE);
    recall(one, "pangolin", t + 2 * MINUTE);
    one.close();
    const two = open(e, S2);
    sessionStart(two, t + 3 * MINUTE, 800);
    two.close();
    const three = open(e, S3);
    recall(three, "gateway", t + 4 * MINUTE);
    three.close();
    const old = open(e, S4);
    recall(old, "gateway", Date.now() - 10 * 24 * HOUR);
    old.close();

    const out = ok(e);
    expect(line(out, "sessions")).toBe("3 searched 2 · never 1");
    expect(line(out, "searches")).toBe("3 1.0 per session · empty 1 (33%)");

    const month = ok(e, ["--since", "30d"]);
    expect(line(month, "sessions")).toBe("4 searched 3 · never 1");
    expect(line(month, "searches")).toBe("4 1.0 per session · empty 1 (25%)");
  });

  test("R2: a returned record the agent later read, cited or whose file it edited is used; one nothing touched afterwards is not, whatever happened before the recall", () => {
    const e = env({ files: { "src/d.ts": "export const d = 1;\n", "src/e.ts": "export const e = 1;\n" } });
    const t = base();
    const writer = open(e);
    clock.at = new Date(t - HOUR);
    const a = note(writer, "Quail fact A: the ledger flushes on close.");
    const b = note(writer, "Quail fact B: retries back off exponentially.");
    const d = note(writer, "Quail fact D: the d module owns the constant.", { externalRefs: code("src/d.ts") });
    const eRecord = note(writer, "Quail fact E: the e module owns the other constant.", { externalRefs: code("src/e.ts") });
    writer.close();

    const session = open(e, S1);
    // Before the recall: reading E and editing its file are not uses of what the recall returned.
    readCall(session, eRecord, t);
    const pack = recall(session, "quail fact", t + 10 * MINUTE);
    expect(new Set(pack.items.map((item) => item.recordId))).toEqual(new Set([a, b, d, eRecord]));
    readCall(session, a, t + 11 * MINUTE);
    clock.at = new Date(t + 12 * MINUTE);
    session.record({ kind: "decision", body: "Keep the exponential back-off.", attribution: "agent_inference", supportedBy: [b] });
    session.close();
    // E's file edited before the recall, D's after it.
    transcript(e, S1, t + 5 * MINUTE, [editStep(e, "src/e.ts"), { waitMs: 15 * MINUTE }, editStep(e, "src/d.ts")]);
    importAll(e);

    const out = ok(e);
    expect(line(out, "recall")).toBe("4 used 3 (read 1 · cited 1 · file edited 1) · unused 1");
  });

  test("R3: a returned record later retracted, corrected, superseded or forgotten counts as returned, later wrong", () => {
    const e = env();
    const t = base();
    const writer = open(e);
    clock.at = new Date(t - HOUR);
    const [retracted, corrected, superseded, forgotten, right] = ["one", "two", "three", "four", "five"].map((n) => note(writer, `Heron claim ${n}: the cache is warm.`));
    writer.close();
    const session = open(e, S1);
    expect(recall(session, "heron claim", t).items).toHaveLength(5);
    const why = { reason: "It was wrong.", attribution: "user_direction" } as const;
    session.manage({ action: "retract", recordId: retracted ?? "", ...why });
    session.manage({ action: "correct", recordId: corrected ?? "", body: "Heron claim two: the cache is cold.", ...why });
    session.manage({ action: "supersede", recordId: superseded ?? "", body: "Heron claim three: the cache is warm after deploy.", ...why });
    forget(session, forgotten ?? "");

    const out = ok(e);
    expect(line(out, "later wrong")).toBe("4 of 5 returned");
    const listed = out.split("\n").filter((l) => /^ {4}rec_[0-9a-f]{32} {2}/.test(l)).map((l) => l.trim().split(/\s+/));
    expect(new Map(listed.map(([id, what]) => [id, what]))).toEqual(
      new Map([
        [retracted, "retracted"],
        [corrected, "corrected"],
        [superseded, "superseded"],
        [forgotten, "forgotten"],
      ]),
    );
    expect(out).not.toContain(right);
  });

  test("R4: the freshness mix returned; a stale record's file read before it was edited counts as re-checked, edited without reading does not", () => {
    const original = "export const s1 = 1;\nexport const s2 = 2;\n";
    const e = env({ files: { "src/s.ts": original } });
    const t = base();
    const writer = open(e);
    clock.at = new Date(t - HOUR);
    const stale = note(writer, "Wren fact: s1 and s2 are constants.", { externalRefs: [{ kind: "code", locator: "src/s.ts", lines: [1, 2] }] });
    note(writer, "Wren fact: no file behind this one.");
    writer.close();
    const changed = "export const s1 = 10;\nexport const s2 = 20;\n";
    writeFile(e.repo, "src/s.ts", changed);

    const packs: ContextPack[] = [];
    for (const [session, at] of [
      [S1, t],
      [S2, t + HOUR],
    ] as const) {
      const memory = open(e, session);
      packs.push(recall(memory, "wren fact", at));
      memory.close();
    }
    for (const pack of packs) expect(pack.items.find((item) => item.recordId === stale)?.freshness).toBe("stale");
    installTranscript(e.config, "", { cwd: e.repo, sessionId: S1, content: claudeSession({ cwd: e.repo, sessionId: S1, at: new Date(t + MINUTE), steps: [readStep(e, "src/s.ts", changed), editStep(e, "src/s.ts")] }) });
    // S2 read the file only before the recall and after the edit: not a re-check.
    installTranscript(e.config, "", {
      cwd: e.repo,
      sessionId: S2,
      content: claudeSession({ cwd: e.repo, sessionId: S2, at: new Date(t + HOUR - MINUTE), steps: [readStep(e, "src/s.ts", changed), { waitMs: 2 * MINUTE }, editStep(e, "src/s.ts"), readStep(e, "src/s.ts", changed)] }),
    });
    importAll(e);

    const tally = { current: 0, stale: 0, unknown: 0 };
    for (const pack of packs) for (const item of pack.items) tally[item.freshness]++;
    const out = ok(e);
    expect(line(out, "returned")).toBe(`current ${tally.current} · stale ${tally.stale} · unknown ${tally.unknown}`);
    expect(line(out, "stale, edited")).toBe("2 re-checked first 1 · not 1");
  });

  test("R5: a file read in a session where the agent-written record covering it was never returned is listed; imported records, records returned first and records written later are not", () => {
    const files = { "src/f.ts": "export const f = 1;\n", "src/g.ts": "export const g = 1;\n", "src/h.ts": "export const h = 1;\n" };
    const e = env({ files });
    const t = base();
    // An earlier imported session read g: its imported evidence covers g, and never counts.
    installTranscript(e.config, "", { cwd: e.repo, sessionId: S4, content: claudeSession({ cwd: e.repo, sessionId: S4, at: new Date(t - 2 * HOUR), steps: [readStep(e, "src/g.ts", files["src/g.ts"])] }) });
    importAll(e);
    const writer = open(e);
    clock.at = new Date(t - HOUR);
    const covering = note(writer, "Kestrel fact: f exports one constant.", { externalRefs: code("src/f.ts") });
    note(writer, "Osprey fact: unrelated.");
    clock.at = new Date(t + 2 * HOUR);
    note(writer, "Kestrel fact: h exports one constant.", { externalRefs: code("src/h.ts") });
    writer.close();

    // S1 never got the covering record, and read f, g and h.
    const s1 = open(e, S1);
    recall(s1, "osprey", t);
    s1.close();
    installTranscript(e.config, "", {
      cwd: e.repo,
      sessionId: S1,
      content: claudeSession({ cwd: e.repo, sessionId: S1, at: new Date(t + MINUTE), steps: [readStep(e, "src/f.ts", files["src/f.ts"]), readStep(e, "src/g.ts", files["src/g.ts"]), readStep(e, "src/h.ts", files["src/h.ts"])] }),
    });
    // S2 got it, then read f.
    const s2 = open(e, S2);
    expect(recall(s2, "kestrel", t + 10 * MINUTE).items.map((item) => item.recordId)).toContain(covering);
    s2.close();
    installTranscript(e.config, "", { cwd: e.repo, sessionId: S2, content: claudeSession({ cwd: e.repo, sessionId: S2, at: new Date(t + 11 * MINUTE), steps: [readStep(e, "src/f.ts", files["src/f.ts"])] }) });
    importAll(e);

    const out = ok(e);
    const listed = out.split("\n").filter((l) => /^ {4}rec_/.test(l)).map((l) => l.trim().split(/\s+/));
    expect(listed).toEqual([[covering, "src/f.ts", `session`, S1.slice(0, 8)]]);
  });

  test("R6: latency p50/p95 per call and per recall stage; tokens injected per session, labelled as an estimate; never a saving", () => {
    const e = env();
    const writer = open(e);
    note(writer, "Plover fact: the queue drains nightly.");
    writer.close();
    const t = base();
    const one = open(e, S1);
    for (let i = 1; i <= 20; i++) recall(one, "plover", t + i * 1_000, { ms: i, bytes: 0 });
    sessionStart(one, t + MINUTE, 400);
    // Stop's output never reaches the model.
    clock.at = new Date(t + 2 * MINUTE);
    one.noteCall({ source: "hook", name: "stop", ms: 1, bytes: 4_000 });
    one.close();
    const two = open(e, S2);
    sessionStart(two, t, 800);
    two.close();
    const three = open(e, S3);
    sessionStart(three, t, 1_200);
    three.close();

    const out = ok(e);
    expect(line(out, "memory_recall")).toBe("20 10.0 19.0");
    for (const stage of ["rank", "load", "freshness", "pack"]) expect(line(out, stage)).toMatch(/^\d+\.\d \d+\.\d$/);
    // Per session: 100, 200 and 300 tokens (bytes ÷ 4).
    expect(line(out, "injected tokens")).toBe("p50 200 · p95 300 per session · 3 sessions (estimate: bytes ÷ 4)");
    expect(out.toLowerCase()).not.toMatch(/sav(ed|ings?)/);
  });

  test("R7: without import consent, only what the call log shows, and a line saying the rest needs imported transcripts", () => {
    const e = env({ consent: false });
    const writer = open(e);
    note(writer, "Grebe fact: the index is rebuilt weekly.");
    writer.close();
    const session = open(e, S1);
    recall(session, "grebe", base());
    session.close();

    const out = ok(e);
    expect(line(out, "sessions")).toBe("1 searched 1 · never 0");
    expect(out).toContain("needs imported transcripts: run debrief import");
    for (const heading of ["Used after returned", "Rediscovery"]) expect(out).not.toContain(heading);
    expect(out).not.toContain("stale, edited");
    for (const heading of ["Usage", "Correctness", "Freshness", "Cost", "Your reviews"]) expect(out).toMatch(new RegExp(`^${heading}$`, "m"));
  });

  test("R8: by default only the current repository; --all covers every registered workspace", () => {
    const home = tempDir();
    const first = env({ home });
    const second = env({ home });
    for (const [e, sessions] of [
      [first, [S1]],
      [second, [S2, S3]],
    ] as const) {
      for (const session of sessions) {
        const memory = open(e, session);
        sessionStart(memory, base(), 400);
        memory.close();
      }
    }
    expect(line(ok(first), "sessions")).toBe("1 searched 0 · never 1");
    expect(line(ok(second), "sessions")).toBe("2 searched 0 · never 2");
    const all = ok(first, ["--all"]);
    expect(line(all, "sessions")).toBe("3 searched 0 · never 3");
    const header = all.split("\n")[0] ?? "";
    for (const repo of [first.repo, second.repo]) expect(header).toContain(repo.split("/").at(-1));
  });

  test("R9: --review offers at most 10 unrated searches from the window with what came back, stores good/partial/missed and a note; a later report shows them and a rated search is not offered again", async () => {
    const e = env();
    const writer = open(e);
    // One word per record, so each search returns only its own record.
    const words = ["alder", "birch", "cedar", "daphne", "elm", "fir", "ginkgo", "hazel", "juniper", "larch", "maple", "nutmeg"];
    const records = words.map((word, i) => note(writer, `Tree note ${word}: detail number ${i}.`));
    writer.close();
    const handle = await spawnServer({ cwd: e.repo, home: e.home, host: "claude-code", claudeConfigDir: e.config });
    for (const word of words) expect((await handle.ok<{ items: unknown[] }>("memory_recall", { query: word })).items).toHaveLength(1);
    await handle.close();
    // A record one search returned is forgotten: that search is still offered, the record shown as [forgotten].
    const forgetter = open(e);
    forget(forgetter, records[0] ?? "");
    forgetter.close();

    const offered = (out: string): string[] => [...out.matchAll(/^\[\d+\/\d+\] .*$/gm)].map((m) => m[0]);
    const first = ok(e, ["--review"], ["g", "p", "missing the retry doc", "m", "", "g", "g", "g", "g", "g", "g", "g"].join("\n") + "\n");
    const firstOffered = offered(first);
    expect(firstOffered).toHaveLength(10);
    const secondRun = ok(e, ["--review"], "g\ng\n");
    const secondOffered = offered(secondRun);
    expect(secondOffered).toHaveLength(2);
    const shown = (items: string[]) => items.map((l) => /"([a-z]+)"/.exec(l)?.[1] ?? "(erased)");
    const all = [...shown(firstOffered), ...shown(secondOffered)];
    expect(new Set(all).size).toBe(12);
    // The search whose record was forgotten lost its query; what it returned shows as [forgotten].
    expect(all.filter((q) => q === "(erased)")).toHaveLength(1);
    expect(first + secondRun).toContain("[forgotten]");
    expect(all.filter((q) => q !== "(erased)").sort()).toEqual(words.slice(1));
    expect(first + secondRun).not.toContain("Tree note alder");
    expect(first + secondRun).toContain("Tree note birch");

    expect(ok(e, ["--review"], "")).toContain("No unrated searches");
    const out = ok(e);
    expect(line(out, "rated")).toBe("12 good 10 · partial 1 · missed 1");
    expect(out).toContain("missing the retry doc");
  });

  test("R10: after forget or private_session, no report or review prints the erased query text or a note about it", () => {
    for (const change of ["forget", "private"] as const) {
      const e = env();
      const writer = open(e);
      const secret = note(writer, "Quokka rotation: keys rotate on Fridays.");
      writer.close();
      const session = open(e, S1);
      recall(session, "quokka rotation", base());
      session.close();
      ok(e, ["--review"], "p\nquokka schedule was missing\n");
      expect(ok(e)).toContain("quokka");

      const after = open(e, S1);
      if (change === "forget") forget(after, secret);
      else after.manage({ action: "private_session" });
      after.close();

      for (const out of [ok(e), ok(e, ["--review"], "")]) expect(out.toLowerCase(), change).not.toContain("quokka");
    }
  });

  test("R11: a restored older copy of the database shows no query a later forget or private_session erased, nor a note about it", () => {
    for (const change of ["forget", "private"] as const) {
      const e = env();
      const writer = open(e);
      const secret = note(writer, "Quokka rotation: keys rotate on Fridays.");
      const dbPath = writer.status().storage.dbPath ?? "";
      writer.close();
      const session = open(e, S1);
      recall(session, "quokka rotation", base());
      session.close();
      ok(e, ["--review"], "p\nquokka schedule was missing\n");
      const backup = join(tempDir(), "backup.sqlite");
      copyFileSync(dbPath, backup);

      const after = open(e, S1);
      if (change === "forget") forget(after, secret);
      else after.manage({ action: "private_session" });
      after.close();
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
      copyFileSync(backup, dbPath);

      // The report is the first thing to open the restored copy.
      expect(ok(e).toLowerCase(), change).not.toContain("quokka");
    }
  });

  test("R13 (#33): a session start without work memory injects fewer tokens, and a record it no longer shows counts as rediscovered when its file is read", () => {
    const files = { "src/f.ts": "export const f = 1;\n" };
    const e = env({ files });
    const t = base();
    const writer = open(e);
    clock.at = new Date(t - 2 * HOUR);
    for (let i = 0; i < 60; i++) note(writer, `Osprey fact ${i}: ${"the queue drains nightly; ".repeat(12)}`);
    // The newest record: a start that listed recent memory would have shown it first.
    clock.at = new Date(t - HOUR);
    const covering = note(writer, "Kestrel fact: f exports one constant.", { externalRefs: code("src/f.ts") });
    writer.close();

    // S1 starts with the hook's real context, logged with its size, then reads f without searching memory.
    const s1 = open(e, S1);
    clock.at = new Date(t);
    const start = s1.sessionStart({});
    if (start === null) throw new Error("no session start inside a repository");
    s1.noteCall({ source: "hook", name: "session-start", ms: 5, bytes: Buffer.byteLength(start.context) });
    s1.close();
    transcript(e, S1, t + MINUTE, [readStep(e, "src/f.ts", files["src/f.ts"])]);
    importAll(e);

    const out = ok(e);
    const listed = out.split("\n").filter((l) => /^ {4}rec_/.test(l)).map((l) => l.trim().split(/\s+/));
    expect(listed).toEqual([[covering, "src/f.ts", "session", S1.slice(0, 8)]]);
    // The protocol, the header and a pointer: about an empty repository's start (≤ 2,850 bytes) plus one line, whatever memory holds.
    const injected = Number(/^p50 (\d+) /.exec(line(out, "injected tokens"))?.[1]);
    expect(injected).toBeGreaterThan(0);
    expect(injected).toBeLessThanOrEqual(Math.ceil((2_850 + 300) / 4));
  });

  test.skipIf(PYTHON === null)("R12: on a terminal, --review exits once the last search is rated", () => {
    const e = env();
    const writer = open(e);
    note(writer, "Tern fact: the cache warms at boot.");
    writer.close();
    const session = open(e, S1);
    recall(session, "tern", base());
    recall(session, "cache", base() + MINUTE);
    session.close();

    const run = spawnSync(PYTHON ?? "python3", [ON_PTY, "--prompt", "> ", "g\ng", process.execPath, CLI, "report", "--review"], {
      cwd: e.repo,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, DEBRIEF_HOME: e.home, CLAUDE_CONFIG_DIR: e.config },
    });
    expect(run.stdout).toContain("Stored 2 ratings.");
    expect(run.status).toBe(0);
  });
});
