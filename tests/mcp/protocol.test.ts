import { spawn, spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import type { CompactPack, RecordResult, StatusResult } from "../../src/memory.js";
import { initRepo, tempDir } from "../helpers.js";
import { CLI, spawnServer } from "./harness.js";

describe("MCP protocol surface", () => {
  test("lists the seven memory tools with strict JSON Schemas and agent instructions", async () => {
    const server = await spawnServer({ cwd: initRepo(), home: tempDir() });
    const { tools } = await server.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "memory_bootstrap",
      "memory_checkpoint",
      "memory_manage",
      "memory_read",
      "memory_recall",
      "memory_record",
      "memory_status",
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.description?.length).toBeGreaterThan(20);
    }
    const record = tools.find((t) => t.name === "memory_record");
    expect(record?.inputSchema.required).toEqual(["kind", "body", "attribution"]);
    // One flat object (a top-level union is not a valid tool schema for every host); fields are checked per action.
    const manage = tools.find((t) => t.name === "memory_manage");
    expect(manage?.inputSchema.required).toEqual(["action"]);
    expect(Object.keys(manage?.inputSchema.properties ?? {})).toEqual(["v", "action", "recordId", "recordIds", "confirmToken", "candidateId", "answer", "body", "reason", "attribution", "operationKey"]);
    expect(server.client.getInstructions()).toMatch(/memory_bootstrap first/);
  });

  test("the checkpoint tool asks for intent, the next concrete step and why, not status words", async () => {
    const server = await spawnServer({ cwd: initRepo(), home: tempDir() });
    const checkpoint = (await server.client.listTools()).tools.find((t) => t.name === "memory_checkpoint");
    expect(checkpoint?.description).toMatch(/next concrete step and why/);
    const fields = checkpoint?.inputSchema.properties as Record<string, { description?: string }>;
    expect(fields["nextSteps"]?.description).toMatch(/next concrete step and why .* not a status/i);
    expect(fields["status"]?.description).toMatch(/what is true now/i);
  });

  test("the instructions fit Claude Code's 2048-character limit and keep every rule", async () => {
    const server = await spawnServer({ cwd: initRepo(), home: tempDir() });
    const instructions = server.client.getInstructions() ?? "";
    // Claude Code truncates server instructions beyond 2048 characters, dropping whatever comes last.
    expect(instructions.length).toBeLessThanOrEqual(2048);
    for (const rule of RULES) expect(instructions).toMatch(rule);
    await server.close();
  });

  test("session-start hook context delivers the same rules", () => {
    const context = sessionStartContext();
    for (const rule of RULES) expect(context).toMatch(rule);
  });

  test("the index → read workflow costs the protocol a line, and session start stays within noise of 0.1.0", async () => {
    const server = await spawnServer({ cwd: initRepo(), home: tempDir() });
    const instructions = server.client.getInstructions() ?? "";
    expect(instructions).toMatch(/mode "compact".*memory_read/s);
    // 0.1.0's protocol was 12 lines; its session start for an empty repository was 2,815 bytes.
    expect(instructions.split("\n").length).toBeLessThanOrEqual(14);
    expect(Buffer.byteLength(sessionStartContext(), "utf8")).toBeLessThanOrEqual(2_850);
    await server.close();
  });

  test("memory_recall takes mode compact and returns one line per hit", async () => {
    const server = await spawnServer({ cwd: initRepo(), home: tempDir() });
    const recall = (await server.client.listTools()).tools.find((t) => t.name === "memory_recall");
    expect((recall?.inputSchema.properties as Record<string, { enum?: string[] }>)["mode"]?.enum).toEqual(["full", "compact"]);
    await server.ok("memory_bootstrap");
    const { recordId, createdAt } = await server.ok<RecordResult>("memory_record", { kind: "decision", body: "Retry failed jobs\nwith backoff.", attribution: "user_direction" });
    const pack = await server.ok<CompactPack>("memory_recall", { query: "retry", mode: "compact" });
    expect(pack.items).toEqual([`${recordId} [${createdAt.slice(0, 10)} · decision · user_direction · debrief-test · unknown] Retry failed jobs with backoff.`]);
    expect(pack.budget.usedBytes).toBe(Buffer.byteLength(JSON.stringify(pack), "utf8"));
    expect((await server.call("memory_recall", { mode: "brief" })).structured).toMatchObject({ error: { code: "invalid_input" } });
  });

  test("a payload carrying workspaceId or cwd is an invalid_input envelope", async () => {
    const server = await spawnServer({ cwd: initRepo(), home: tempDir() });
    await server.ok("memory_bootstrap");
    for (const [tool, args] of [
      ["memory_record", { kind: "note", body: "x", attribution: "agent_inference", workspaceId: "ws_0000000000000000" }],
      ["memory_recall", { cwd: "/" }],
      ["memory_bootstrap", { workstreamId: "wst_1" }],
    ] as const) {
      const outcome = await server.call(tool, args);
      expect(outcome.isError).toBe(true);
      expect(outcome.structured).toMatchObject({ error: { code: "invalid_input", retryable: false } });
      expect(JSON.parse(outcome.text)).toEqual(outcome.structured);
    }
    expect((await server.ok<StatusResult>("memory_status")).counts?.records).toBe(0);
  });

  test("replaying an operationKey through MCP returns the stored result", async () => {
    const server = await spawnServer({ cwd: initRepo(), home: tempDir() });
    const input = { kind: "note", body: "replay me", attribution: "agent_inference", operationKey: "mcp-op-1" };
    const first = await server.ok<RecordResult>("memory_record", input);
    const again = await server.ok<RecordResult>("memory_record", input);
    expect(again).toEqual({ ...first, replayed: true });
    const conflict = await server.call("memory_record", { ...input, body: "different" });
    expect(conflict.structured).toMatchObject({ error: { code: "idempotency_conflict" } });
  });

  test("an operationKey replays across a real server restart", async () => {
    const repo = initRepo();
    const home = tempDir();
    const input = { kind: "evidence", body: "survives restart", attribution: "direct_observation", operationKey: "restart-op" };
    const first = await spawnServer({ cwd: repo, home, host: "claude-code" });
    const original = await first.ok<RecordResult>("memory_record", input);
    process.kill(first.pid, "SIGKILL");

    const second = await spawnServer({ cwd: repo, home, host: "codex" });
    expect(await second.ok<RecordResult>("memory_record", input)).toEqual({ ...original, replayed: true });
    expect((await second.ok<StatusResult>("memory_status")).counts?.records).toBe(1);
    expect((await second.call("memory_record", { ...input, body: "changed" })).structured).toMatchObject({ error: { code: "idempotency_conflict" } });
  });

  test("host comes from --host, else the MCP client name", async () => {
    const repo = initRepo();
    const home = tempDir();
    const flagged = await spawnServer({ cwd: repo, home, host: "codex", clientName: "something-else" });
    expect((await flagged.ok<StatusResult>("memory_status")).scope?.host).toBe("codex");
    const unflagged = await spawnServer({ cwd: repo, home, clientName: "claude-code" });
    expect((await unflagged.ok<StatusResult>("memory_status")).scope?.host).toBe("claude-code");
  });

  test("outside a Git repository tools fail closed with scope_unresolved", async () => {
    const server = await spawnServer({ cwd: tempDir("debrief-plain-"), home: tempDir() });
    expect((await server.call("memory_bootstrap")).structured).toMatchObject({ error: { code: "scope_unresolved" } });
    expect((await server.ok<StatusResult>("memory_status")).problem?.code).toBe("scope_unresolved");
  });

  test("stdout carries only JSON-RPC, logs go to stderr, and the process exits cleanly when stdin ends", async () => {
    const child = spawn(process.execPath, [CLI, "mcp", "--host", "pi"], {
      cwd: initRepo(),
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", DEBRIEF_HOME: tempDir() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));

    const send = (message: object): void => {
      child.stdin.write(JSON.stringify(message) + "\n");
    };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_bootstrap", arguments: {} } });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_record", arguments: { kind: "note" } } });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "no_such_tool", arguments: {} } });
    for (let i = 0; i < 400 && stdout.split("\n").filter(Boolean).length < 4; i++) await new Promise((r) => setTimeout(r, 25));
    child.stdin.end();

    expect(await exited).toBe(0);
    const lines = stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(4);
    const messages = lines.map((line) => JSON.parse(line) as { jsonrpc: string; id: number; result?: { isError?: boolean }; error?: unknown });
    for (const message of messages) expect(message.jsonrpc).toBe("2.0");
    expect(messages.find((m) => m.id === 2)?.result?.isError).toBeUndefined();
    expect(messages.find((m) => m.id === 3)?.result?.isError).toBe(true);
    expect(messages.find((m) => m.id === 4)?.error).toBeDefined();
    expect(stderr).toMatch(/debrief: MCP server ready/);
  });

  test("malformed and oversized requests get error replies, store nothing, and the server keeps answering", async () => {
    const child = spawn(process.execPath, [CLI, "mcp", "--host", "claude-code"], {
      cwd: initRepo(),
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", DEBRIEF_HOME: tempDir(), CLAUDE_CONFIG_DIR: tempDir(), CODEX_HOME: tempDir() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const replies = new Map<number | null, Reply>();
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    let buffered = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        const reply = JSON.parse(line) as Reply;
        replies.set(reply.id ?? null, reply);
      }
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const reply = async (id: number): Promise<Reply> => {
      for (let i = 0; i < 400 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 25));
      const found = replies.get(id);
      if (found === undefined) throw new Error(`no reply to request ${id}`);
      return found;
    };
    const send = (message: object | string): void => {
      child.stdin.write((typeof message === "string" ? message : JSON.stringify(message)) + "\n");
    };
    const call = (id: number, name: string, args: unknown): void => {
      send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    };
    const record = (body: unknown) => ({ kind: "note", body, attribution: "agent_inference" });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await reply(1);
    call(2, "memory_bootstrap", {});
    await reply(2);

    send("this is not JSON {");
    send({ not: "json-rpc" });
    send({ jsonrpc: "2.0", id: 3, method: "no/such/method" });
    call(4, "memory_record", "arguments that are not an object");
    call(5, "memory_record", record(42));
    call(6, "memory_record", { ...record("typed wrong"), kind: "anything", attribution: ["user_direction"] });
    call(7, "memory_record", record("x".repeat(16 * 1024 + 1)));
    call(8, "memory_record", record("y".repeat(4 * 1024 * 1024)));
    call(9, "memory_record", record("the server still records after all of that"));
    call(10, "memory_recall", { maxTokens: 8_000 });

    // Lines that are not JSON-RPC requests get no reply (the SDK drops them); what matters is what follows.
    expect((await reply(3)).error?.code).toBe(-32601);
    // Arguments that are not an object never reach Debrief: the SDK rejects the request itself.
    expect((await reply(4)).error?.message).toMatch(/arguments/);
    for (const id of [5, 6, 7, 8]) {
      const rejected = await reply(id);
      expect(rejected.result?.isError, `request ${id}`).toBe(true);
      expect(rejected.result?.structuredContent?.error?.code, `request ${id}`).toBe("invalid_input");
    }
    expect((await reply(9)).result?.isError).toBeUndefined();
    const recalled = (await reply(10)).result?.structuredContent as { items: { excerpt: string }[] };
    expect(recalled.items.map((item) => item.excerpt)).toEqual(["the server still records after all of that"]);

    // The server's log (stderr) names what was wrong, never the content it was sent.
    for (const content of ["typed wrong", "x".repeat(64), "y".repeat(64), "not JSON"]) expect(stderr).not.toContain(content);

    child.stdin.end();
    expect(await exited).toBe(0);
  });
});

