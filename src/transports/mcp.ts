// The low-level `Server` is used on purpose: `McpServer` validates tool input itself
// and answers failures with its own error text, which would bypass the memory module's
// `invalid_input` envelope. Here the module is the only validator.
/* eslint-disable @typescript-eslint/no-deprecated */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { sessionOfCall, sessionOfServer } from "../bootstrap/host-sessions.js";
import { resolveHome } from "../bootstrap/workspace-resolution.js";
import { DebriefError } from "../errors.js";
import type { HostReply, Memory, PreferenceQuestion } from "../memory.js";
import { openMemory } from "../memory.js";
import { OPERATION_SCHEMAS, type OperationName } from "../schemas.js";
import { PROTOCOL } from "../protocol.js";

/**
 * Thin MCP adapter over the memory module. It holds no memory policy: it forwards raw
 * tool arguments to the module (which parses them with its own schemas), returns results
 * as structuredContent plus the same JSON as text, and maps `DebriefError` to an
 * `isError: true` envelope `{ error: { code, message, retryable, details } }`.
 */

interface ToolSpec {
  description: string;
  run: (memory: Memory, args: unknown) => object;
}

// One entry per operation in OPERATION_SCHEMAS (the compiler enforces completeness).
// Arguments are passed through untyped: the module's own `parse` is the only validation.
const TOOLS: Record<OperationName, ToolSpec> = {
  memory_bootstrap: {
    description:
      "Call first in every session. Resolves this repository's workspace (never from arguments) and workstream (from the worktree, this session, and an explicit task; a branch only suggests), reconciles approved local transcripts, and returns the head checkpoint plus recent memory, or an honest empty result. On first use it returns import.question: ask the user and call again with importChoice. If scope.ambiguity is set, ask the user scope.ambiguity.question and call again with workstream = the chosen id or \"new\"; until then only workspace-level memory is shown, and workstream writes fail with scope_ambiguous. Mention import gaps (unsupported versions, quarantined sessions) when they matter. Verify live repository state before changing code.",
    run: (memory, args) => memory.bootstrap(args as never),
  },
  memory_recall: {
    description:
      "Return a bounded, cited context pack: the head checkpoint first, then eligible records ranked for the query. Respects maxTokens/maxBytes (bodies are cut first, never warnings or citations); follow `continuation` for more. Items carry recordIds, citations, attribution, host/session/source provenance, live freshness per reference with a warning (stale/unknown: read the current file; remote refs: verify with your own tools), and corroboration counted by independent roots, with copies (branched transcripts, derived or cited restatements) collapsed under copies. Debrief never returns file content. While scope.ambiguity is set, only workspace-level memory is returned. mode \"compact\" returns the same sequence as one line per entry (id, date, kind, attribution, host, freshness, a short excerpt), several times as many per budget: survey with it, then memory_read the few that matter (around: N for what came just before and after). A continuation works in either mode.",
    run: (memory, args) => memory.recall(args as never),
  },
  memory_read: {
    description:
      "Expand one record by recordId within a byte/token budget; continue with nextOffset. around: N (1–10) adds up to N records of its session before and after it, as index lines in time order: what led to it and what followed. Freshness of its references is checked live, as in recall. Other workstreams' records and records that are no longer current (corrected, retracted, superseded, or resting on one) are refused; the error names the replacement.",
    run: (memory, args) => memory.read(args as never),
  },
  memory_record: {
    description:
      "Store one attributed piece of working knowledge (evidence, decision, attempt, constraint, question, next_step, note, reference). kind preference is different: it stores nothing until the user confirms, and Debrief asks them directly (Everywhere / This repo only / No). Propose one only for lasting language (\"always\", \"never\", \"remember\", \"from now on\", \"I prefer\") or a correction the user repeats, never for a one-off instruction; raise all candidates together at the end of the turn, never mid-task. If preference.state comes back pending with preference.relay allowed, ask the user preference.question in chat and relay their exact answer with memory_manage answer_preference; with relay refused they dismissed it, so do not ask again now. Store knowledge about artifacts and point to them with externalRefs; never paste whole files. For code as it is on disk, give only kind/locator/path(/lines): Debrief fingerprints the file itself so later sessions can tell whether it changed; with lines, it also fingerprints their text, so edits elsewhere in the file leave the memory current. Cite evidence with supportedBy. Use operationKey to make retries safe. Do not re-record recalled memory. Fails with scope_ambiguous while no workstream is chosen, unless workspaceLevel is true.",
    run: (memory, args) => memory.record(args as never),
  },
  memory_checkpoint: {
    description:
      "Publish the workstream's continuation state (goal, status, decisions, failed attempts, open questions, next steps) before finishing. Write it as intent for whoever continues: each next step is the next concrete step and why (\"add the Windows branch; its test already fails\"), never a status word like \"in progress\". Compare-and-swap: pass expectedRevision = the headRevision you last read; a checkpoint_conflict means someone else published first, so recall and reconcile. Fails with scope_ambiguous while no workstream is chosen.",
    run: (memory, args) => memory.checkpoint(args as never),
  },
  memory_manage: {
    description:
      "Inspect or change what Debrief remembers when the user asks (\"what do you remember about X\", \"that is wrong\", \"that changed\"). inspect: a record's state, history, evidence, and what was derived from it, even if it is no longer current. correct: the claim was wrong; body = the corrected claim (never the old one), reason = why. supersede: it was right but is outdated; body = the new version. retract: wrong, no replacement. restore: undo a retraction. forget_preview (recordIds) shows what forgetting would remove and changes nothing; show it to the user, and only after they explicitly confirm call forget with its confirmToken (it cannot be undone). Each change also takes restatements, conclusions resting on the claim, and checkpoints repeating it out of recall at once, and blocks re-import of the same transcript event. Use attribution user_direction only when the user asked for the change. Tell the user what changed (affected). When the user says not to remember this session, call private_session: it forgets what this session stored and refuses later writes (session_private); confirm to the user in one line.",
    run: (memory, args) => memory.manage(args as never),
  },
  memory_status: {
    description:
      "Report Debrief health: embedded SQLite/FTS5 runtime, schema version, database paths, resolved scope, counts, capabilities, transcript-import consent, progress and capture gaps, and whether this host lets Debrief ask the user a question directly (client.elicitation).",
    run: (memory, args) => memory.status(args as never),
  },
};

