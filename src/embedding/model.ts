/**
 * The embedding model Debrief ships (ADR 0001): snowflake-arctic-embed-xs, int8 ONNX, 384
 * dimensions, CLS pooling, a query prefix, 512 tokens. Apache-2.0, by Snowflake.
 *
 * The files are fetched at build time from Hugging Face at a pinned revision and checked against
 * the SHA-256s below (`scripts/bundle.mjs`), then shipped inside the npm package: Debrief never
 * downloads anything at run time. For an LFS file the SHA-256 is the LFS object id Hugging Face
 * lists for that revision; the small files are plain Git blobs there, pinned by the SHA-256 of the
 * blob whose Git id the revision lists.
 *
 * `id` tags every stored vector: a different id is a different key, so vectors from two models are
 * never mixed or compared, and a new model re-embeds from nothing.
 */
export const MODEL = {
  id: "snowflake-arctic-embed-xs@q8",
  repository: "Snowflake/snowflake-arctic-embed-xs",
  revision: "d8c86521100d3556476a063fc2342036d45c106f",
  dimensions: 384,
  maxTokens: 512,
  /** Prepended to queries, never to documents (the model card's retrieval setup). */
  queryPrefix: "Represent this sentence for searching relevant passages: ",
  /** Where the files sit beside `dist/debrief.mjs`. */
  directory: "models/snowflake-arctic-embed-xs",
  files: [
    { source: "onnx/model_quantized.onnx", name: "model_quantized.onnx", bytes: 22_972_992, sha256: "e6aa5e656466a73d7c3111e9a3378bd13e5b93af30eaac2b3f13fd56692589a1" },
    { source: "tokenizer.json", name: "tokenizer.json", bytes: 711_649, sha256: "91f1def9b9391fdabe028cd3f3fcc4efd34e5d1f08c3bf2de513ebb5911a1854" },
    { source: "tokenizer_config.json", name: "tokenizer_config.json", bytes: 1_433, sha256: "9ca59277519f6e3692c8685e26b94d4afca2d5438deff66483db495e48735810" },
  ],
  license: "Apache-2.0",
} as const;

/** ONNX Runtime's WebAssembly build, copied beside the bundle from `onnxruntime-web/dist`. */
export const RUNTIME_FILES = ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"] as const;

/**
 * ONNX Runtime's notices for the third-party components its WebAssembly build compiles in, which
 * its npm package does not carry. Fetched at build time from the onnxruntime repository at the tag
 * of the installed onnxruntime-web (the build fails on any other version), checked against this
 * SHA-256 like the model's files, and shipped unmodified beside the runtime as `name`.
 */
export const RUNTIME_NOTICES = {
  repository: "microsoft/onnxruntime",
  tag: "v1.30.0",
  source: "ThirdPartyNotices.txt",
  name: "ONNXRUNTIME_THIRD_PARTY_NOTICES.txt",
  bytes: 338_088,
  sha256: "143764b952fdb1a7c69ce653bfba74a7744d6a8a573bfb73e235fba356c83de3",
} as const;

/** The embedder process's entry, bundled beside `dist/debrief.mjs` (see scripts/bundle.mjs). */
export const EMBEDDER_ENTRY = "embedder.mjs";