/** What Claude Code's session-start hook injects for an empty repository. */
function sessionStartContext(): string {
  const run = spawnSync(process.execPath, [CLI, "hook", "session-start", "--host", "claude-code"], {
    cwd: initRepo(),
    input: JSON.stringify({ session_id: "5e550000-0000-4000-8000-0000000000a9", hook_event_name: "SessionStart", source: "startup" }),
    encoding: "utf8",
    env: { ...process.env, DEBRIEF_HOME: tempDir(), CLAUDE_CONFIG_DIR: tempDir() },
  });
  expect(run.status).toBe(0);
  return (JSON.parse(run.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

interface Reply {
  id?: number | null;
  error?: { code: number; message: string };
  result?: { isError?: boolean; structuredContent?: { error?: { code: string } } & Record<string, unknown> };
}

/** Every rule of the protocol, checked on both paths it is delivered by. */
const RULES = [
  /memory_bootstrap first/,
  /scope\.ambiguity\.question, wait, then/,
  /import\.question verbatim, wait, then/,
  /historical observations/i,
  /stale.*unknown.*read the current file/is,
  /independentRoots/,
  /attribution/,
  /memory_manage/,
  /Preferences are defaults; the current request wins/,
  /lasting language or a repeated correction/,
  /never re-record/i,
  /memory_checkpoint.*expectedRevision/s,
  /checkpoint_conflict.*never overwrite/is,
  /honest miss/i,
  /mode "compact".*memory_read/s,
];
