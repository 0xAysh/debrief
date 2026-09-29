import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { claudeCodeAdapter } from "../../src/import/adapters/claude.js";
import type { TranscriptAdapter } from "../../src/import/normalized-event.js";
import { git, initRepo, onCleanup, tempDir } from "../helpers.js";
import { claudeBashStep, claudeConfigDir, claudeReadStep, claudeSession, codexHome, codexSession, codexThreadId, installCodexRollout, installTranscript, sedPrint, type SessionStep } from "./fixtures.js";

/**
 * Imported file reads get freshness from the text the agent read (#54): the transcript holds
 * what the model saw, so its fingerprint (never the text) labels the read's record `current`
 * while the file still holds that text, `stale` once it does not. Transcripts are hand-written;
 * the files are real, in a real Git worktree.
 */

/** 30 distinct, non-blank lines. */
const GATEWAY = Array.from({ length: 30 }, (_, i) => `export const step${i + 1} = retry(${i + 1});`).join("\n") + "\n";

function writeFile(repo: string, path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

/** A repository with `files` committed. */
function repoWith(files: Record<string, string>): string {
  const repo = initRepo();
  for (const [path, content] of Object.entries(files)) writeFile(repo, path, content);
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "files");
  return repo;
}

/** Imports one hand-written Claude Code session recorded in `repo`, returning the memory it was imported into. */
function importClaude(repo: string, steps: readonly SessionStep[], home = tempDir()): Memory {
  const config = claudeConfigDir();
  installTranscript(config, "", { cwd: repo, content: claudeSession({ cwd: repo, sessionId: "5e55a000-0000-4000-8000-000000000001", steps }) });
  const memory = openMemory({ cwd: repo, host: "claude-code", home, claudeConfigDir: config });
  onCleanup(() => {
    memory.close();
  });
  expect(memory.bootstrap({ importChoice: "current_project" }).import.state).toBe("complete");
  return memory;
}

/** Imports one hand-written Codex rollout recorded in `repo`, running `calls` there. */
function importCodex(repo: string, calls: readonly { cmd: string; output: string }[], home = tempDir()): Memory {
  const codex = codexHome();
  const threadId = codexThreadId();
  installCodexRollout(codex, "", { cwd: repo, threadId, content: codexSession({ cwd: repo, threadId, calls }) });
  const memory = openMemory({ cwd: repo, host: "codex", home, codexHome: codex });
  onCleanup(() => {
    memory.close();
  });
  expect(memory.bootstrap({ importChoice: "current_project" }).import.state).toBe("complete");
  return memory;
}

/** `nl -ba`'s output for lines `a`..`b` of `text`: each line numbered right-aligned in 6 columns, then a tab. */
function numbered(text: string, a: number, b: number): string {
  return sedPrint(text, a, b)
    .split("\n")
    .slice(0, -1)
    .map((line, i) => `${String(a + i).padStart(6)}\t${line}\n`)
    .join("");
}

/** Ids of the imported records whose title starts with `tool`, oldest first. */
function recordsOf(memory: Memory, tool: string): string[] {
  const found: { id: string; at: string }[] = [];
  let pack = memory.recall({ maxTokens: 8_000 });
  for (;;) {
    for (const item of pack.items) if (item.title?.startsWith(`${tool}:`)) found.push({ id: item.recordId, at: item.createdAt });
    if (pack.continuation === null) break;
    pack = memory.recall({ maxTokens: 8_000, continuation: pack.continuation });
  }
  return found.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map((r) => r.id);
}

/** The live label of the record's one reference: [freshness, reason, linesNow?]. */
function label(memory: Memory, recordId: string): unknown[] {
  const read = memory.read({ recordId });
  expect(read.externalRefs).toHaveLength(1);
  const ref = read.externalRefs[0];
  return ref?.linesNow === undefined ? [ref?.freshness, ref?.reason] : [ref.freshness, ref.reason, ref.linesNow];
}

