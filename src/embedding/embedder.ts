import { existsSync } from "node:fs";
import { join } from "node:path";
import { MessageChannel, type MessagePort, receiveMessageOnPort, Worker } from "node:worker_threads";
import { EMBEDDER_ENTRY, MODEL } from "./model.js";

/**
 * The embedder seam (ADR 0001). The memory module asks it for vectors and never learns how they
 * are made; transports and adapters never see vectors. Only `debrief mcp` (and `debrief status`,
 * to check the model loads) creates one: hooks never load the model.
 *
 * The model runs in a separate process (`dist/embedder.mjs`, src/embedding/process.ts), started on
 * the first request and killed after {@link IDLE_UNLOAD_MS} without one. WebAssembly memory never
 * shrinks, and neither releasing the ONNX session nor terminating a worker thread gave the memory
 * back (measured: a server stayed 150–270 MB above its pre-load size after `worker.terminate()`);
 * a process that exits does. A small proxy thread in the server owns that process, so a recall,
 * which is synchronous, can wait for its query vector (`Atomics.wait`), while the background fill
 * waits asynchronously and never holds the event loop.
 */

export type EmbedKind = "query" | "document";

/** A unit vector quantized to int8: `values[i] * scale` is the float value. */
export interface Vector {
  values: Int8Array;
  scale: number;
}

export interface EmbedderStatus {
  modelId: string;
  /**
   * `unloaded`: not running (not needed yet, or unloaded after idling); `loading`; `loaded`;
   * `failed`: the last load or request failed (`problem`), and meaning search is unavailable until
   * a later attempt succeeds.
   */
  state: "unloaded" | "loading" | "loaded" | "failed";
  problem: string | null;
}

export interface Embedder {
  readonly modelId: string;
  readonly dimensions: number;
  /** Blocks until the vectors are back (the first call also waits for the model to load). Throws {@link EmbedderUnavailable}. */
  embed(texts: readonly string[], kind: EmbedKind): Vector[];
  /** The same, without blocking the caller's thread. Rejects with {@link EmbedderUnavailable}. */
  embedAsync(texts: readonly string[], kind: EmbedKind): Promise<Vector[]>;
  status(): EmbedderStatus;
  /** Stops the model's process now; the next request starts it again. */
  unload(): void;
  /** Unloads and refuses every later request. */
  close(): void;
}

/** Why meaning search cannot run now: no model, a model that fails to load, a crashed or stuck process. */
export class EmbedderUnavailable extends Error {}

/** Idle time after which the model's process is stopped (#51: about 0 extra memory when idle). */
export const IDLE_UNLOAD_MS = 120_000;
/** How long a recall waits for its query vector, the model's load included, before answering by keywords. */
const WAIT_MS = 30_000;
/** A failed load is not retried on every recall: the next attempt comes this much later. */
const RETRY_AFTER_MS = 60_000;
/**
 * V8 flags for the model's process. Liftoff-only skips V8's optimizing tier for WebAssembly, which
 * on ONNX Runtime's 14 MB module costs about 400 MB of compile memory for twice the speed
 * (measured: 300 MB resident and 28 chunks/s with it, 700 MB and 62 chunks/s without). A 1 MB
 * semi-space keeps the young generation from growing to 16 MB (−20 MB, no speed cost), and
 * `--expose-gc` lets the process collect the model's bytes once the session holds them. Neither
 * changes a vector (#51's RSS spike, ADR 0001).
 */
const V8_FLAGS = ["--liftoff-only", "--max-semi-space-size=1", "--expose-gc"];
/**
 * The model's process's environment beyond this one's. macOS's malloc keeps freed pages dirty and
 * counted; `MallocSpaceEfficient` makes it give them back, about −75 MB once the load's garbage is
 * freed. It is read at process start, so it goes in the fork's environment.
 */
const ENV: Record<string, string> = process.platform === "darwin" ? { MallocSpaceEfficient: "1" } : {};

export interface EmbedderOptions {
  /** The directory holding `embedder.mjs`, the runtime's `.wasm` and `models/` (the bundle's own directory). */
  dir: string;
  /** Defaults to {@link IDLE_UNLOAD_MS}; tests shorten it. */
  idleMs?: number;
  /** Node options for the model's process, after {@link V8_FLAGS}. Defaults to this process's own (a preloaded `--import` travels). */
  execArgv?: readonly string[];
}

