import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";

function open(): Memory {
  const memory = openMemory({ cwd: initRepo(), home: tempDir(), host: "claude-code" });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

describe("approveTool: Memchor's read-only calls skip the host's permission prompt; writes still ask", () => {
  const allowed: [tool: string, input: object][] = [
    ["mcp__memchor__memory_bootstrap", {}],
    ["mcp__memchor__memory_bootstrap", { task: "#42", workstream: "new" }],
    ["mcp__memchor__memory_read", { recordId: "rec_0123456789abcdef0123456789abcdef" }],
    ["mcp__memchor__memory_status", {}],
    ["mcp__memchor__memory_manage", { action: "inspect", recordId: "rec_0123456789abcdef0123456789abcdef" }],
    ["mcp__plugin_memchor_memchor__memory_read", { recordId: "rec_0123456789abcdef0123456789abcdef" }],
  ];
  const asks: [tool: string, input: object][] = [
    ["mcp__memchor__memory_record", { kind: "note", body: "x", attribution: "agent_inference" }],
    ["mcp__memchor__memory_checkpoint", { expectedRevision: 0, goal: "g", status: "s" }],
    ["mcp__memchor__memory_manage", { action: "forget", recordIds: [], confirmToken: "t" }],
    ["mcp__memchor__memory_manage", { action: "private_session" }],
    // The user's transcript-consent answer stays behind the host's own prompt.
    ["mcp__memchor__memory_bootstrap", { importChoice: "all" }],
    // Another server's tool of the same name is not Memchor's.
    ["mcp__other__memory_read", { recordId: "rec_0123456789abcdef0123456789abcdef" }],
    ["mcp__memchor_evil__memory_read", {}],
    ["Bash", { command: "ls" }],
  ];

  test.each(allowed)("allows %s %j", (tool, input) => {
    expect(open().approveTool({ tool, input })).toEqual({ notice: null });
  });

  test.each(asks)("leaves %s %j to the host", (tool, input) => {
    expect(open().approveTool({ tool, input })).toBeNull();
  });

  test("a recall is allowed and tells the user what is being recalled, on one line", () => {
    const memory = open();
    expect(memory.approveTool({ tool: "mcp__memchor__memory_recall", input: { query: "retry\npolicy" } })).toEqual({ notice: "◪ memchor · recalling: retry policy" });
    expect(memory.approveTool({ tool: "mcp__memchor__memory_recall", input: {} })).toEqual({ notice: "◪ memchor · recalling recent memory" });
  });
});