describe("Claude Code Read", () => {
  test("R1: a whole-file Read is current while the file holds the text read, and stale once it is edited", () => {
    const repo = repoWith({ "src/gateway.ts": GATEWAY });
    const memory = importClaude(repo, [claudeReadStep(join(repo, "src/gateway.ts"), GATEWAY)]);
    const [read] = recordsOf(memory, "Read");
    expect(label(memory, read ?? "")).toEqual(["current", "unchanged"]);
    expect(memory.read({ recordId: read ?? "" }).externalRefs[0]).toMatchObject({ kind: "code", path: "src/gateway.ts", observedAt: "2026-09-23T09:00:01.500Z" });

    writeFile(repo, "src/gateway.ts", GATEWAY.replace("retry(30)", "retry(31)"));
    expect(label(memory, read ?? "")).toEqual(["stale", "changed"]);
  });

  test("R2: a Read with offset/limit fingerprints the lines read: an edit elsewhere or lines moved leave it current, an edit to them makes it stale", () => {
    const repo = repoWith({ "src/gateway.ts": GATEWAY });
    const memory = importClaude(repo, [claudeReadStep(join(repo, "src/gateway.ts"), GATEWAY, { offset: 10, limit: 5 }), claudeReadStep(join(repo, "src/gateway.ts"), GATEWAY, { offset: 27 })]);
    const [read, toEnd] = recordsOf(memory, "Read");
    expect(memory.read({ recordId: read ?? "" }).externalRefs[0]).toMatchObject({ path: "src/gateway.ts", lines: [10, 14], freshness: "current" });
    // Read to the end: the last line Claude Code shows for a final newline is not a line of the file.
    expect(memory.read({ recordId: toEnd ?? "" }).externalRefs[0]).toMatchObject({ lines: [27, 30], freshness: "current", reason: "changed_elsewhere" });

    writeFile(repo, "src/gateway.ts", GATEWAY.replace("retry(25)", "retry(250)"));
    expect(label(memory, read ?? "")).toEqual(["current", "changed_elsewhere"]);

    writeFile(repo, "src/gateway.ts", `// header\n// more\n${GATEWAY}`);
    expect(label(memory, read ?? "")).toEqual(["current", "lines_moved", [12, 16]]);

    writeFile(repo, "src/gateway.ts", GATEWAY.replace("retry(12)", "retry(120)"));
    expect(label(memory, read ?? "")).toEqual(["stale", "lines_changed"]);
  });
});

describe("Codex shell reads", () => {
  test("R3: `sed -n 'a,bp'` and `nl -ba | sed -n` fingerprint the lines printed, `cat` the whole file", () => {
    const retry = "export function retry(n) {\n  for (let i = 0; i < n; i++) attempt();\n}\n";
    const repo = repoWith({ "src/gateway.ts": GATEWAY, "src/retry.ts": retry });
    const memory = importCodex(repo, [
      { cmd: "sed -n '10,14p' src/gateway.ts", output: sedPrint(GATEWAY, 10, 14) },
      { cmd: "cat src/retry.ts", output: retry },
      { cmd: "nl -ba src/gateway.ts | sed -n '20,24p'", output: numbered(GATEWAY, 20, 24) },
    ]);
    const [sed, cat, nl] = recordsOf(memory, "exec_command");
    expect(memory.read({ recordId: sed ?? "" }).externalRefs[0]).toMatchObject({ path: "src/gateway.ts", lines: [10, 14], freshness: "current" });
    expect(memory.read({ recordId: nl ?? "" }).externalRefs[0]).toMatchObject({ path: "src/gateway.ts", lines: [20, 24], freshness: "current" });
    expect(label(memory, cat ?? "")).toEqual(["current", "unchanged"]);

    writeFile(repo, "src/gateway.ts", GATEWAY.replace("retry(12)", "retry(120)"));
    expect(label(memory, sed ?? "")).toEqual(["stale", "lines_changed"]);
    expect(label(memory, nl ?? "")).toEqual(["current", "changed_elsewhere"]);
    writeFile(repo, "src/retry.ts", retry.replace("n)", "count)"));
    expect(label(memory, cat ?? "")).toEqual(["stale", "changed"]);
  });
});

