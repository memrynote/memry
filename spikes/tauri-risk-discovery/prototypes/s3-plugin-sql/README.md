# s3-plugin-sql — S3 Option B Prototype

**Spike 0 / S3 / Option B:** Tauri 2.x app with `@tauri-apps/plugin-sql` (sqlx backed).

## Architecture

- Renderer queries SQLite directly via `Database.load('sqlite:...')`.
- Migrations registered Rust-side via `tauri_plugin_sql::Builder::default().add_migrations(...)`.
- No custom Tauri commands for DB ops (plugin handles routing).
- sqlite-vec extension loading: plugin-sql v2.1+ supports it via sqlx connect options.

## Build / Run

```bash
pnpm install --ignore-workspace
pnpm tauri dev
pnpm tauri build --release
```

## Test (S3 bench)

```bash
pnpm exec playwright test
```

## See also

- Spec: `docs/superpowers/specs/2026-04-23-spike-0-tauri-risk-discovery-design.md` Section 5.3
- Plan: `docs/superpowers/plans/2026-04-24-spike-0-tauri-risk-discovery.md` Phase 3
- Findings: `docs/spikes/tauri-risk-discovery/s3-db-placement.md`
