import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { onCleanup } from "../helpers.js";

/**
 * A localhost stand-in for TypeSafe's API (`POST /v1/systemone`, `GET /v1/models`), in the shape
 * docs.typesafe.ai/api documents, as the host tests stub the model API (tests/mcp/claude.ts). It
 * logs every request, and answers each question of a systemone call from `answer`, which a test
 * can replace: a status other than 200, a delay, or a different verdict.
 */

export interface StubRequest {
  method: string;
  path: string;
  /** The bearer token the request carried, or null. */
  key: string | null;
  /** The parsed JSON body (null for none). */
  body: unknown;
  /** The body as sent, for "never in the request" checks. */
  raw: string;
}

export interface StubReply {
  status?: number;
  headers?: Record<string, string>;
  /** Waits this long before answering (past the client's timeout, to test it). */
  delayMs?: number;
  /** The JSON body; defaults to a verdict for every question asked. */
  json?: unknown;
}

export interface JevStub {
  /** `http://127.0.0.1:<port>`: what `DEBRIEF_JEV_ENDPOINT` names. */
  url: string;
  /** `127.0.0.1:<port>`: the no-network guard's allowlist entry for it. */
  hostPort: string;
  requests: StubRequest[];
  /** The systemone calls only. */
  judgments(): StubRequest[];
  /** How the next systemone calls are answered. */
  answer: (body: SystemOneBody) => StubReply;
  /** Resolves once `n` systemone calls have been answered (or rejects after `timeoutMs`). */
  waitForJudgments(n: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export interface SystemOneBody {
  model: string;
  state: unknown;
  questions: Record<string, { type: string }>;
}

export const STUB_USAGE = { input_tokens: 1000, output_tokens: 20 };

/** An answer per question: `still_holds` with probability `p` (or `invalidated` when `verdict` says so). */
export function verdictReply(body: SystemOneBody, verdict: "still_holds" | "invalidated" = "still_holds", p = 0.95): StubReply {
  const other = verdict === "still_holds" ? "invalidated" : "still_holds";
  const answers = Object.fromEntries(
    Object.keys(body.questions).map((name) => [
      name,
      { type: "choice", choice: verdict, confidence: 2 * p - 1, probabilities: { [verdict]: p, [other]: Number((1 - p).toFixed(6)) } },
    ]),
  );
  return { json: { model: "jev-1.13.0", answers, usage: STUB_USAGE } };
}

export async function startJevStub(): Promise<JevStub> {
  const requests: StubRequest[] = [];
  let answered = 0;
  const waiters: { n: number; resolve: () => void }[] = [];
  const stub: Partial<JevStub> = { requests, answer: (body) => verdictReply(body) };

  const reply = (res: ServerResponse, { status = 200, headers = {}, json }: StubReply): void => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(json === undefined ? "" : JSON.stringify(json));
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      let body: unknown;
      try {
        body = raw === "" ? null : JSON.parse(raw);
      } catch {
        body = null;
      }
      const auth = req.headers.authorization ?? null;
      const request: StubRequest = { method: req.method ?? "", path: req.url ?? "", key: auth?.startsWith("Bearer ") === true ? auth.slice(7) : null, body, raw };
      requests.push(request);
      if (request.method === "GET" && request.path === "/v1/models") {
        reply(res, { json: { models: [{ name: "jev-latest", description: "stub", release_date: "2026-09-15" }] } });
        return;
      }
      if (request.method !== "POST" || request.path !== "/v1/systemone") {
        reply(res, { status: 404, json: { error: "not found" } });
        return;
      }
      const planned = (stub.answer ?? ((b: SystemOneBody) => verdictReply(b)))(body as SystemOneBody);
      const send = (): void => {
        if (!res.destroyed) reply(res, planned);
        answered++;
        for (const waiter of waiters.filter((w) => answered >= w.n)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      };
      if (planned.delayMs === undefined) send();
      else setTimeout(send, planned.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub did not bind");
  const hostPort = `127.0.0.1:${address.port}`;
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  Object.assign(stub, {
    url: `http://${hostPort}`,
    hostPort,
    judgments: () => requests.filter((r) => r.method === "POST" && r.path === "/v1/systemone"),
    waitForJudgments: (n: number, timeoutMs = 10_000) =>
      new Promise<void>((resolve, reject) => {
        if (answered >= n) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error(`the Jev stub answered ${answered} of ${n} judgments within ${timeoutMs} ms`));
        }, timeoutMs);
        waiters.push({
          n,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      }),
    close,
  });
  onCleanup(() => {
    void close();
  });
  return stub as JevStub;
}