describe("Claude Code Bash reads", () => {
  /** Lines 10–11 and 19–20 are blank; the file ends at line 25. */
  const BLANKS = [...Array.from({ length: 9 }, (_, i) => `const a${i + 1} = ${i + 1};`), "", "", ...Array.from({ length: 7 }, (_, i) => `const b${i + 1} = ${i + 1};`), "", "", ...Array.from({ length: 5 }, (_, i) => `const c${i + 1} = ${i + 1};`)].join("\n") + "\n";

  test("R4: a range starting or ending on blank lines, or past the end of the file, is placed by the range asked for, and current while unchanged", () => {
    const repo = repoWith({ "src/blanks.ts": BLANKS });
    const memory = importClaude(repo, [
      claudeBashStep("sed -n '10,20p' src/blanks.ts", sedPrint(BLANKS, 10, 20)),
      claudeBashStep("head -n 11 src/blanks.ts", sedPrint(BLANKS, 1, 11)),
      claudeBashStep("sed -n '21,40p' src/blanks.ts", sedPrint(BLANKS, 21, 40)),
    ]);
    const [middle, head, tail] = recordsOf(memory, "Bash");
    expect(memory.read({ recordId: middle ?? "" }).externalRefs[0]).toMatchObject({ path: "src/blanks.ts", lines: [10, 20], freshness: "current", reason: "changed_elsewhere" });
    expect(memory.read({ recordId: head ?? "" }).externalRefs[0]).toMatchObject({ lines: [1, 11], freshness: "current", reason: "changed_elsewhere" });
    expect(memory.read({ recordId: tail ?? "" }).externalRefs[0]).toMatchObject({ lines: [21, 40], freshness: "current", reason: "changed_elsewhere" });

    // The fingerprint is of the lines read: moved by a line above, then edited.
    writeFile(repo, "src/blanks.ts", `// header\n${BLANKS}`);
    expect(label(memory, middle ?? "")).toEqual(["current", "lines_moved", [13, 19]]);
    writeFile(repo, "src/blanks.ts", BLANKS.replace("b4 = 4", "b4 = 40"));
    expect(label(memory, middle ?? "")).toEqual(["stale", "lines_changed"]);
    expect(label(memory, tail ?? "")).toEqual(["current", "changed_elsewhere"]);
  });
});

describe("reads and in-session edits", () => {
  /**
   * The rule the user approved (#54): a read's `current` says only that the file still holds the
   * text that read showed, which is true whenever the fingerprints match, whatever the session
   * did to the file after it. Imported claims carry no references, and labels never propagate.
   */
  const X = GATEWAY;
  const Y = GATEWAY.replace("retry(3)", "retry(3, { idempotencyKey })");

  function session(repo: string): { memory: Memory; before: string; edit: string; after: string; claim: string } {
    const path = join(repo, "src/gateway.ts");
    const memory = importClaude(repo, [
      claudeReadStep(path, X),
      { tool: "Edit", input: { file_path: path, old_string: "retry(3)", new_string: "retry(3, { idempotencyKey })" }, result: `The file ${path} has been updated successfully.` },
      { say: "Step three now retries with an idempotency key." },
      claudeReadStep(path, Y),
    ]);
    const [before, after] = recordsOf(memory, "Read");
    const [edit] = recordsOf(memory, "Edit");
    const claim = memory.recall({ query: "idempotency key", maxTokens: 8_000 }).items.find((item) => item.excerpt.includes("Step three now retries"));
    return { memory, before: before ?? "", edit: edit ?? "", after: after ?? "", claim: claim?.recordId ?? "" };
  }

  test("R5a/R5d: the session edits the file to Y and today it holds Y: the read before the edit is stale, the read after it current", () => {
    const repo = repoWith({ "src/gateway.ts": Y });
    const { memory, before, after } = session(repo);
    expect(label(memory, before)).toEqual(["stale", "changed"]);
    expect(label(memory, after)).toEqual(["current", "unchanged"]);
  });

  test("R5b: the edit was reverted and today the file holds X again: the read before the edit is current, the one after it stale", () => {
    const repo = repoWith({ "src/gateway.ts": X });
    const { memory, before, after } = session(repo);
    expect(label(memory, before)).toEqual(["current", "unchanged"]);
    expect(label(memory, after)).toEqual(["stale", "changed"]);
  });

  test("R5c: the claim made after the edit carries no reference and stays unknown; the edit's own reference was never fingerprinted", () => {
    const repo = repoWith({ "src/gateway.ts": Y });
    const { memory, edit, claim } = session(repo);
    expect(memory.read({ recordId: claim })).toMatchObject({ freshness: "unknown", externalRefs: [] });
    expect(label(memory, edit)).toEqual(["unknown", "transcript_reference"]);
  });
});

