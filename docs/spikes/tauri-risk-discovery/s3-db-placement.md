# S3: DB Placement — Findings

## Metadata
- **Spike:** Spike 0 — Tauri Risk Discovery
- **Sub-spike:** S3 — DB Placement
- **Date:** [To be filled during S3 execution]
- **Runner:** Claude Code (autonomous) + Kaan (checkpoint review)
- **Commit:** [spike branch commit]
- **Duration:** [hours]

## Hypothesis

`rusqlite` + custom Tauri commands (Option A) outperform
`@tauri-apps/plugin-sql` (Option B) measurably in memry's 1000-note list
rendering and vector similarity queries. Hybrid (Option C) balances dev
velocity (Drizzle schemas preserved) with performance (Rust-owned critical
paths).

**Null hypothesis:** Performance delta between A and B is negligible → Option B's
simpler setup wins on pragmatic grounds.

## TL;DR — Decision

[🟢 Option A / 🟡 Option C (hybrid) / 🔴 Option B] — [To be filled]

[2-3 sentence summary]

## Setup

- Option A: rusqlite + custom Tauri commands (sync API, 50-80 commands)
- Option B: `@tauri-apps/plugin-sql` (sqlx async, SQL from renderer)
- Option C: Hybrid (Rust owns schema+migrations, mixed query access)
- sqlite-vec bundled for all three

## Test matrix results

| # | Test | Option A | Option B | Option C |
|---|------|----------|----------|----------|
| 1 | 1000-note list (p50 ms) | [pending] | [pending] | [pending] |
| 2 | Single-note get by id (p95 ms) | [pending] | [pending] | [pending] |
| 3 | Bulk insert 1000 (elapsed ms) | [pending] | [pending] | [pending] |
| 4 | sqlite-vec kNN 10k, k=10 (ms) | [pending] | [pending] | [pending] |
| 5 | Full-text search (ms) | [pending] | [pending] | [pending] |
| 6 | Blob R/W 50KB (roundtrip ms) | [pending] | [pending] | [pending] |
| 7 | Migration run 0001-0020+ (ms) | [pending] | [pending] | [pending] |
| 8 | Bundle size delta vs baseline (MB) | [pending] | [pending] | [pending] |
| 9 | Cold startup (ms) | [pending] | [pending] | [pending] |
| 10 | Concurrent access (5r+1w WAL) | [pending] | [pending] | [pending] |

## Benchmark data

See `benchmarks/s3-query-latency.json` for raw data.

## Observations

[sqlite-vec loading quirks, plugin-sql async behavior, command authoring scale —
filled during execution]

## Decision + rationale

[Verdict + justification]

## Subsequent subproject impact

- **Subproject 2 (DB + CRUD):** built on [A | B | C]
- **Subproject 4 (Sync engine):** query layer uses [approach]
- **Subproject 6 (Search + embeddings):** sqlite-vec accessed via [approach]

## Open questions carried forward

- Linux WebKit2GTK sqlite-vec loading (deferred to Subproject 7)
- Drizzle migration generation bug persists for B/C (MEMORY.md reference)

## References

- rusqlite: https://github.com/rusqlite/rusqlite
- @tauri-apps/plugin-sql: https://v2.tauri.app/plugin/sql/
- sqlite-vec: https://github.com/asg017/sqlite-vec
- [Issues referenced during execution]
