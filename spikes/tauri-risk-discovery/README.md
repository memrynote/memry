# Spike 0 — Throwaway Code

**⚠️ This directory is temporary.**

Code here will be deleted at the end of Spike 0. Permanent artifacts
(findings, benchmarks, scripts) live in `docs/spikes/tauri-risk-discovery/`.

## Structure

- `app/` — main Tauri 2.x app used for S1 (BlockNote-WKWebView) and S3 (DB placement)
- `prototypes/s2-yjs-renderer/` — S2 Prototype A (renderer-owned Y.Doc)
- `prototypes/s2-yjs-rust/` — S2 Prototype B (yrs in Rust)

## Why this is outside pnpm workspace

`pnpm-workspace.yaml` excludes `spikes/**`. This dir has its own isolated
`package.json` and Cargo manifest. Install deps per-subdir:
`cd spikes/tauri-risk-discovery/app && pnpm install && cargo build`.

## Lifecycle

1. Scaffold via `pnpm create tauri-app` (Task 12 of implementation plan)
2. Integrate BlockNote, Yjs, rusqlite per phase tasks
3. Run benchmarks, produce findings in `docs/spikes/tauri-risk-discovery/`
4. Delete at end of spike (Phase 5 cleanup)