describe("reads Debrief cannot rebuild exactly", () => {
  /** Committed and never changed: a read wrongly fingerprinted would label current (or stale), never unknown. */
  const FILE = Array.from({ length: 12 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join("\n") + "\n";
  const persisted = `<persisted-output>\nOutput too large (97.7KB). Full output saved to: /tmp/claude/tool-results/b1.txt\n\nPreview (first 2KB):\n${sedPrint(FILE, 1, 6)}...\n</persisted-output>`;
  const gap = claudeReadStep("", FILE);
  const cases: [string, (path: string) => SessionStep[], "claude-code" | "codex"][] = [
    ["Claude Code output persisted to a file (only a preview reached the model)", (path) => [{ ...claudeBashStep(`sed -n '1,12p' ${path}`, FILE, { persistedOutputPath: "/tmp/claude/tool-results/b1.txt", persistedOutputSize: 100_000 }), result: persisted }], "claude-code"],
    ["a Read line longer than Claude Code shows whole", (path) => [claudeReadStep(path, FILE.replace("line1 = 1", `line1 = "${"x".repeat(2_100)}"`))], "claude-code"],
    ["Codex output cut to its token budget", (path) => [{ tool: "exec_command", input: { cmd: `cat ${path}` }, result: `${sedPrint(FILE, 1, 4)}…120 tokens truncated…${sedPrint(FILE, 9, 12)}` }], "codex"],
    ["an image Read", (path) => [{ tool: "Read", input: { file_path: path }, result: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }], toolUseResult: { type: "image", file: { base64: "iVBORw0KGgo=", type: "image/png", originalSize: 8 } } }], "claude-code"],
    ["a multi-file cat", (path) => [{ tool: "exec_command", input: { cmd: `cat ${path.replace("read.ts", "other.ts")} ${path}` }, result: FILE + FILE }], "codex"],
    ["output with echo separators", (path) => [{ tool: "exec_command", input: { cmd: `echo '== read.ts' && cat ${path}` }, result: `== read.ts\n${FILE}` }], "codex"],
    ["line numbers that do not run consecutively", (path) => [{ ...gap, input: { file_path: path }, result: (gap.result as string).replace("4\t", "5\t") }], "claude-code"],
    ["a regex range", (path) => [{ tool: "exec_command", input: { cmd: `sed -n '/line3/,/line9/p' ${path}` }, result: sedPrint(FILE, 3, 9) }], "codex"],
    ["a range of fewer than 3 non-blank lines", (path) => [claudeReadStep(path, FILE.replace("export const line6 = 6;", ""), { offset: 5, limit: 3 })], "claude-code"],
  ];

  test.each(cases)("R6: %s stays unknown", (_name, steps, host) => {
    const repo = repoWith({ "src/read.ts": FILE, "src/other.ts": FILE });
    const path = join(repo, "src/read.ts");
    let memory: Memory;
    let tool: string;
    if (host === "codex") {
      memory = importCodex(repo, steps(path).map((step) => ({ cmd: ((step as { input: { cmd: string } }).input.cmd), output: (step as { result: string }).result })));
      tool = "exec_command";
    } else {
      memory = importClaude(repo, steps(path));
      tool = (steps(path)[0] as { tool: string }).tool;
    }
    const records = recordsOf(memory, tool);
    expect(records).toHaveLength(1);
    const refs = memory.read({ recordId: records[0] ?? "" }).externalRefs;
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect([ref.freshness, ref.reason]).toEqual(["unknown", "transcript_reference"]);
  });
});

