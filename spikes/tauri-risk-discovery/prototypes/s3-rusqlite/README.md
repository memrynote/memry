# s3-rusqlite — S3 Option A Prototype

**Spike 0 / S3 / Option A:** Tauri 2.x app with `rusqlite` + custom Tauri commands.

## Architecture

- All DB ops live in Rust (`src-tauri/src/db_a.rs`).
- Renderer (React) calls Tauri commands via `invoke()`.
- Connection pool: `Mutex<Connection>` behind `tauri::State`.
- sqlite-vec loaded via `rusqlite::load_extension` (macOS `.dylib`).
- Drizzle abandoned; migrations are hand-written SQL run by Rust.

## Build / Run

```bash
pnpm install --ignore-workspace   # avoid memry workspace pollution
pnpm tauri dev                    # dev mode (Vite + Rust hot-reload)
pnpm tauri build --release        # production binary (for bundle-size test)
```

## Test (S3 bench)

```bash
pnpm exec playwright test         # bench tests in tests/bench/
```

Bench results go to `/tmp/s3-A-test-<n>.json`. Aggregated by
`docs/spikes/tauri-risk-discovery/scripts/bench-db-query.ts`.

## See also

- Spec: `docs/superpowers/specs/2026-04-23-spike-0-tauri-risk-discovery-design.md` Section 5.3
- Plan: `docs/superpowers/plans/2026-04-24-spike-0-tauri-risk-discovery.md` Phase 3
- Findings: `docs/spikes/tauri-risk-discovery/s3-db-placement.md`
