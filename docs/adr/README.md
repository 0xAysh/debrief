# Architecture decision records

Decisions that are hard to reverse, would surprise a reader of the code, and came out of a real trade-off. Each record says what was decided, why, and what was rejected. [architecture.md](../architecture.md) describes how Debrief works now; a record here explains why it works that way.

| # | Decision | Status |
|---|---|---|
| [0001](0001-meaning-search.md) | Meaning search: bundled WASM embedder, int8 vectors in SQLite, brute-force scan, fused into page 1's frozen order | proposed |
