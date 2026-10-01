---
status: accepted
issue: "#51"
---

# 0001: Meaning search

Recall finds memory by meaning as well as by shared words. The memory module embeds every search chunk with **snowflake-arctic-embed-xs** (int8 ONNX, 384 dimensions), run by **ONNX Runtime's WebAssembly build** inside the MCP server. The model and the runtime **ship in the npm package**, so Debrief still opens no connection. Vectors are stored as **int8 BLOBs in each workspace's SQLite file**, a derived projection of `chunks` tagged with the model. They are searched by a **brute-force scan** in the server, with no vector extension. On page 1, the vector order is **fused with the keyword order by reciprocal rank fusion (k = 60)**. Records that a query's tiers lifted stay first, and the fused order is frozen into the continuation as it is today. The unit is the **chunk**; a record scores its best chunk. There are no round-level vectors.

Every figure below was measured by a throwaway spike on 2026-09-29 (Apple M4 Pro, 12 cores, 24 GB, macOS 26, Node 25.9 unless stated). The harness, data, models and vectors were never committed. "Debrief" means `main` at 0acf20f.

## Context

Debrief's recall is a well-tokenized BM25 with tiers (phrases, time windows, "now") and trust bands. On LongMemEval_S it misses questions that share no words with their answer: "doctors" against "Dr. Patel", "photography setup" against "Sony A7R IV". Every competitor searches by meaning. #51 asks for meaning search across all memory without giving up what recall guarantees today: eligibility before ranking, budgets, the frozen continuation order, citations, freshness, and no network.

The spike had to settle six choices: runtime, model, vector storage, delivery, retrieval unit and fusion. The user signed off on delivery (bundled) on 2026-09-30.

## Decided on 2026-09-30

The user accepted this record with four decisions that change how it is delivered:

| Decision | Consequence |
|---|---|
| **Build before dogfooding.** Every competitor searches by meaning; Debrief ships it before the user starts using it daily | "What would make this not worth it" (below) is no longer a gate. The agent-rephrasing measurement goes in PR 2's body as evidence |
| **RAM: +150 MB at peak and about 0 when idle is a target, not a gate** | PR 2 ships at whatever it measures and reports it. #51 stays open until the target is met. The lean design to try then: one thread in the server, bulk embedding in a short-lived separate process, the model unloaded when idle |
| **One PR, not two.** The background fill embeds any chunk without a current-model vector, so it is the backfill of existing and imported memory too | #51's PR 2 and PR 3 are one PR. Rebuilding vectors (`diag reindex`) and the integrity checks for vectors move to #22, beside the keyword index's |
| **Session start carries no work context** (#33). The agent recalls at the start of each task through `memory_recall`, which is where meaning search runs | Hooks still never load the model. Automatic per-prompt recall stays keyword-only and is held (#33) |

## Decisions

| Choice | Decision | Confidence |
|---|---|---|
| Runtime | `onnxruntime-web` 1.30 (WASM) + `@huggingface/tokenizers`, bundled by esbuild; the 14.2 MB `.wasm` ships beside `dist/debrief.mjs` and is loaded only by `debrief mcp` | moderate |
| Model | `Snowflake/snowflake-arctic-embed-xs`, int8 (`onnx/model_quantized.onnx`, 23.0 MB, Apache-2.0), 384 dimensions, CLS pooling, query prefix, 512 tokens | low–moderate (the small models are within noise of each other on quality; speed decides) |
| Storage | a `chunk_vectors` table in `memory.sqlite`: (model id, chunk text hash) → int8 vector + scale; brute-force scan in the server; no `sqlite-vec` | high |
| Delivery | model files inside the npm package; no download, no new host; privacy row unchanged | moderate–high (signed off by the user) |
| Unit | the search chunk (≤ 1,000 bytes); a record scores its best chunk; no round vectors | moderate |
| Fusion | reciprocal rank fusion, k = 60, equal weights, of page 1's keyword order (after tiers and trust) and the vector order over eligible records; tier-lifted records stay ahead; frozen as today | moderate |

## Recall: LongMemEval_S

LongMemEval_S (cleaned): 500 questions, 419 scored under the official rules (abstention questions and those with no user-side answer turn are skipped). Each haystack was imported through the real Debrief bundle: Claude Code transcripts, `bootstrap` then `continueImport`, then `recall` following continuations. Keyword order is Debrief's own page-1 order. Vectors cover the real `chunks` projection. Scoring is session-level recall_any@k. Vectors are over user messages ("u") unless marked "u+a" (user and assistant messages, which is what Debrief imports).

| Retriever | R@1 | R@3 | R@5 | R@10 | preference R@5 | multi-session R@5 | temporal R@5 | of 24 misses fixed | new misses |
|---|---|---|---|---|---|---|---|---|---|
| **Debrief `main` (keyword)** | 85.7 | 92.4 | **94.3** | 96.2 | 63.3 | 95.9 | 93.7 | – | – |
| all-MiniLM-L6-v2 q8, vectors only | 84.7 | 94.3 | 96.4 | 98.3 | 96.7 | 97.5 | 94.5 | 21 | 12 |
| all-MiniLM-L6-v2 q8, fused | 88.5 | 95.9 | 97.6 | 99.3 | 90.0 | 97.5 | 97.6 | 17 | 3 |
| all-MiniLM-L6-v2 fp32, fused | 88.1 | 95.9 | 97.9 | 99.3 | 90.0 | 98.3 | 97.6 | 18 | 3 |
| bge-small-en-v1.5 q8, vectors only | 88.3 | 96.4 | 98.3 | 98.6 | 96.7 | 100.0 | 96.1 | 21 | 4 |
| **bge-small-en-v1.5 q8, fused** | 89.5 | 96.7 | **98.8** | 99.5 | 93.3 | 99.2 | 98.4 | 20 | 1 |
| arctic-embed-xs q8, vectors only | 85.7 | 94.3 | 95.9 | 97.9 | 93.3 | 99.2 | 90.6 | 17 | 10 |
| **arctic-embed-xs q8, fused** | 90.2 | 95.0 | **98.1** | 99.3 | 90.0 | 98.3 | 97.6 | 17 | 1 |
| arctic-embed-xs q8, fused, u+a | 89.3 | 96.4 | 98.1 | 99.5 | 100.0 | 99.2 | 95.3 | 18 | 2 |
| arctic-embed-xs q8, fused, **rounds** | 86.4 | 94.3 | 98.3 | 99.3 | 96.7 | 98.3 | 98.4 | 20 | 3 |
| arctic-embed-s q8, fused | 88.5 | 95.5 | 97.1 | 99.5 | 86.7 | 98.3 | 95.3 | 16 | 4 |
| bge-base-en-v1.5 q8, vectors only | 90.2 | 96.7 | 98.8 | 99.8 | 93.3 | 100.0 | 98.4 | 22 | 3 |
| bge-base-en-v1.5 q8, fused | 90.7 | 96.4 | 98.6 | 99.5 | 86.7 | 99.2 | 99.2 | 19 | 1 |
| nomic-embed-text-v1.5 q8 @256 dims, vectors only | 90.0 | 96.4 | 98.3 | 99.3 | 96.7 | 100.0 | 95.3 | 22 | 5 |
| nomic-embed-text-v1.5 q8 @256 dims, fused | 90.7 | 96.2 | 98.6 | 99.3 | 90.0 | 99.2 | 98.4 | 18 | 0 |
| jina-embeddings-v2-base-code q8, vectors only | 53.0 | 71.4 | 79.0 | 87.4 | 73.3 | 86.0 | 72.4 | 11 | 75 |
| jina-embeddings-v2-base-code q8, fused | 76.6 | 88.5 | **93.1** | 97.4 | 80.0 | 95.9 | 89.8 | 12 | 17 |

"Fused" is RRF k = 60 with tier-lifted records kept first. On LongMemEval keeping them first changed nothing: 52 of 419 questions had a tier-lifted prefix (median 2 records), and every configuration run both ways (MiniLM, bge-small, both arctic models, u+a, rounds) scored the same with and without it. Storing the vectors as int8 changed nothing either: bge-small fused R@5 stayed 98.8 and R@1 went from 89.5 to 89.3; MiniLM fused stayed at 97.6. Sensitivity to the fusion constant was checked but not used to choose it: MiniLM fused R@5 was 97.6 at k = 60, 98.3 at k = 20 and 97.9 at k = 10. Weighting vectors 2:1 gave 98.1, weighting keywords 2:1 gave 97.1. k = 60 is the literature default and was fixed before looking.

**The misses.** Debrief `main` misses 24 questions at R@5 (0.1.0 missed 21 at 93.6). All 24 are vocabulary mismatch. The fixes, per model (fused, u):

| Miss (question, abridged) | MiniLM | bge-small | arctic-xs |
|---|---|---|---|
| How many different **doctors** did I visit? (Dr. Patel) | ✓ | ✓ | ✓ |
| How many music albums or EPs have I purchased? | ✓ | ✓ | ✓ |
| Accessories for my current **photography setup**? (Sony A7R IV) | ✓ | ✓ | ✓ |
| Recent publications or conferences I might find interesting? | ✓ | ✓ | ✓ |
| Activities I can do in the evening? | ✓ | ✓ | ✓ |
| Dinner this weekend with my homegrown ingredients? | – | ✓ | ✓ |
| Which cocktail for an upcoming get-together? | ✓ | ✓ | – |
| Phone battery life tips? | – | – | – |
| Chocolate chip cookies need something extra? | ✓ | ✓ | – |
| Rearranging the furniture in my bedroom? | ✓ | ✓ | ✓ |
| What to look for in a new guitar? | ✓ | ✓ | ✓ |
| Sneezing: might it be my living room? | ✓ | ✓ | ✓ |
| Should I attend my high school reunion? | – | – | ✓ |
| How long have I been working in my current role? | – | ✓ | ✓ |
| How many years older am I than when I graduated? | – | ✓ | ✓ |
| Total number of siblings? | ✓ | ✓ | – |
| Order of the three trips in the past three months? | ✓ | ✓ | ✓ |
| How many days ago did I buy a smoker? | ✓ | ✓ | ✓ |
| Order of the three sports events last month? | ✓ | ✓ | ✓ |
| Which book did I finish a week ago? | ✓ | ✓ | ✓ |
| Life event of a relative a week ago? | ✓ | ✓ | ✓ |
| What did I cook for my friend a couple of days ago? | – | ✓ | – |
| The business milestone I mentioned four weeks ago? | ✓ | – | – |
| What kitchen appliance did I buy 10 days ago? | – | – | – |
| *new misses* | 3 | 1 | 1 |

The one new miss that every fused model shares is "How many projects have I led or am currently leading?" (multi-session). As a sanity check, MiniLM on its own over user messages scores R@5 96.4. MemPalace reports 96.6 for raw MiniLM under its own protocol (all 500 questions).

## Recall: code memory

LongMemEval is chat, not code. So 50 hand-written records of one fictional payments service were stored through `memory.record` (decisions, observations, notes, file paths, identifiers, error strings), along with 30 hand-written questions: 17 paraphrases sharing no content words with their answer, 4 identifier lookups, 2 prose-to-identifier, 1 error string, 3 lexical controls, and 3 stale/current pairs (an older record and the newer one that replaced it, never superseded in Debrief). The results are counts of 30. "Current above stale" counts a pair when the current record is in the top 3 and above the one it replaced.

| Retriever | R@1 | R@3 | R@5 | MRR | paraphrase R@3 | identifier R@3 | current above stale |
|---|---|---|---|---|---|---|---|
| **Debrief `main` (keyword)** | 15 | 23 | 25 | 0.625 | 10/17 | 4/4 | 2/3 |
| MiniLM q8: vectors / fused | 23 / 22 | 28 / 26 | 28 / 26 | 0.848 / 0.799 | 15 / 13 | 4 / 4 | 2 / 2 |
| bge-small q8: vectors / fused | 18 / 20 | 25 / 24 | 26 / 25 | 0.709 / 0.740 | 13 / 11 | 4 / 4 | 2 / 2 |
| **arctic-xs q8: vectors / fused** | 23 / 21 | 28 / 26 | 28 / 27 | 0.845 / 0.783 | 16 / 13 | 4 / 4 | 2 / 2 |
| arctic-s q8: vectors / fused | 22 / 22 | 27 / 26 | 29 / 27 | 0.829 / 0.800 | 14 / 13 | 4 / 4 | 1 / 2 |
| bge-base q8: vectors / fused | 23 / 19 | 28 / 25 | 29 / 26 | 0.860 / 0.746 | 15 / 12 | 4 / 4 | 2 / 2 |
| nomic-embed-text-v1.5 q8 @256: vectors / fused | 20 / 21 | 27 / 26 | 27 / 26 | 0.781 / 0.781 | 14 / 13 | 4 / 4 | 1 / 2 |
| jina-embeddings-v2-base-code q8: vectors / fused | 23 / 21 | 28 / 26 | 29 / 26 | 0.857 / 0.789 | 15 / 13 | 4 / 4 | 1 / 2 |

No model hurt identifiers: exact identifiers, error strings and lexical controls stayed found in every configuration. The code-trained model (jina-code) was no better here than the general small ones, at seven times the size and an eighth of the speed. On LongMemEval's prose it was the one model that made recall *worse*: fused R@5 93.1 against keyword-only 94.3, with 17 new misses. The worry was a model that helps prose but hurts code. What the spike found was the reverse, and the general small models showed neither problem. Two findings hold for every model:

- **Fusion leaves out an answer that shares no word with the question.** A record the keyword side never returns gets credit from one list only, so it sinks below records both lists return. By vectors alone, "Why is there no message broker anymore?" finds "We dropped Redis for the queue" in the top 3 for arctic-xs and 6th for MiniLM. Fused, it ranks 14th to 31st, depending on the model. Vectors alone beat fusion on this set and lose to it on LongMemEval. Cutting the keyword list to its top 10 or 20 did not help. PR 2 keeps RRF and records this limit; tuning fusion belongs to #52.
- **Meaning does not tell current from stale.** "How long do login sessions last?" ranks the replaced "SameSite=Lax, 7-day expiry" above its replacement both by keywords and by vectors. Near-identical text gets near-identical vectors, so meaning search surfaces both. Supersession (eligibility) and the "now" tier remain the only defences against stale memory.

## Runtime

Timings were taken with the spike's embedding jobs paused (load average 9–12 from other work on the machine). Throughput was measured on 2,000 real LongMemEval texts (1,500 user messages and 500 assistant chunks of ≤ 1,000 bytes), batch 8, padded to power-of-two lengths. Query latency is one short question at a time in a long-lived process (300 queries).

| Model (int8) | Runtime | Cold: process start → first vector | Query p50 / p95 | Docs/s | RSS, model loaded | Peak RSS while filling |
|---|---|---|---|---|---|---|
| MiniLM-L6 | native, all cores | 88 ms | 1.3 / 1.4 ms | 355 | 160 MB | 454 MB |
| arctic-xs | native | 80 ms | 1.4 / 2.1 ms | 319 | 159 MB | 928 MB (512 tokens) |
| bge-small | native | 110 ms | 2.7 / 4.3 ms | 160 (179 at 256 tokens) | 175 MB | 959 MB (490 MB at 256 tokens) |
| arctic-s | native | 114 ms | 2.7 / 4.3 ms | 161 | 175 MB | 955 MB |
| bge-base | native | 175 ms | 5.0 / 8.3 ms | 73 | 315 MB | 1,265 MB |
| nomic-v1.5 | native | 210 ms | 6.5 / 11.1 ms | 53 | 415 MB | 2,141 MB |
| jina-code | native | 277 ms | 6.5 / 10.8 ms | 42 | 465 MB | 1,252 MB |
| MiniLM-L6 | WASM, 4 threads | 215 ms | 4.2 / 4.9 ms | 72 | ~660 MB | 699 MB |
| **arctic-xs** | **WASM, 4 threads** | **211 ms** | **4.7 / 8.7 ms** | **72** | **~660 MB** | **797 MB** |
| bge-small | WASM, 4 threads | 273 ms | 9.4 / 17.3 ms | 36 | ~700 MB | 708 MB |
| bge-small | WASM, 1 thread | 274 ms | 30.8 / 59.6 ms | 9 | ~670 MB | 673 MB |

WASM ran at 256 tokens. A bare Node process is 49 MB. WASM resident memory rose to 500–750 MB within about 100 queries and stayed there. The level was the same with 1 or 4 threads, and turning off the arena and memory pattern did not change it. Per document, WASM used about three times the CPU of native. Native and WASM vectors are interchangeable: over 300 texts, the cosine between them was at least 0.9915 (bge-small) and 0.9980 (arctic-xs), with medians of 0.998 and 0.999. So a vector is tagged with the model, not the runtime.

| | onnxruntime-node 1.30 (native) | onnxruntime-web 1.30 (WASM) | @huggingface/transformers 4.3 |
|---|---|---|---|
| Installed size | 287 MB on every platform (the package carries all platforms' binaries) | 144 MB as a package; **14.2 MB `.wasm` + 175 KB of bundled JS** as Debrief would ship it | 476 MB (both runtimes plus `sharp`) |
| darwin-arm64 · linux-x64 · linux-arm64 · win32-x64 | ✓ · ✓ · ✓ · ✓ | ✓ everywhere Node runs | as its runtime |
| darwin-x64 (Intel Mac) | **✗ since 1.24.1** (2026-02); 1.23.2 was the last release with it (258 MB) | ✓ | as its runtime |
| Install script | `postinstall`; **on linux-x64 it downloads the CUDA 12 NuGet package (236 MB) from api.nuget.org** unless install scripts are blocked or `ONNXRUNTIME_NODE_INSTALL=skip` | none | inherits both, plus `sharp` |
| Single-file bundle | cannot be inlined: an external native dependency like better-sqlite3 | **verified**: esbuild bundles the Node build of `onnxruntime-web` with the tokenizer, reads the `.wasm` from beside the bundle, and runs with no `node_modules` | no |
| Node 24.21 / 25.9 / 26.8 | ✓ / ✓ / ✓ (darwin-arm64) | ✓ / ✓ / ✓ (darwin-arm64, bundled) | not tested |
| Licence | MIT | MIT | Apache-2.0; `sharp`'s libvips is LGPL-3.0 |

Linux and Windows were checked from the published packages' contents, not run: Docker was not running on the spike machine. `sqlite-vec` was also loaded on Node 24, 25 and 26.

## Vector storage

The latency of one query's top 200 records, with eligibility (workstream, lifecycle, taints) applied before ranking as recall requires. The corpus used random unit vectors, 384 dimensions and 1.64 chunks per record (LongMemEval's ratio), 40 queries per size. The "BLOB scan" reads every eligible vector from SQLite and scores in JS. The "in-memory scan" keeps the matrix in the server and re-reads only the eligible record set per query. `vec0` is sqlite-vec 0.1.9's KNN table, filtered afterwards.

| Chunks (records) | BLOB scan p50 | In-memory f32 p50 | In-memory int8 p50 | sqlite-vec `vec0` KNN p50 | `vec_distance_cosine` in SQL p50 |
|---|---|---|---|---|---|
| 1k (610) | 0.9 ms | 0.4 ms | – | 0.7 ms | 0.8 ms |
| 10k (6.1k) | 11.9 ms | 3.8 ms | 3.8 ms | 6.2 ms | 10.7 ms |
| 50k (30k) | 62.6 ms | 20.1 ms | – | 30.9 ms | 108 ms |
| 100k (61k) | 129 ms | 41.2 ms | 43.9 ms | 62.5 ms | 217 ms |
| 250k (152k) | 352 ms | 105 ms | – | 155 ms | 694 ms |

**There is no crossover.** sqlite-vec 0.1.9 has no approximate index: `vec0` is a brute-force scan in C, and it is slower than the JS in-memory scan at every size measured. It would add a native extension per platform (five optional packages) and `loadExtension` to a process that loads none today. An approximate index becomes worth revisiting only when a workspace passes about 250k chunks (about 150k records), where one scan exceeds 100 ms.

| Growth per 10k records (16.4k chunks) | Bytes |
|---|---|
| Debrief's database today, LongMemEval content (records, FTS, import events) | 44–47 MB |
| + f32 vectors as BLOBs (384 dims) | +33.5 MB |
| + sqlite-vec `vec0` (384 dims) | +25.7 MB |
| + f32 BLOBs at 256 dims (nomic, truncated) / 768 dims (base models) | +22.4 MB / +67.3 MB |
| **+ int8 BLOBs (384 dims, one scale per vector)** | **+7.5 MB** |

The in-memory int8 matrix is 3.8 MB per 10k chunks (38 MB at 100k).

## Delivery

| | Bundled in the npm package (chosen) | Downloaded once on first use, checksum-pinned |
|---|---|---|
| Added to `npm install` | arctic-xs: +19.7 MB tarball, +38.1 MB unpacked (model 23.0 MB, `.wasm` 14.2 MB, tokenizer 0.7 MB, JS 0.2 MB). bge-small: +27.8 / +49.2 MB. Today: debrief-cli 1.6 MB + better-sqlite3 27.3 MB | +14.4 MB (runtime only) |
| Network | none: the model comes with the code, from the same registry | one fetch of about 24 MB from huggingface.co (a 302 to its CDN), pinned by revision and SHA-256 (the LFS object id *is* the file's SHA-256; checked for bge-small and arctic-xs) |
| Privacy row | unchanged: "Debrief never opens a connection" stays true, and the driven tests' no-network guard stays as it is | changes: "one download of the model from Hugging Face, on first use" |
| Offline | works | keyword-only with a notice until a download succeeds; each retry is a new connection; air-gapped users need a manual placement path |
| Model change | a Debrief release | a new pin, also a release |
| `delete-data` | nothing new | must add `models/` to the entries it removes |

Bundling costs about 38 MB of disk per install and needs no new trust boundary. The download saves those megabytes, but it brings a host, a failure mode, a privacy-row change and an allow-list change. Bundling is recommended. If the tarball size matters more than expected, the fallback is a separate package (for example `debrief-model-arctic-xs`) as an ordinary dependency. That keeps the same registry and the same privacy row, and lets the model version move on its own schedule.

## Why not the alternatives

- **Native runtime (onnxruntime-node).** It has 4.4 times the throughput and a quarter of the resident memory (arctic-xs), and it is the better engine. It is rejected for distribution reasons that the numbers above make concrete: 287 MB installed on every platform (ten times today's footprint), no Intel Macs since February 2026, a 236 MB CUDA download from nuget.org in a linux-x64 `postinstall`, and a second native addon beside better-sqlite3. The embedder seam keeps it one swap away. Vectors are interchangeable, so a swap needs no re-embedding.
- **transformers.js.** It pulls both runtimes and `sharp` with an LGPL libvips, 476 MB in all, to do what 175 KB of tokenizer plus runtime glue does.
- **bge-small-en-v1.5.** It is best on LongMemEval (R@5 98.8, fixes 20 of 24) but mid-pack on code memory (R@1 20 fused vs arctic-xs 21 and MiniLM 22). Under WASM it is half the speed of arctic-xs, with twice the query latency, and it is 11 MB larger. The quality gap either way is 1–3 questions. It is the recommended alternative if the user weights LongMemEval over speed.
- **all-MiniLM-L6-v2.** It is as fast as arctic-xs, but has three new misses on LongMemEval against one, and it was trained on 128-token inputs.
- **Mid-size models** (bge-base-en-v1.5, nomic-embed-text-v1.5 at 256 dimensions) are the best on LongMemEval R@1 (90.7 fused), and fused R@5 is 98.6 for both. Nomic has no new misses. On code memory they match the small models. They cost int8 files of 110 and 137 MB and 4.4 and 6 times arctic-xs's native fill time, with 2–3 times the RAM. WASM would slow them further (not measured). They buy 0–2 questions of 419.
- **The code-trained model** (jina-embeddings-v2-base-code): it is worse than keyword search alone on LongMemEval (fused R@5 93.1), no better on code memory, and 162 MB.
- **Round vectors** (a user message plus the reply). Vectors alone are worse (R@5 95.2 vs 95.9 over chunks), and fused R@1 drops by 3 points (86.4 vs 89.3). R@5 is about the same. A round is also not a Debrief record: agents' own records have no reply, and rounds would break "vectors are a projection of chunks".
- **User messages only.** Fused R@5 is equal to all records (98.1 both). Embedding assistant and agent text costs backfill time but no recall. Keyword search is different: importing assistant text cost 0.1.0 about 13 points on preference questions. Coding memory is mostly agent-written, so all chunks are embedded.
- **sqlite-vec.** No latency win at any measured size, a per-platform native extension, and its only saving (25.7 MB vs 33.5 MB per 10k records) is beaten by int8 BLOBs (7.5 MB).

## Consequences

- **Privacy row:** unchanged. The README should add, in "How it works", that meaning search runs a bundled model in the MCP server and sends nothing anywhere.
- **Install:** about 38 MB more unpacked (about 20 MB more to download) on every platform, and no new native code. Intel Macs and Windows on ARM keep working. They would not with a current native runtime.
- **Memory:** the MCP server holds about 0.5–0.75 GB more while the model is loaded under WASM (measured about 660 MB resident with the model; native would be about 160 MB). Every host session starts its own server. PR 2 must load the model lazily (first recall with a query, or a fill step) and unload it after an idle period. It must also let only one server per workspace fill at a time. The target is +150 MB at peak and about 0 when idle; see "Decided on 2026-09-30".
- **CPU:** embedding new memory is small. A turn's worth of records (tens of chunks) is under a second at 72 chunks/s. Backfill is not small: 10k imported records (16.4k chunks) is about 4 minutes of 4 cores under WASM (native: about 50 s). 100k records is about 40 minutes.
- **Disk:** about +7.5 MB per 10k records with int8 vectors (+16% on today's database).
- **Latency:** page 1 of a recall with a query adds one query embedding (4.7 ms p50 WASM) and one scan (3.8 ms per 10k chunks in memory) to today's page 1, which measured 20–40 ms on LongMemEval haystacks. Later pages add nothing, because they load the frozen order.
- **Offline:** unaffected; there is nothing to fetch.
- **Recall quality:** on LongMemEval_S, R@5 goes from 94.3 to 98.1 and preference R@5 from 63.3 to 90.0–100. On hand-written code memory, R@1 goes from 15 to 21 (of 30). Identifier lookups are unchanged, and stale-versus-current is unchanged.

## What PR 2 builds (new and existing memory)

- **An embedder seam in the memory module.** `embed(texts, kind: "query" | "document") → Int8Array[]`, with `modelId` (e.g. `snowflake-arctic-embed-xs@q8`) and `dimensions`. `openMemory` accepts one, as it accepts `now`. Transports and adapters never see vectors. Tests use the real model, with no mocks.
- **Vectors as a rebuildable derived projection.** A vector is a pure function of chunk text and model, so the next migration (0010; `main` is at schema 9) keys it that way: `chunk_vectors(model, text_hash, scale, vec, PRIMARY KEY (model, text_hash))`, and `chunks` gains `text_hash`. With that key, `rebuildSearchIndex` (which renumbers chunk ids) keeps valid vectors, identical chunks (copies of one host event) are embedded once, and a different model id is a different key: vectors from different models are never mixed or compared. Vectors that no chunk references are garbage; the integrity check reports them (#22).
- **Background fill, which is also the backfill.** The MCP server embeds chunks without vectors between requests, in bounded steps (as `continueImport` does), newest first and current workstream first. That covers existing records and approved imports as well as new memory. Vectors are written in short transactions keyed by (model, text hash), so a restart or kill loses and repeats nothing, and ineligible records are skipped. Hooks never load the model and never embed. Only one server per workspace fills at a time.
- **Fusion on page 1.** After `rankSequence` and `orderByTrust`, records the tiers lifted (phrase, window, now) keep their places at the head. The rest of the keyword order is fused by RRF (k = 60) with the vector order over **eligible** records only (the same `RECALL_ELIGIBLE_SQL` scope, applied before the scan). That way a retracted, forgotten, superseded or other-workstream record can neither be returned nor displace an eligible one. The fused order is capped at `SEQUENCE_CAP` and frozen into the continuation. A record ranked above its keyword position by meaning (or found only by meaning) gets a `why` (e.g. `meaning`). That needs a new `RANKED_BY` bit, and its continuation digit must be able to hold it. Recall without a query is unchanged.
- **Keyword-only fallback with a notice.** No model, a model that fails to load, or vectors still missing all mean recall ranks by keywords exactly as today. It adds a one-line notice (e.g. "meaning search unavailable: …" or "meaning search covers 62% of memory"), and never errors or returns less than keyword search would.
- **Forget and delete-data.** In its transaction, `forget` deletes every vector of the forgotten chunks that no remaining chunk shares (a vector can be inverted into a rough paraphrase, so it counts as content), and `secure_delete` zeroes the pages; a test reads the file. `delete-data` needs nothing new, because the vectors live in `memory.sqlite`.
- **Status.** `debrief status` and `memory_status` show the model id and vector coverage (chunks with current-model vectors / chunks), per repository.
- **Measure again in the PR body:** LongMemEval_S against 0.1.0 and `main`, the code-memory set, recall latency during a fill, `measure:hooks`, the server's RSS with the model loaded and after unload (against the +150 MB target), and a driven run of agents rephrasing their own queries on the misses.

## What would make this not worth it

The strongest case against: LongMemEval_S is chat, most of its gain is in preference questions ("suggest something for my evening"), and those barely exist in coding memory. The code-memory set is only 30 questions, and they were written by the same person who chose the options, with paraphrases deliberately stripped of shared words. The price is real and permanent: about 38 MB per install, about 0.6 GB of resident memory per active session while the model is loaded, tens of minutes of background CPU to backfill a large history, and a model to maintain. The caller is itself a language model. It could expand its own query ("doctor OR physician OR Dr") at no install cost, and that alternative was **not measured**. If a driven run shows agents recovering these misses by rephrasing, meaning search buys little for coding work.

The user decided on 2026-09-30 to build it anyway. The rephrasing run is reported in PR 2's body; it no longer decides whether PR 2 ships.

## Built in PR 2 (2026-10-01)

PR 2 follows this record, with three changes its measurements forced (Apple M4 Pro, Node 25.9, macOS 26; RSS from `ps`, so it includes freed pages macOS has not reclaimed):

| | Planned | Built | Why |
|---|---|---|---|
| Where the model runs | a worker thread in the MCP server, terminated after 2 idle minutes | **a separate process** (`dist/embedder.mjs`), killed after 2 idle minutes; a small proxy thread in the server owns it | terminating the worker left the server 150–270 MB above its pre-load RSS (54 MB bare: 207 MB after `worker.terminate()` with Liftoff, 546 MB with V8's optimizing tier); releasing the ONNX session in-process freed nothing (666 → 663 MB). After the process exits, the server is within 15 MB of where it started |
| V8 tier for ONNX Runtime's WebAssembly | default | **`--liftoff-only`** in the model's process | the optimizing tier compiles about 400 MB of code for ORT's 14 MB module: model loaded, 4 threads, 200 chunks embedded: 710 MB RSS and 62 chunks/s by default, 313 MB and 28 chunks/s Liftoff-only (query p50 3.8 vs 7.5 ms). Vectors are identical either way |
| Records found only by meaning | the vector order over eligible records | **the vector order's best 50** enter the sequence (10 since 2026-10-01, below); keyword matches take their vector rank from the whole order | every eligible record is somewhere in the vector order, so without a bound every recall would carry all of memory (up to 500 records) |

Also added: `DEBRIEF_MEANING_SEARCH=off` turns meaning search off (the model is never loaded), and test servers run with it unless a test asks for meaning search, so suites about something else do not race the background fill. Measured RSS with the model loaded: the server about +14 MB, the model's process about 280–300 MB; after the idle unload, the server about +13 MB and no model process. So the #51 target (+150 MB at peak, about 0 idle) is met when idle and not while the model is loaded (about +300 MB in all).

## Decided on 2026-10-01: records found only by meaning

A calibration on LongMemEval_S and the code-memory set looked for a cosine floor that keeps the answers only meaning finds and drops the noise. There is none. On code memory, the cosine of a true answer found only by meaning and the best such cosine on questions nothing answers overlap completely (AUC 0.455). Of the floors tried (absolute, relative to the best record, per-query z-scores), those that kept all 11 code answers left at most 19 of LongMemEval's 30 abstention questions without such a record on page 1; a cap of 10 left 24. The user accepted three changes instead:

| Decision | Consequence |
|---|---|
| **Cap, not floor: `MEANING_ONLY` = 10** | A record no keyword matches enters only from the vector order's best 10, where keyword matches take places too, so often fewer join. LongMemEval_S R@1/3/5/10 is unchanged (88.1 / 95.7 / 97.6 / 99.3); M1 keeps 6/6, and all 11 code-memory answers that only meaning put in the top 5 stay there. Questions with no answer (LongMemEval's 30 abstention questions) with no such record on page 1: 8 → 24 |
| **Two labels** | `why: meaning`: a record the query's words match that meaning ranked above its keyword place. `why: meaning only`: a record that shares no word with the query, which is weak evidence. A meaning-admitted record that keywords matched beyond the 500 cap is `meaning`, not `meaning only` |
| **An honest miss says so** | When no record matches the query's words and meaning returned records, page 1's notice adds `No record shares words with the query; the N below are only nearest by meaning and may be unrelated.`, N counting that page's items. It follows the pack's own notice and comes before the coverage line. Later pages carry the labels, not the notice: a continuation does not know whether the keyword side was empty, and the tail of a mixed sequence can hold only meaning-only records |

`meaning only` rides the continuation as `RANKED_BY.meaningOnly` = 32, a value rather than a combinable bit: such a record is in no tier (the tiers and trust only order keyword matches) and is not also `meaning`, so it never carries another bit and its base-36 digit is always `w`. Tokens keep version 3: old tokens decode as before, and `sealContinuation` throws on a value that would need a second digit rather than shift every reason after it.

## Decided on 2026-10-01

Two measurements came in after PR 2, and the user decided on them: **meaning search is opt-in**, and **#51 closes** with the RAM target unmet.

**Agents rephrase.** The driven run that "What would make this not worth it" asked for: `claude -p` with Opus (high effort) and Debrief's MCP server on seeded workspaces, keyword-only against meaning on, 3 runs per question, 150 runs in all. Set A and B2 prompts end with "Check memory."; set B prompts are the bare question.

| Set | Keyword only: answer correct | Meaning on: answer correct | Mean recalls per run (keyword / meaning) |
|---|---:|---:|---:|
| A: code memory, questions sharing no word with their answer | 30/30 | 30/30 | 1.57 / 1.83 |
| Control: questions that share words | 9/9 | 9/9 | 1.11 / 1.67 |
| B: LongMemEval-style questions | 12/24 | 12/24 | 0.75 / 0.75 |
| B2: B's four unanswered questions, ending with "Check memory." | 12/12 | 12/12 | 1.25 / 1.42 |

In B every failure, in both conditions, was a run that never called `memory_recall`; no search missed. Replaying every query the agents wrote, in both modes, on identical workspaces: keyword search put the answer on the page for 42 of 43 queries in set A (meaning: 43 of 43), and for every run at least one query did. In every run the agent's **first** query alone found the answer by keywords, because the agent does not search with the user's words: its first query carried a median of 3 to 8 words that were not in the prompt. Meaning search cost about 9% more per run on set A ($0.255 against $0.234), with more recalls. On coding work, as this record's case against it predicted, the agent recovers meaning search's gain by writing its own queries.

**The RAM floor.** A spike measured where the model's process spends its memory and what cuts it (macOS arm64, Node 25.9, Liftoff). About 61–78 MB of WebAssembly linear memory is the load's high-water mark, which WebAssembly never gives back, and ONNX Runtime's 14 MB module is held twice (its bytes and its compiled code). The floor for this runtime and model is about 186 MB RSS loaded and 213 MB at peak, at 1 thread and 8 chunks/s, which is too slow; at 15 chunks/s or more it is about 201 / 227 MB. With the server's +14 MB, that is **about +215 to +245 MB against the +150 MB target: unreachable with WebAssembly** (by physical footprint, which counts no shared or reclaimable pages, about +140 MB in steady state, but still over at peak). Native ONNX Runtime is no smaller (footprint about 155 MB after a fill); its gain is speed. Going lower needs changes outside configuration that were not tried: an ORT-format model, an operator-reduced runtime build, or feeding the model's bytes into the runtime without a JS copy.

The model's process now ships the spike's best trade-off, which changes no vector (bit-identical, pinned by a test):

| Model process | 4 threads, `--liftoff-only` (before) | 3 threads, tuned (now) |
|---|---:|---:|
| RSS loaded / after a 500-chunk fill / peak | 280 / 294 / 294 MB | 213 / 216 / 242–257 MB |
| Physical footprint loaded / peak | 235 / 250 MB | 134 / 167–182 MB |
| Chunks/s (synthetic corpus) / query p50 | 43 / 6.6 ms | 34 / 8.1 ms |
| Server after the idle unload (M20) | +12 MB | +12 MB |

The changes: `MallocSpaceEfficient=1` in the fork's environment on macOS, so libmalloc returns freed pages; the model's file bytes released after the session is created and collected (`--expose-gc`); `--max-semi-space-size=1`; 3 ONNX Runtime threads instead of 4. `--liftoff-only` and 512 tokens stay.

| Decision | Consequence |
|---|---|
| **Meaning search is opt-in.** `DEBRIEF_MEANING_SEARCH=on` turns it on; unset, or any other value, it is off | Off, `debrief mcp` never starts the model or writes a vector, and recall is keyword search's byte for byte. `debrief status` and `memory_status` say `meaning search: off (DEBRIEF_MEANING_SEARCH=on to enable)` and name a value they did not recognise; missing model files are then no problem. The model still ships in the package, so turning it on downloads nothing. This replaces PR 2's `DEBRIEF_MEANING_SEARCH=off` |
| **#51 closes.** +150 MB is out of reach with WebAssembly, and with meaning search off by default nobody pays the +215 MB who did not ask for it | The tuned process above is what an opted-in session pays. Further cuts (an ORT-format model, a reduced runtime build, a native runtime) are new issues if anyone needs them |

**What would make it the default again:** `debrief report --review` showing missed searches caused by mismatched vocabulary, where the answer was in memory and no query the agent wrote shared its words. That is the miss meaning search fixes and rephrasing did not in this run. Measure it on the user's own ratings, then weigh it against the RAM above.
