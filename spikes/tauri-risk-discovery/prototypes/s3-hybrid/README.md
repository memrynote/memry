# s3-hybrid — S3 Option C Prototype

**Spike 0 / S3 / Option C:** Tauri 2.x app with hybrid DB layer.

## Architecture

- **Hot paths in Rust** (rusqlite + custom commands): vector search, FTS, transactions.
- **Simple CRUD via plugin-sql** (renderer): `SELECT *`, `WHERE id = ?`, etc.
- **Single SQLite file** opened by both layers (WAL mode → multi-reader / single-writer).
- Drizzle preserved as schema source-of-truth; Rust structs codegen'd from Drizzle later (out of spike scope; manual structs for now).

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