const TOOL_LIST = (Object.keys(OPERATION_SCHEMAS) as OperationName[]).map((name) => {
  const inputSchema = z.toJSONSchema(OPERATION_SCHEMAS[name], { io: "input" }) as { type: "object"; [key: string]: unknown };
  delete inputSchema["$schema"];
  return { name, description: TOOLS[name].description, inputSchema };
});

const isOperation = (name: string): name is OperationName => Object.hasOwn(OPERATION_SCHEMAS, name);

/** One background import step, and the pause between steps that lets requests through. */
const BACKFILL_STEP_MS = 200;
const BACKFILL_PAUSE_MS = 25;
/** Consecutive failed steps retried (after 2 s, 4 s, … 32 s) before waiting for the next bootstrap. */
const BACKFILL_RETRIES = 5;

/** Jev judgments (see src/judge/still-true.ts): calls per step, and the pause before a step that lets requests through. */
const JUDGE_STEP_CALLS = 2;
const JUDGE_DELAY_MS = 50;

/** How long a preference question waits for the user before it stays pending (decided with the user, #21). */
const DEFAULT_ELICITATION_TIMEOUT_MS = 60_000;
/** The SDK's error when a request (here: the question to the user) gets no answer in time. */
const REQUEST_TIMEOUT: number = ErrorCode.RequestTimeout;