describe("what is stored", () => {
  test("R7: only fingerprints are stored: the database holds none of the text any read showed", () => {
    const secret = Array.from({ length: 12 }, (_, i) => `export const marker${i + 1} = "zebra-quartz-${i + 1}";`).join("\n") + "\n";
    const repo = repoWith({ "src/secret.ts": secret });
    const path = join(repo, "src/secret.ts");
    const home = tempDir();
    const claude = importClaude(repo, [claudeReadStep(path, secret), claudeReadStep(path, secret, { offset: 3, limit: 6 }), claudeBashStep(`sed -n '2,9p' ${path}`, sedPrint(secret, 2, 9))], home);
    const codex = importCodex(repo, [{ cmd: "cat src/secret.ts", output: secret }, { cmd: "nl -ba src/secret.ts | sed -n '4,10p'", output: numbered(secret, 4, 10) }], home);
    for (const memory of [claude, codex]) {
      for (const tool of ["Read", "Bash", "exec_command"]) for (const id of recordsOf(memory, tool)) expect(memory.read({ recordId: id }).freshness).toBe("current");
    }

    const dbPath = claude.status().storage.dbPath ?? "";
    const bytes = Buffer.concat(["", "-wal", "-shm"].map((suffix) => (existsSync(dbPath + suffix) ? readFileSync(dbPath + suffix) : Buffer.alloc(0))));
    // Five fingerprints were stored (not a vacuous pass)…
    expect(bytes.toString("latin1").match(/"(?:observedHash|citedHash)":"sha256:[0-9a-f]{64}"/g)?.length).toBeGreaterThanOrEqual(5);
    // …and no line of the file, not even one token of it.
    for (let i = 1; i <= 12; i++) expect(bytes.includes(`zebra-quartz-${i}`)).toBe(false);
    expect(bytes.includes("marker1 =")).toBe(false);
  });
});

describe("records imported before reads were fingerprinted", () => {
  /** The adapter as it was before #54: the same events, identities and hashes, without the read and output facts. */
  function withoutReadFacts(adapter: TranscriptAdapter): TranscriptAdapter {
    return {
      ...adapter,
      read: (file, from, maxBytes) => {
        const chunk = adapter.read(file, from, maxBytes);
        return {
          ...chunk,
          events: chunk.events.map((event) => {
            const copy = { ...event } as Record<string, unknown>;
            delete copy["read"];
            delete copy["output"];
            return copy as unknown as typeof event;
          }),
        };
      },
    };
  }

  test("R8: they keep unknown and are neither relabelled nor imported again, while a read added later is fingerprinted", () => {
    const repo = repoWith({ "src/gateway.ts": GATEWAY });
    const path = join(repo, "src/gateway.ts");
    const config = claudeConfigDir();
    const home = tempDir();
    const lines = claudeSession({ cwd: repo, sessionId: "5e55a000-0000-4000-8000-000000000008", steps: [claudeReadStep(path, GATEWAY), claudeReadStep(path, GATEWAY, { offset: 10, limit: 5 }), claudeReadStep(path, GATEWAY, { offset: 20, limit: 5 })] }).split(/(?<=\n)/);
    // The prompt and the first two reads, imported by the old adapter.
    const { path: transcript } = installTranscript(config, "", { cwd: repo, sessionId: "5e55a000-0000-4000-8000-000000000008", content: lines.slice(0, 5).join("") });
    const old = openMemory({ cwd: repo, host: "claude-code", home, transcriptAdapter: withoutReadFacts(claudeCodeAdapter({ configDir: config })) });
    expect(old.bootstrap({ importChoice: "current_project" }).import.state).toBe("complete");
    const before = recordsOf(old, "Read");
    expect(before).toHaveLength(2);
    for (const id of before) expect(label(old, id)).toEqual(["unknown", "transcript_reference"]);
    const records = old.status().counts?.records ?? 0;
    old.close();

    // Rewritten (a metadata line now leads, so the importer reads the whole file again) and grown by a third read.
    writeFileSync(transcript, `${JSON.stringify({ type: "ai-title", sessionId: "5e55a000-0000-4000-8000-000000000008", aiTitle: "Gateway retries" })}\n${lines.join("")}`);
    const memory = openMemory({ cwd: repo, host: "claude-code", home, claudeConfigDir: config });
    onCleanup(() => {
      memory.close();
    });
    const status = memory.bootstrap().import;
    expect(status.state).toBe("complete");
    expect(status.currentProject?.counters).toMatchObject({ rewrites: 1, conflicts: 0 });
    expect(memory.status().counts?.records).toBe(records + 1);
    const after = recordsOf(memory, "Read");
    expect(after.slice(0, 2)).toEqual(before);
    for (const id of before) expect(label(memory, id)).toEqual(["unknown", "transcript_reference"]);
    expect(memory.read({ recordId: after[2] ?? "" }).externalRefs[0]).toMatchObject({ lines: [20, 24], freshness: "current" });
  });
});
