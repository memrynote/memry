# S2: Yjs Placement — Findings

## Metadata
- **Spike:** Spike 0 — Tauri Risk Discovery
- **Sub-spike:** S2 — Yjs Placement
- **Date:** [To be filled during S2 execution]
- **Runner:** Claude Code (autonomous) + Kaan (checkpoint review)
- **Commit:** [spike branch commit]
- **Duration:** [hours]

## Hypothesis

`yrs 0.21` is byte-compatible enough with Yjs 13.6 that Prototype B (JS Yjs in
renderer + yrs authoritative in Rust) preserves BlockNote's y-prosemirror
binding behavior.

**Null hypothesis (red):** yrs mishandles BlockNote's Y.XmlFragment nested
block structure or mark encoding — divergent state → data loss. Prototype A
wins by default.

**Note:** Prototype C (ywasm) rejected without spike based on y-crdt parity
table — observer API explicitly marked "incompatible with yjs", which would
break y-prosemirror binding.

## TL;DR — Decision

[🟢 Prototype B wins / 🟡 A+B hybrid / 🔴 Prototype A wins] — [To be filled]

[2-3 sentence summary]

## Setup

- Prototype A: `spikes/tauri-risk-discovery/prototypes/s2-yjs-renderer/`
- Prototype B: `spikes/tauri-risk-discovery/prototypes/s2-yjs-rust/`
- Yjs 13.6.x (JS), yrs 0.21.x (Rust)
- BlockNote 0.47.x + y-prosemirror 1.3.x in both

## Test matrix results

| # | Test | Prototype A | Prototype B | Delta |
|---|------|-------------|-------------|-------|
| 1 | Single-device roundtrip | [pending] | [pending] | |
| 2 | Nested block | [pending] | [pending] | |
| 3 | Mark encoding (bold+italic+code overlap) | [pending] | [pending] | |
| 4 | Two-device merge | [pending] | [pending] | |
| 5 | State vector size (1000 ops) | [pending] | [pending] | |
| 6 | Update binary size (single char insert) | [pending] | [pending] | |
| 7 | Compaction (1000 updates → snapshot) | [pending] | [pending] | |
| 8 | Origin filtering (B only) | N/A | [pending] | |

## Benchmark data

See `benchmarks/s2-roundtrip-latency.json` for raw data.

Key numbers:
- Typing latency p50/p95: A [pending] / B [pending] ms
- Update binary size: A [pending] / B [pending] bytes
- Snapshot compaction: A [pending] / B [pending] bytes

## Observations

[yrs quirks, y-prosemirror compat issues, origin filtering behavior —
filled during execution]

## Decision + rationale

[Verdict + justification]

## Subsequent subproject impact

- **Subproject 2 (DB):** CRDT updates parsed by [JS | Rust] layer
- **Subproject 5 (CRDT):** [Rust-authoritative | renderer-authoritative | hybrid]
- **Subproject 6 (sync):** [unchanged — server remains encrypted blob store]

## Open questions carried forward

- yrs compaction performance on 100k+ operation documents (deferred to Subproject 5)
- Data migration from existing y-leveldb Y.Docs to new architecture (deferred)

## References

- y-crdt parity table: https://github.com/y-crdt/y-crdt
- y-prosemirror observer pattern: https://github.com/yjs/y-prosemirror
- yrs crate docs: https://docs.rs/yrs/latest/yrs/
- [Issues referenced during execution]
