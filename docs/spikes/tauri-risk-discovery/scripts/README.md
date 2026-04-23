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
```

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
