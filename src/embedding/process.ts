import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as tokenizers from "@huggingface/tokenizers";
import * as ort from "onnxruntime-web";
import { MODEL } from "./model.js";

/** What this process uses of `@huggingface/tokenizers`, whose bundled type declarations do not resolve under NodeNext. */
interface Tokenizer {
  encode(text: string): { ids: number[] };
}
const { Tokenizer } = tokenizers as unknown as { Tokenizer: new (tokenizer: object, config: object) => Tokenizer };

/**
 * The embedder process (`dist/embedder.mjs`): the only code that loads the model. The MCP server
 * starts it on demand (src/embedding/embedder.ts) with the bundle's directory as its argument, asks
 * for vectors over IPC, and kills it when idle, which returns every byte the model and the
 * WebAssembly runtime held. It opens no file but its own, no database and no connection, and exits
 * when its parent goes away.
 *
 * Protocol: it sends `{ type: "ready" }` once the model loaded, or `{ type: "failed", reason }` and
 * exits. Each request `{ id, texts, kind }` gets `{ id, vectors, scales }` (one int8 vector of
 * `MODEL.dimensions` per text, concatenated, and its scale) or `{ id, error }`.
 */

/**
 * ONNX Runtime threads. Each is a worker with its own V8 isolate, about 10 MB, and under Liftoff
 * speed scales with them: 3 embed about 22 chunks/s, 4 about 30 (#51's RSS spike).
 */
const THREADS = 3;

interface Request {
  id: number;
  texts: string[];
  kind: "query" | "document";
}

type Loaded = { session: ort.InferenceSession; tokenizer: Tokenizer };

async function load(dir: string): Promise<Loaded> {
  const files = join(dir, MODEL.directory);
  const read = (name: string): Buffer => {
    const bytes = readFileSync(join(files, name));
    const expected = MODEL.files.find((file) => file.name === name)?.sha256;
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) throw new Error(`${name} does not match the pinned model (sha256 ${actual})`);
    return bytes;
  };
  const tokenizer = new Tokenizer(JSON.parse(read("tokenizer.json").toString("utf8")) as object, JSON.parse(read("tokenizer_config.json").toString("utf8")) as object);
  ort.env.logLevel = "error";
  ort.env.wasm.numThreads = THREADS;
  ort.env.wasm.wasmPaths = pathToFileURL(join(dir, "/")).href;
  const session = await ort.InferenceSession.create(read("model_quantized.onnx"), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  // The session holds its own copy of the model now: collect the 23 MB of file bytes and the
  // tokenizer's parse garbage, whose pages macOS's malloc then returns (`MallocSpaceEfficient`,
  // src/embedding/embedder.ts). `gc` exists under `--expose-gc`, which the embedder passes.
  globalThis.gc?.();
  return { session, tokenizer };
}

/** One text's token ids: [CLS] … [SEP], cut to the model's 512 tokens with [SEP] kept last. */
function encode(tokenizer: Tokenizer, text: string): number[] {
  const ids = tokenizer.encode(text).ids;
  return ids.length <= MODEL.maxTokens ? ids : [...ids.slice(0, MODEL.maxTokens - 1), ids[ids.length - 1] ?? 0];
}

/**
 * Embeds texts one at a time (no padding, so a short text costs what it is) and returns each as a
 * unit vector quantized to int8: `vector[i] * scale` is the float value.
 */
async function embed({ session, tokenizer }: Loaded, texts: readonly string[], kind: Request["kind"]): Promise<{ vectors: Int8Array; scales: Float64Array }> {
  const dims = MODEL.dimensions;
  const vectors = new Int8Array(texts.length * dims);
  const scales = new Float64Array(texts.length);
  for (const [i, text] of texts.entries()) {
    const ids = encode(tokenizer, kind === "query" ? MODEL.queryPrefix + text : text);
    const shape = [1, ids.length];
    const output = await session.run({
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, (id) => BigInt(id)), shape),
      attention_mask: new ort.Tensor("int64", new BigInt64Array(ids.length).fill(1n), shape),
      token_type_ids: new ort.Tensor("int64", new BigInt64Array(ids.length), shape),
    });
    const hidden = output["last_hidden_state"];
    if (hidden === undefined) throw new Error("the model returned no last_hidden_state");
    // CLS pooling: the first token's state, normalised to unit length, then quantized.
    const cls = (hidden.data as Float32Array).subarray(0, dims);
    const norm = Math.hypot(...cls) || 1;
    let max = 0;
    for (const value of cls) max = Math.max(max, Math.abs(value / norm));
    const scale = max === 0 ? 1 : max / 127;
    for (let d = 0; d < dims; d++) vectors[i * dims + d] = Math.max(-127, Math.min(127, Math.round((cls[d] ?? 0) / norm / scale)));
    scales[i] = scale;
    for (const tensor of Object.values(output)) tensor.dispose();
  }
  return { vectors, scales };
}

async function main(): Promise<void> {
  const send = (message: unknown): void => {
    process.send?.(message);
  };
  process.on("disconnect", () => process.exit(0));
  const dir = process.argv[2];
  let loaded: Loaded;
  try {
    if (dir === undefined) throw new Error("no bundle directory given");
    loaded = await load(dir);
  } catch (error) {
    send({ type: "failed", reason: error instanceof Error ? error.message : String(error) });
    if (process.connected) process.disconnect();
    process.exitCode = 1;
    return;
  }
  send({ type: "ready" });
  // One request at a time, in arrival order.
  let queue = Promise.resolve();
  process.on("message", (request: Request) => {
    queue = queue.then(async () => {
      try {
        send({ id: request.id, ...(await embed(loaded, request.texts, request.kind)) });
      } catch (error) {
        send({ id: request.id, error: error instanceof Error ? error.message : String(error) });
      }
    });
  });
}

void main();
