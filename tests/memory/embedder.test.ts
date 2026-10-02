import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { openEmbedder } from "../../src/embedding/embedder.js";
import { onCleanup } from "../helpers.js";

/**
 * The model's process is tuned for memory (fewer threads, a smaller young generation, the model's
 * bytes freed after load, macOS's malloc told to give pages back). None of that may change a
 * vector: stored vectors and new ones are compared with each other, so a drift would rank old
 * memory against new by noise. `embedder-golden.json` holds what the untuned process returned
 * (4 threads, `--liftoff-only` only) for a few texts, both kinds.
 */

const DIST = resolve(import.meta.dirname, "../../dist");

interface Golden {
  kind: "query" | "document";
  text: string;
  scale: number;
  /** The int8 vector, base64. */
  values: string;
}

const GOLDEN = JSON.parse(readFileSync(resolve(import.meta.dirname, "embedder-golden.json"), "utf8")) as Golden[];

test("T1: the tuned model process returns the untuned configuration's vectors, bit for bit", () => {
  const embedder = openEmbedder({ dir: DIST, execArgv: [] });
  onCleanup(() => {
    embedder.close();
  });
  expect(GOLDEN.length).toBe(5);
  for (const { kind, text, scale, values } of GOLDEN) {
    const [vector] = embedder.embed([text], kind);
    expect(vector?.scale, text).toBe(scale);
    expect(Buffer.from(vector?.values ?? new Int8Array()).toString("base64"), text).toBe(values);
  }
});