export interface McpServerOptions {
  /** Bound on waiting for the user's answer to a preference question; defaults to `$DEBRIEF_ELICITATION_TIMEOUT_MS`, then 60 s. */
  elicitationTimeoutMs?: number;
  cwd: string;
  /** From `--host`; falls back to the MCP client's name, then "unknown". */
  host?: string;
  home?: string;
  /** Where the host's session id may be read (`sessionEnv` in src/hosts.ts); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

/**
 * Builds the server. The Memory opens lazily on the first tool call, after the
 * initialize handshake, so the client's name is known when no `--host` was given.
 */
export function createMcpServer(options: McpServerOptions): { server: Server; close: () => void } {
  const log = options.log ?? ((message: string) => process.stderr.write(`debrief: ${message}\n`));
  const home = resolveHome(options.home);
  const server = new Server({ name: "debrief", version: "0.1.0" }, { capabilities: { tools: {} }, instructions: PROTOCOL });
  let memory: Memory | undefined;
  let memorySession: string | undefined;
  // The Memory opens on the first call, so a session the call names is known before bootstrap
  // binds the session; without one, the session the host started the server with. A call from
  // another host session (Claude Code after `/clear`) closes it and opens a Memory for that
  // session; a call naming no session keeps the current one.
  const getMemory = (meta: Record<string, unknown> | undefined): Memory => {
    const host = options.host ?? server.getClientVersion()?.name ?? "unknown";
    const named = sessionOfCall(host, meta, home);
    if (memory !== undefined && named !== undefined && named !== memorySession) {
      if (backfill !== undefined) clearTimeout(backfill);
      backfill = undefined;
      clearTimeout(judging);
      judging = undefined;
      memory.close();
      memory = undefined;
    }
    if (memory === undefined) {
      memorySession = named ?? sessionOfServer(host, options.env ?? process.env);
      memory = openMemory({
        cwd: options.cwd,
        host,
        ...(options.home === undefined ? {} : { home: options.home }),
        ...(memorySession === undefined ? {} : { hostSessionId: memorySession }),
      });
    }
    return memory;
  };

  // Approved history beyond what bootstrap imported continues here, a bounded step at a time
  // between requests (SQLite calls are synchronous, so each step briefly holds the event loop).
  // A failed step (e.g. storage_busy) is retried with backoff; a bug stops the loop until the next bootstrap.
  let backfill: NodeJS.Timeout | undefined;
  let failures = 0;
  const scheduleBackfill = (delayMs: number): void => {
    if (backfill !== undefined || memory === undefined) return;
    backfill = setTimeout(() => {
      backfill = undefined;
      if (memory === undefined) return;
      try {
        const step = memory.continueImport({ maxMs: BACKFILL_STEP_MS });
        if (step.problem === null) {
          failures = 0;
          if (!step.done) scheduleBackfill(BACKFILL_PAUSE_MS);
        } else if (++failures <= BACKFILL_RETRIES) {
          scheduleBackfill(BACKFILL_PAUSE_MS * 40 * 2 ** failures);
        } else {
          log(`transcript import paused until the next bootstrap: ${step.problem.code}: ${step.problem.message}`);
        }
      } catch (error) {
        log(`transcript import stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      }
    }, delayMs);
    backfill.unref();
  };

  // Jev judgments the last requests queued run here, a few calls a step, between requests: the
  // calls are asynchronous, so a request arriving meanwhile is served at once, and recall never
  // waits for a verdict. A step that finds judging paused (a failure) ends the loop until the next request.
  let judging: NodeJS.Timeout | undefined;
  let judgingNow = false;
  const scheduleJudging = (): void => {
    if (judging !== undefined || judgingNow || memory === undefined) return;
    const current = memory;
    judging = setTimeout(() => {
      judging = undefined;
      if (current !== memory) return;
      judgingNow = true;
      current.judge({ maxCalls: JUDGE_STEP_CALLS }).then(
        (step) => {
          judgingNow = false;
          if (step.pending > 0 && !step.paused) scheduleJudging();
        },
        (error: unknown) => {
          judgingNow = false;
          log(`Jev judgments stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        },
      );
    }, JUDGE_DELAY_MS);
    judging.unref();
  };

  const elicitationTimeoutMs = options.elicitationTimeoutMs ?? (Number(process.env["DEBRIEF_ELICITATION_TIMEOUT_MS"]) || DEFAULT_ELICITATION_TIMEOUT_MS);
  /**
   * Puts preference questions to the user through one MCP elicitation form (one field per
   * question, one bounded wait for all of them) and passes back what the host did, question by
   * question. It holds no policy: the memory module decides what a reply means. Questions the user
   * already dismissed this session (`relay: refused`) are not asked again.
   */
  const ask = async (memory: Memory, questions: readonly PreferenceQuestion[]): Promise<PreferenceQuestion[]> => {
    const open = questions.filter((q): q is PreferenceQuestion & { candidateId: string } => q.candidateId !== null && q.state === "pending" && q.relay === "allowed");
    if (open.length === 0) return [...questions];
    const settle = (question: PreferenceQuestion & { candidateId: string }, reply: HostReply): PreferenceQuestion => {
      // One line per question, so what the host did with it is on record.
      if (reply.action !== "asking") log(`preference question ${question.candidateId}: ${reply.action}`);
      try {
        return memory.settlePreference({ candidateId: question.candidateId, reply });
      } catch (error) {
        // Settled meanwhile by another call (the answer stands there): report the question as it was.
        if (error instanceof DebriefError) return question;
        throw error;
      }
    };
    const replies = new Map<string, HostReply>();
    if (server.getClientCapabilities()?.elicitation?.form === undefined) {
      for (const question of open) replies.set(question.candidateId, { action: "unavailable" });
    } else {
      // While the user is being asked, the agent cannot answer in their place.
      for (const question of open) settle(question, { action: "asking" });
      const field = (index: number): string => (open.length === 1 ? "answer" : `answer_${index + 1}`);
      try {
        const reply = await server.elicitInput(
          {
            mode: "form",
            message: open.length === 1 ? (open[0]?.question ?? "") : `Debrief has ${open.length} preference questions. Answer the ones you want to.`,
            requestedSchema: {
              type: "object",
              properties: Object.fromEntries(
                open.map((question, index) => [field(index), { type: "string", title: open.length === 1 ? "Your answer" : question.question, enum: question.choices.map((choice) => choice.label) }]),
              ),
              ...(open.length === 1 ? { required: ["answer"] } : {}),
            },
          },
          { timeout: elicitationTimeoutMs },
        );
        open.forEach((question, index) => {
          const label = reply.content?.[field(index)];
          replies.set(
            question.candidateId,
            reply.action === "accept" && typeof label === "string" ? { action: "accept", label } : reply.action === "accept" ? { action: "cancel" } : { action: reply.action },
          );
        });
      } catch (error) {
        const reply: HostReply = error instanceof McpError && error.code === REQUEST_TIMEOUT ? { action: "timeout" } : { action: "unavailable" };
        for (const question of open) replies.set(question.candidateId, reply);
      }
    }
    return questions.map((question) => {
      const reply = question.candidateId === null ? undefined : replies.get(question.candidateId);
      return reply === undefined || question.candidateId === null ? question : settle({ ...question, candidateId: question.candidateId }, reply);
    });
  };

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOL_LIST }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    if (!isOperation(name)) throw new McpError(ErrorCode.InvalidParams, `Unknown tool ${name}`);
    const spec = TOOLS[name];
    try {
      const memory = getMemory(request.params._meta);
      const result = spec.run(memory, request.params.arguments ?? {}) as Record<string, unknown>;
      if (name === "memory_bootstrap" && (result["import"] as { state?: unknown } | undefined)?.state === "in_progress") {
        failures = 0;
        scheduleBackfill(BACKFILL_PAUSE_MS);
      }
      if (name === "memory_status") {
        // What only the transport knows: whether this host can be asked a question directly.
        const elicitation = server.getClientCapabilities()?.elicitation;
        result["client"] = {
          name: server.getClientVersion()?.name ?? null,
          version: server.getClientVersion()?.version ?? null,
          elicitation: { form: elicitation?.form !== undefined, url: elicitation?.url !== undefined },
        };
      }
      // Preference questions go to the user now, not through the agent.
      if ((name === "memory_record" && result["kind"] === "preference") || (name === "memory_manage" && result["action"] === "proposal")) {
        result["preference"] = (await ask(memory, [result["preference"] as PreferenceQuestion]))[0];
      } else if (name === "memory_bootstrap") {
        const preferences = result["preferences"] as { pending: PreferenceQuestion[] };
        preferences.pending = await ask(memory, preferences.pending);
      }
      scheduleJudging();
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      if (!(error instanceof DebriefError)) {
        log(`internal error in ${request.params.name}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        throw new McpError(ErrorCode.InternalError, "Debrief hit an internal error; the outcome is unknown, so recall before retrying a write.");
      }
      const envelope = error.toEnvelope();
      return { isError: true, content: [{ type: "text", text: JSON.stringify(envelope) }], structuredContent: { ...envelope } };
    }
  });

  return {
    server,
    close: () => {
      clearTimeout(backfill);
      backfill = undefined;
      clearTimeout(judging);
      judging = undefined;
      memory?.close();
      memory = undefined;
    },
  };
}

/**
 * Serves MCP over stdio until stdin ends or SIGTERM/SIGINT arrives, then closes the
 * database. Stdout carries only JSON-RPC; everything else (including stray console
 * output) goes to stderr.
 */
export async function runStdioServer(options: McpServerOptions): Promise<void> {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(args.map(String).join(" ") + "\n");
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;

  const { server, close } = createMcpServer(options);
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    close();
    void server.close().finally(() => process.exit(0));
  };
  process.stdin.on("end", stop);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`debrief: MCP server ready (cwd ${options.cwd})\n`);
}
