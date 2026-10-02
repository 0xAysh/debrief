# Benchmarks

Everything here ran on an Apple M4 Pro (12 cores, 24 GB, macOS 26, Node 25.9) unless a section says otherwise. The harnesses, data, models and vectors were throwaway and are not in this repository. Each section names the commit it measured and where the full write-up is.

Some of these results are negative, and two of them changed the product. I kept them in.

## LongMemEval_S retrieval

[LongMemEval](https://github.com/xiaowu0162/LongMemEval) is a public benchmark for long-term chat memory. I used LongMemEval_S (cleaned): 500 questions, each over a haystack of about 40 chat sessions. Under the official rules 419 are scored; abstention questions and questions with no user-side answer turn are skipped.

**Method.** For each question I wrote every haystack session as a Claude Code transcript into a temporary config directory, next to a temporary Git repository. Debrief imported them through its real import path, then `recall` ran with the question and followed continuations. Records map back to sessions through their source transcript. The score is session-level recall_any@k, from LongMemEval's own `evaluate_retrieval`. The reference BM25 is `rank_bm25.BM25Okapi`, once with the official whitespace split and once lowercase-tokenized.

| Retriever | R@1 | R@3 | R@5 | R@10 |
|---|---|---|---|---|
| BM25, official whitespace split | 70.6 | 84.5 | 88.8 | 92.6 |
| BM25, lowercase-tokenized | 82.8 | 93.8 | 94.7 | 96.7 |
| Debrief 0.1.0, as shipped (user and assistant text) | 84.2 | 90.5 | 93.6 | 95.7 |
| Debrief 0.1.0, user turns only (the official protocol) | 82.1 | 91.4 | 95.0 | 96.9 |
| Debrief keyword search after the ranking work (`0acf20f`) | 85.7 | 92.4 | 94.3 | 96.2 |
| + meaning search, snowflake-arctic-embed-xs fused (spike) | 90.2 | 95.0 | 98.1 | 99.3 |
| + meaning search as shipped (at most 10 records found only by meaning) | 88.1 | 95.7 | 97.6 | 99.3 |
| bge-small-en-v1.5 fused (best small model, not shipped) | 89.5 | 96.7 | 98.8 | 99.5 |

- Debrief 0.1.0 is statistically the same as a correctly tokenized BM25. Each one gets 6–7 questions the other misses.
- Every keyword-search miss was a vocabulary mismatch: "doctors" against "Dr. Patel", "photography setup" against "Sony A7R IV".
- Meaning search mostly helps preference questions ("suggest something for my evening"): R@5 on those went from 63.3 to 90.0. Those barely exist in coding memory.
- Sanity check on the harness: MiniLM vectors alone over user messages score R@5 96.4. MemPalace reports 96.6 for raw MiniLM under its own protocol (all 500 questions).

Sources: [#49](https://github.com/0xAysh/debrief/issues/49) for 0.1.0 and BM25, [ADR 0001](adr/0001-meaning-search.md#recall-longmemeval_s) for the rest, with every model tried.

## Code memory

LongMemEval is chat, not code. So I wrote 50 records for one fictional payments service (decisions, observations, file paths, identifiers, error strings) and 30 questions over them: 17 paraphrases that share no content words with their answer, 4 identifier lookups, 2 prose-to-identifier, 1 error string, 3 lexical controls and 3 stale/current pairs. Numbers are counts out of 30.

| Retriever | R@1 | R@3 | R@5 | paraphrases in top 3 | identifiers in top 3 |
|---|---|---|---|---|---|
| Keyword search | 15 | 23 | 25 | 10/17 | 4/4 |
| arctic-embed-xs, vectors only | 23 | 28 | 28 | 16/17 | 4/4 |
| arctic-embed-xs, fused (shipped) | 21 | 26 | 27 | 13/17 | 4/4 |

- This set is small, and I wrote the questions myself with the shared words stripped on purpose. Read it as a check that meaning search does not hurt identifiers, not as a score.
- Fusion buries an answer that only meaning finds. "Why is there no message broker anymore?" finds "We dropped Redis for the queue" in the top 3 by vectors alone, but 14th to 31st once fused, depending on the model.
- Meaning does not tell current from stale. Near-identical text gets near-identical vectors, so a replaced record and its replacement both come back.

Source: [ADR 0001](adr/0001-meaning-search.md#recall-code-memory).

## Real agent runs

Retrieval scores assume the question is the query. A real agent writes its own queries, so I ran Claude Code headless (`claude -p`, Opus, high effort) with Debrief's MCP server on seeded workspaces. Each question ran 3 times with keyword search only and 3 times with meaning search on: 150 runs in all. Sets A and B2 end their prompt with "Check memory."; set B is the bare question.

| Set | Keyword only: answer correct | Meaning on: answer correct | Mean recalls per run (keyword / meaning) |
|---|---:|---:|---:|
| A: code memory, questions sharing no word with their answer | 30/30 | 30/30 | 1.57 / 1.83 |
| Control: questions that share words | 9/9 | 9/9 | 1.11 / 1.67 |
| B: LongMemEval-style questions | 12/24 | 12/24 | 0.75 / 0.75 |
| B2: B's four unanswered questions, ending with "Check memory." | 12/12 | 12/12 | 1.25 / 1.42 |

- In set B every failure, in both modes, was a run that never called `memory_recall`. No search missed.
- In every run the agent's first query alone found the answer by keywords. The agent does not search with the user's words: its first query carried a median of 3 to 8 words that were not in the prompt.
- Meaning search cost about 9% more per run on set A ($0.255 against $0.234), because the agent recalled more.

This is why meaning search is opt-in. The real problem is set B: the agent not searching when a question sounds general.

Source: [ADR 0001](adr/0001-meaning-search.md#decided-on-2026-10-01).

### Compact index vs full packs

Claude Code 2.1.284 headless, `claude-opus-5-5`, high effort, with personal config isolated. The memory held 78 hand-written records over 6 sessions. The reason for a decision was planted in a message that shares no words with the question, and the decision itself was recorded 4 records later with no citation back. The prompt was the same in every run: *"Why did we change how retries back off? Check project memory."* 3 runs per condition.

| | Compact index, then `memory_read` with `around` | Full packs only |
|---|---|---|
| Reached the planted reason | 3 of 3 | 0 of 3 |
| Answer | correct 3 of 3 | partial 3 of 3 |
| Median recall tokens | 2,905 | 6,343 |
| Median session tokens | 20,591 | 26,117 |

The model found `around` from the tool descriptions alone. No run called `memory_checkpoint` (0 of 6). One scenario, one model, n = 3, so this shows the workflow works, not how often.

Source: [#53](https://github.com/0xAysh/debrief/issues/53).

### Crash recovery

After a session was killed without a checkpoint, the next session starts with one line pointing at it. Real Claude (Opus) called `memory_bootstrap` on that pointer in 3 of 3 runs, each time before reading code or editing.

Source: [#74](https://github.com/0xAysh/debrief/pull/74).

## Session start size

`sessionStart().context` in bytes, on the same hand-written scenarios, before and after the start stopped carrying work context. Tokens are bytes ÷ 4.

| Scenario | Before | After | ≈ tokens |
|---|---:|---:|---|
| empty repository (import question pending) | 2,851 | 2,830 | 713 → 708 |
| 1 note, 1 preference | 2,817 | 2,467 | 704 → 617 |
| 60 notes, 1 preference | 4,340 | 2,469 | 1,085 → 617 |
| checkpoint, 60 notes, 1 preference | 4,290 | 2,552 | 1,073 → 638 |
| crashed session (no checkpoint), 60 notes, 1 preference | 4,865 | 2,549 | 1,216 → 637 |
| full checkpoint, turns after it, 60 notes, 1 preference | 5,624 | 2,605 | 1,406 → 651 |

The start no longer grows with memory. Only the preferences (at most 4 KB) and one line vary.

Source: [#74](https://github.com/0xAysh/debrief/pull/74).

## Freshness of imported file reads

A memory imported from an old transcript often rests on a file the agent read. I measured two ways to tell whether that read still holds, on my own local Claude Code and Codex history (not committed):

- prove the read against Git history;
- fingerprint the exact text the transcript shows the agent read (shipped).

| | Git-history proof | Fingerprint the read text (shipped) |
|---|---|---|
| Claude Code reads that can be checked | 6.8% | 37.7% (27.1% after the edit rule) |
| Codex reads that can be checked | 40.9%, only because old reflogs were not pruned yet | 75.7% (39.5% after the edit rule) |
| Correctness | 2 wrong proofs of 54 (Claude Code), 0 of 391 (Codex) | the rebuilt text matched a committed version in 206 of 206 spot-checks |

The edit rule: if the same session edits the file after reading it, that read no longer backs later claims. Without it, 14 Claude Code reads and 25 Codex reads would have been labelled `current` while the claim rested on edited code.

The gain is modest. Mostly `unknown` becomes `stale`. About 16–22% of the fingerprinted reads come out `current`. On a worst-case workload where every record is a read, recall with a query got about 5 ms slower at p50 (+7%).

Sources: [#54](https://github.com/0xAysh/debrief/issues/54), [#65](https://github.com/0xAysh/debrief/pull/65).

## Meaning search: memory and speed

The model is snowflake-arctic-embed-xs (int8, 384 dimensions) on ONNX Runtime's WebAssembly build. It ships inside the npm package, so nothing is downloaded at run time.

| Where the model runs | Resident memory, model loaded |
|---|---|
| First spike: inside the MCP server, 4 threads, V8's default tier | about 660 MB |
| A separate process killed after 2 idle minutes, 4 threads, `--liftoff-only` | 280 MB |
| Shipped: 3 threads, macOS malloc told to return freed pages, model bytes freed after load, 1 MB semi-space | 213 MB |

- `--liftoff-only` was the biggest single cut. V8's optimizing tier compiled about 400 MB of code for ONNX Runtime's 14 MB module: 710 MB against 313 MB with 200 chunks embedded.
- After the idle unload, the server sits about 12 MB above where it started.
- The shipped process embeds about 34 chunks/s (synthetic corpus), with a query p50 of 8.1 ms. Vectors are bit-identical to the untuned process's, and a test pins them.
- My target was +150 MB at peak. At a usable speed this runtime and model need about 200 MB loaded and 227 MB at peak, so the target is out of reach with WebAssembly. By physical footprint, native ONNX Runtime is no smaller (about 155 MB after a fill); its gain is speed.

Vector search is a brute-force scan; sqlite-vec was slower at every size:

| Chunks | In-memory JS scan, f32 | sqlite-vec `vec0` | Scan of SQLite BLOBs |
|---|---|---|---|
| 10k | 3.8 ms | 6.2 ms | 11.9 ms |
| 100k | 41.2 ms | 62.5 ms | 129 ms |
| 250k | 105 ms | 155 ms | 352 ms |

Stored as int8, vectors add about 7.5 MB per 10k records.

Source: [ADR 0001](adr/0001-meaning-search.md#runtime).

## Negative results

- No similarity floor separates real answers from noise. On code memory, the cosine of a true answer that only meaning finds overlaps completely with the best cosine on questions nothing answers (AUC 0.455). So meaning-only records are capped at 10 and labelled `meaning only` instead.
- A code-trained embedding model made things worse. jina-embeddings-v2-base-code, fused, scored LongMemEval R@5 93.1, below keyword search alone (94.3). It was no better on code memory, at seven times the size.
- Meaning search did not help a real agent on code memory (above). It is opt-in for that reason.
- The native runtime lost on distribution, not speed. onnxruntime-node has about 4.4 times the throughput, but it is 287 MB installed on every platform, has had no Intel Mac build since February 2026, and downloads a 236 MB CUDA package in a linux-x64 `postinstall`.

Source: [ADR 0001](adr/0001-meaning-search.md).
