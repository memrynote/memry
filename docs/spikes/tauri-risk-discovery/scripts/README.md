# Spike 0 Benchmark Scripts

Reproducible runners for Spike 0 benchmarks. All write output to
`../benchmarks/<name>.json` with schema version 1.

## Prerequisites

- pnpm installed at monorepo root
- Rust 1.85+ with cargo
- macOS (Windows partial support for S1)

## Running

```bash
# Environment snapshot (run before other benchmarks)
pnpm exec tsx collect-environment.ts

# S1: BlockNote + WKWebView feature matrix
pnpm exec tsx bench-webview-blocknote.ts

# S2: Yjs roundtrip latency (Prototype A vs B)
pnpm exec tsx bench-yjs-roundtrip.ts

# S3: DB query latency (3 options)
pnpm exec tsx bench-db-query.ts

# S3: Bundle size delta (3 options) — runs `pnpm tauri build` per prototype (~3-5 min each)
pnpm exec tsx bench-db-bundle-size.ts
```

### S3 harness notes

`bench-db-query.ts` launches `pnpm tauri dev` per prototype. Each prototype's
renderer auto-runs the bench on mount (see `prototypes/s3-*/src/bench.ts`) and
dumps results to `/tmp/s3-<OPTION>-results.json` via a Rust command. The
orchestrator polls for the file, then kills the process and moves on.

Limitations of the current harness:
- Sub-millisecond test resolution is bounded by WebKit's `performance.now()`
  (rounded to 1ms in some contexts) — affects test-2 (single-note get).
- Test-6 (50KB blob R/W) reflects Tauri JSON IPC overhead for `Vec<u8>` —
  data is serialized as `[123, 45, ...]` JSON arrays, not raw bytes. Real
  apps using `tauri::ipc::Response` with `Vec<u8>` body avoid this; bench
  uses default invoke for symmetry.
- Tests #7 (migration cold), #9 (cold startup), #10 (concurrent access) are
  documented as deferred in the findings, not auto-run by the orchestrator.

## Output format

See `../benchmarks/environment.json` for schema example. All outputs include:
- `schema_version: 1`
- `environment` (OS, runtimes, libraries)
- `runs` (per-test data)
- `notes` (anomalies)

## After spike cleanup

Spike prototype code in `spikes/tauri-risk-discovery/` was deleted. To
re-run benchmarks, re-scaffold prototypes using the spec's Section 5 setup
instructions or any equivalent Tauri + BlockNote scaffold.