export function openEmbedder(options: EmbedderOptions): Embedder {
  return new ProcessEmbedder(options);
}

/**
 * The proxy thread. It starts the model's process, queues requests (a recall's before the fill's),
 * sends one at a time, and passes each answer back on the port it came from: the synchronous port
 * also bumps a shared counter, which is what the waiting thread sleeps on.
 */
const PROXY_SOURCE = `
const { workerData } = require("node:worker_threads");
const { fork } = require("node:child_process");
const { sync, async: background, signal, entry, dir, execArgv, env } = workerData;
const counter = new Int32Array(signal);
const wake = () => { Atomics.add(counter, 0, 1); Atomics.notify(counter, 0); };
const reply = (port, message) => { port.postMessage(message); if (port === sync) wake(); };
let state = "loading";
let failure = null;
let inFlight = null;
const queue = [];
let stderr = "";
const child = fork(entry, [dir], { execArgv, env, serialization: "advanced", stdio: ["ignore", "ignore", "pipe", "ipc"] });
child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-4000); });
const fail = (reason) => {
  if (state === "failed") return;
  state = "failed";
  failure = reason;
  for (const pending of (inFlight === null ? [] : [inFlight]).concat(queue.splice(0))) reply(pending.port, { id: pending.request.id, failed: reason });
  inFlight = null;
  background.postMessage({ type: "failed", reason });
  wake();
};
const next = () => {
  if (state !== "ready" || inFlight !== null || queue.length === 0) return;
  const first = queue.findIndex((pending) => pending.port === sync);
  inFlight = queue.splice(first === -1 ? 0 : first, 1)[0];
  child.send(inFlight.request);
};
child.on("message", (message) => {
  if (message.type === "ready") {
    state = "ready";
    background.postMessage({ type: "ready", pid: child.pid });
    wake();
    next();
  } else if (message.type === "failed") {
    fail(message.reason);
  } else if (inFlight !== null && inFlight.request.id === message.id) {
    const done = inFlight;
    inFlight = null;
    reply(done.port, message);
    next();
  }
});
child.on("error", (error) => fail(error.message));
child.on("exit", (code, signal) => {
  const last = stderr.trim().split("\\n").filter(Boolean).pop();
  fail("the embedder process exited (" + (signal ?? "code " + code) + ")" + (last === undefined ? "" : ": " + last));
});
const accept = (port) => (request) => {
  if (request.type === "stop") { state = "failed"; failure = "unloaded"; child.kill(); return; }
  if (state === "failed") { reply(port, { id: request.id, failed: failure }); return; }
  queue.push({ port, request });
  next();
};
sync.on("message", accept(sync));
background.on("message", accept(background));
`;

interface Proxy {
  worker: Worker;
  sync: MessagePort;
  async: MessagePort;
  signal: Int32Array;
}

type Reply = { id: number; vectors: Int8Array; scales: Float64Array } | { id: number; error: string } | { id: number; failed: string };

class ProcessEmbedder implements Embedder {
  readonly modelId = MODEL.id;
  readonly dimensions = MODEL.dimensions;
  private readonly dir: string;
  private readonly idleMs: number;
  private readonly execArgv: readonly string[];
  private proxy: Proxy | null = null;
  private ready = false;
  private failure: { reason: string; at: number } | null = null;
  private closed = false;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (vectors: Vector[]) => void; reject: (error: Error) => void; texts: number }>();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(options: EmbedderOptions) {
    this.dir = options.dir;
    this.idleMs = options.idleMs ?? IDLE_UNLOAD_MS;
    this.execArgv = [...V8_FLAGS, ...(options.execArgv ?? process.execArgv)];
  }

  embed(texts: readonly string[], kind: EmbedKind): Vector[] {
    if (texts.length === 0) return [];
    const proxy = this.start();
    const id = ++this.nextId;
    proxy.sync.postMessage({ id, texts: [...texts], kind });
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const received = receiveMessageOnPort(proxy.sync) ?? null;
      if (received !== null) {
        const reply = received.message as Reply;
        // A reply to an earlier request that timed out is dropped.
        if (reply.id === id) return this.settle(reply, texts.length);
        continue;
      }
      const seen = Atomics.load(proxy.signal, 0);
      const late = receiveMessageOnPort(proxy.sync);
      if (late !== undefined) {
        const reply = late.message as Reply;
        if (reply.id === id) return this.settle(reply, texts.length);
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw this.fail(`no vectors after ${WAIT_MS / 1000} s`);
      Atomics.wait(proxy.signal, 0, seen, left);
    }
  }

  embedAsync(texts: readonly string[], kind: EmbedKind): Promise<Vector[]> {
    if (texts.length === 0) return Promise.resolve([]);
    let proxy: Proxy;
    try {
      proxy = this.start();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new EmbedderUnavailable(String(error)));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, texts: texts.length });
      // Keeps the process alive while a request is out, and only then.
      proxy.async.ref();
      proxy.async.postMessage({ id, texts: [...texts], kind });
    });
  }

  status(): EmbedderStatus {
    const state = this.proxy !== null ? (this.ready ? "loaded" : "loading") : this.failure !== null ? "failed" : "unloaded";
    return { modelId: this.modelId, state, problem: state === "failed" ? (this.failure?.reason ?? null) : null };
  }

  unload(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const proxy = this.proxy;
    if (proxy === null) return;
    this.proxy = null;
    this.ready = false;
    for (const [id, waiting] of this.pending) {
      this.pending.delete(id);
      waiting.reject(new EmbedderUnavailable("the model was unloaded"));
    }
    // The proxy kills the process; terminating the proxy closes the process's IPC channel, which
    // ends it too should the stop not arrive first.
    proxy.async.postMessage({ type: "stop" });
    void proxy.worker.terminate();
    proxy.sync.close();
    proxy.async.close();
  }

  close(): void {
    this.closed = true;
    this.unload();
  }

  private start(): Proxy {
    if (this.closed) throw new EmbedderUnavailable("the embedder is closed");
    if (this.proxy !== null) return this.proxy;
    if (this.failure !== null && Date.now() - this.failure.at < RETRY_AFTER_MS) throw new EmbedderUnavailable(this.failure.reason);
    const entry = join(this.dir, EMBEDDER_ENTRY);
    if (!existsSync(entry)) throw this.fail(`${entry} is missing`);
    const sync = new MessageChannel();
    const background = new MessageChannel();
    const signal = new SharedArrayBuffer(4);
    const worker = new Worker(PROXY_SOURCE, {
      eval: true,
      workerData: { sync: sync.port2, async: background.port2, signal, entry, dir: this.dir, execArgv: this.execArgv, env: { ...process.env, ...ENV } },
      transferList: [sync.port2, background.port2],
      // The proxy prints nothing; the model's process's stderr is kept for failure reasons.
      stdout: true,
      stderr: true,
    });
    worker.unref();
    const proxy: Proxy = { worker, sync: sync.port1, async: background.port1, signal: new Int32Array(signal) };
    proxy.async.on("message", (message: Reply | { type: "ready" } | { type: "failed"; reason: string }) => {
      if (this.proxy !== proxy) return;
      if ("type" in message) {
        if (message.type === "ready") this.ready = true;
        else this.fail(message.reason);
        return;
      }
      const waiting = this.pending.get(message.id);
      if (waiting === undefined) return;
      this.pending.delete(message.id);
      if (this.pending.size === 0) proxy.async.unref();
      try {
        waiting.resolve(this.settle(message, waiting.texts));
      } catch (error) {
        waiting.reject(error as Error);
      }
    });
    proxy.async.unref();
    worker.on("error", (error: Error) => {
      if (this.proxy === proxy) this.fail(error.message);
    });
    this.proxy = proxy;
    return proxy;
  }

  private settle(reply: Reply, count: number): Vector[] {
    if ("failed" in reply) throw this.fail(reply.failed);
    if ("error" in reply) throw new EmbedderUnavailable(reply.error);
    this.ready = true;
    this.failure = null;
    this.touch();
    const dims = this.dimensions;
    return Array.from({ length: count }, (_, i) => ({ values: reply.vectors.slice(i * dims, (i + 1) * dims), scale: reply.scales[i] ?? 0 }));
  }

  /** Records a failure, stops the process and returns the error to throw. */
  private fail(reason: string): EmbedderUnavailable {
    this.failure = { reason, at: Date.now() };
    this.unload();
    return new EmbedderUnavailable(reason);
  }

  /** Re-arms the idle unload. */
  private touch(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0) this.unload();
      else this.touch();
    }, this.idleMs);
    this.idleTimer.unref();
  }
}
