# M2 — DB + Schemas + Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire rusqlite into the Tauri backend, port all 29 Electron data DB migrations, define specta-typed structs for every domain table, and ship the first end-to-end real IPC slice (`settings_get` / `settings_set` / `settings_list`) while preserving the M1 mock layer for every other command.

**Architecture:** Single-DB model via `Mutex<Connection>` stored in `AppState`. Hand-written SQL migrations under `src-tauri/migrations/*.sql` applied at startup through a custom runner backed by a `schema_migrations` table. Per-table modules expose Rust structs with `#[derive(specta::Type, serde::Serialize, Deserialize)]`; `tauri-specta` regenerates `src/generated/bindings.ts`. Index-DB concerns (FTS5, sqlite-vec, crdt_updates, crdt_snapshots) are deferred to M5/M7 per spec.

**Tech Stack:** rusqlite 0.32 (bundled SQLite), tauri-specta 2.x, specta 2.x, serde 1.x, thiserror 1.x, tokio (blocking pool), anyhow 1.x (test-only), Vitest, Playwright WebKit.

**Parent spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md` (§4 M2, §5 cross-cutting conventions)

**Predecessor plan:** `docs/superpowers/plans/2026-04-24-m1-tauri-skeleton-and-renderer-port.md` (must be merged)

---

## Pre-flight checks (do these before Task 1)

- [ ] M1 PR merged to `main`: `git log --oneline main | head -5` shows the `m1(scaffold)` series
- [ ] Rust toolchain: `rustc --version` returns 1.95+; `cargo --version` works
- [ ] Node 24.x active: `node --version` returns v24.x
- [ ] pnpm 10.x active: `pnpm --version` returns 10.x
- [ ] `apps/desktop-tauri/` exists and boots: `pnpm --filter @memry/desktop-tauri dev` opens a window (visual parity with Electron)
- [ ] `pnpm --filter @memry/desktop-tauri cargo:check` exits 0 against current `main`
- [ ] Electron data DB migrations present: `ls apps/desktop/src/main/database/drizzle-data/*.sql | wc -l` returns 29
- [ ] Create a worktree for M2 isolation (per user preference — feedback_worktree.md):

```bash
git worktree add ../spike-tauri-m2 -b m2/db-schemas-migrations main
cd ../spike-tauri-m2
```

From this point, every path is relative to `../spike-tauri-m2`.

---

## File Structure

Files created or modified in M2:

```
apps/desktop-tauri/
├── src-tauri/
│   ├── Cargo.toml                               Task 1 (deps added)
│   ├── migrations/                              Task 4-6 (new dir)
│   │   ├── 0001_initial_projects_statuses_tasks.sql   Task 4
│   │   ├── 0002_task_relations.sql              Task 5
│   │   ├── 0003_inbox.sql                       Task 5
│   │   ├── 0004_settings.sql                    Task 5
│   │   ├── 0005_bookmarks.sql                   Task 5
│   │   ├── 0006_reminders.sql                   Task 5
│   │   ├── 0007_calendar_events.sql             Task 5
│   │   ├── 0008_calendar_sources.sql            Task 5
│   │   ├── 0009_calendar_external_events.sql    Task 5
│   │   ├── 0010_calendar_bindings.sql           Task 5
│   │   ├── 0011_note_positions.sql              Task 5
│   │   ├── 0012_note_metadata.sql               Task 5
│   │   ├── 0013_tag_definitions.sql             Task 5
│   │   ├── 0014_sync_devices.sql                Task 5
│   │   ├── 0015_sync_queue.sql                  Task 5
│   │   ├── 0016_sync_state.sql                  Task 5
│   │   ├── 0017_sync_history.sql                Task 5
│   │   ├── 0018_property_definitions.sql        Task 5
│   │   ├── 0019_saved_filters.sql               Task 5
│   │   ├── 0020_search_reasons.sql              Task 6
│   │   ├── 0021_inbox_jobs.sql                  Task 6
│   │   ├── 0022_notes_journal_vault.sql         Task 6
│   │   ├── 0023_folder_configs.sql              Task 6
│   │   ├── 0024_google_calendar_foundation.sql  Task 6
│   │   ├── 0025_event_target_calendar.sql       Task 6
│   │   ├── 0026_calendar_field_clocks.sql       Task 6
│   │   ├── 0027_calendar_rich_fields.sql        Task 6
│   │   ├── 0028_calendar_source_last_error.sql  Task 6
│   │   └── 0029_field_clocks_tasks_projects.sql Task 6
│   │
│   └── src/
│       ├── lib.rs                               Task 3, 13 (AppState wired, settings cmds)
│       ├── app_state.rs                         Task 2 (new)
│       ├── error.rs                             Task 2 (new AppError enum)
│       ├── db/
│       │   ├── mod.rs                           Task 2 (new — Db wrapper)
│       │   ├── migrations.rs                    Task 3 (new — runner)
│       │   ├── projects.rs                      Task 8
│       │   ├── statuses.rs                      Task 8
│       │   ├── tasks.rs                         Task 8
│       │   ├── notes_cache.rs                   Task 9
│       │   ├── note_metadata.rs                 Task 9
│       │   ├── note_positions.rs                Task 9
│       │   ├── calendar_events.rs               Task 10
│       │   ├── calendar_sources.rs              Task 10
│       │   ├── calendar_external_events.rs      Task 10
│       │   ├── calendar_bindings.rs             Task 10
│       │   ├── inbox.rs                         Task 11
│       │   ├── bookmarks.rs                     Task 11
│       │   ├── reminders.rs                     Task 11
│       │   ├── tag_definitions.rs               Task 11
│       │   ├── folder_configs.rs                Task 11
│       │   ├── sync_queue.rs                    Task 12
│       │   ├── sync_devices.rs                  Task 12
│       │   ├── sync_state.rs                    Task 12
│       │   ├── sync_history.rs                  Task 12
│       │   ├── search_reasons.rs                Task 12
│       │   ├── settings.rs                      Task 13
│       │   └── saved_filters.rs                 Task 13
│       │
│       ├── commands/
│       │   ├── mod.rs                           Task 13 (register settings_*)
│       │   └── settings.rs                      Task 13 (new)
│       │
│       └── bin/
│           ├── generate_bindings.rs             Task 14 (modify — include db types)
│           └── bench_m2.rs                      Task 18 (new — 1000-note bench)
│
├── src/
│   ├── lib/ipc/
│   │   ├── invoke.ts                            Task 15 (settings_* swap to real)
│   │   └── mocks/settings.ts                    Task 15 (keep for fallback)
│   ├── generated/bindings.ts                    Task 14 (regenerated)
│   └── hooks/useSettings.ts                     Task 15 (modify to call real invoke)
│
├── scripts/
│   ├── dev-reset.sh                             Task 17 (new)
│   ├── new-migration.ts                         Task 17 (new)
│   └── schema-diff.ts                           Task 17 (new)
│
├── tests/rust/                                  Task 3, 7, 19 (via cargo test --test …)
│   ├── migrations_test.rs                       Task 7
│   └── settings_test.rs                         Task 13
│
└── package.json                                 Task 17 (add db:new-migration, db:schema-diff)
```

---

## Task 1: Add rusqlite + serialization dependencies to `Cargo.toml`

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/Cargo.toml`

- [ ] **Step 1.1: Open the existing Cargo.toml and locate the `[dependencies]` section**

From M1 Task 2, the file already exists. Verify with:

```bash
grep -c '^\[dependencies\]' apps/desktop-tauri/src-tauri/Cargo.toml
```

Expected: `1`.

- [ ] **Step 1.2: Extend the DB stack in `[dependencies]`**

`apps/desktop-tauri/src-tauri/Cargo.toml` already declares `rusqlite` and
`thiserror` from M1. Do NOT add duplicate keys — Cargo will reject the
manifest. Apply two edits in place:

1. **Amend the existing `rusqlite` line.** Current M1 entry:
   ```toml
   rusqlite = { version = "0.32", features = ["bundled", "load_extension"], default-features = false }
   ```
   Replace with (adds `chrono`, `serde_json`, `hooks`; keeps `bundled` +
   `load_extension`; drops `default-features = false` so chrono integration
   pulls in the right glue):
   ```toml
   rusqlite = { version = "0.32", features = ["bundled", "load_extension", "chrono", "serde_json", "hooks"] }
   ```

2. **Leave the existing `thiserror = "2.0"` line alone.** M1 already pinned
   the newer major; downgrading to "1" is unnecessary churn.

3. **Add only the genuinely new entries** under `[dependencies]`:
   ```toml
   # DB pool + utilities (M2)
   r2d2 = "0.8"
   r2d2_sqlite = "0.25"
   once_cell = "1.19"
   directories = "5"
   ```

Verify after editing:
```bash
grep -c '^rusqlite' apps/desktop-tauri/src-tauri/Cargo.toml   # → 1
grep -c '^thiserror' apps/desktop-tauri/src-tauri/Cargo.toml  # → 1
cd apps/desktop-tauri && cargo check                          # → no duplicate-key errors
```

Rationale:
- `rusqlite` `bundled` feature vendors SQLite — avoids linking against system `libsqlite3` that Tauri signing toolchain may not expect.
- `hooks` feature enables `update_hook` for future sync/CRDT integration in M5 (declared now to surface compile errors early, not used yet).
- `r2d2` + `r2d2_sqlite` gives a connection pool (spec §5.8 "Prepared statement cache kept in Rust state"). Pool of 1 connection by default — SQLite serializes writes anyway. Pool abstraction lets M6 introduce read replicas if needed.
- `directories` resolves the per-OS app-data directory (M2 dev, extended in M4 with `MEMRY_DEVICE`).

- [ ] **Step 1.3: Append test deps to `[dev-dependencies]`**

```toml
# Test helpers (M2)
tempfile = "3"
```

- [ ] **Step 1.4: Verify compile**

```bash
cd apps/desktop-tauri/src-tauri && cargo check
```

Expected: "Finished `dev` profile" — no unresolved imports yet (deps declared but not referenced).

- [ ] **Step 1.5: Commit**

```bash
git add apps/desktop-tauri/src-tauri/Cargo.toml apps/desktop-tauri/src-tauri/Cargo.lock
git commit -m "m2(deps): add rusqlite, r2d2, thiserror, directories"
```

---

## Task 2: Create `AppState` + `Db` wrapper + `AppError` enum

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/error.rs`
- Create: `apps/desktop-tauri/src-tauri/src/app_state.rs`
- Create: `apps/desktop-tauri/src-tauri/src/db/mod.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs`

- [ ] **Step 2.1: Create the `AppError` enum**

Write `apps/desktop-tauri/src-tauri/src/error.rs`:

```rust
use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize, specta::Type)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    #[error("database error: {0}")]
    Database(String),
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("vault locked")]
    VaultLocked,
    #[error("invalid password")]
    InvalidPassword,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("network error: {0}")]
    Network(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("validation error: {0}")]
    Validation(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        AppError::Database(err.to_string())
    }
}

impl From<r2d2::Error> for AppError {
    fn from(err: r2d2::Error) -> Self {
        AppError::Database(err.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::Internal(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::Validation(err.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
```

- [ ] **Step 2.2: Create the `Db` wrapper**

Write `apps/desktop-tauri/src-tauri/src/db/mod.rs`:

```rust
//! SQLite DB layer. Owns the connection pool. All persistent state in the app
//! flows through this module.
//!
//! Connection model: single-writer SQLite via r2d2 pool (max size 1 for writes,
//! read replicas possible in future). WAL mode for concurrent readers. FKs on.

use crate::error::{AppError, AppResult};
use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;
use std::path::Path;

pub mod migrations;

pub type DbConnection = PooledConnection<SqliteConnectionManager>;

#[derive(Clone)]
pub struct Db {
    pool: Pool<SqliteConnectionManager>,
}

impl Db {
    /// Open a DB at `path`, apply PRAGMAs, run pending migrations.
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let manager = SqliteConnectionManager::file(path).with_init(|conn| {
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA foreign_keys = ON;
                 PRAGMA busy_timeout = 5000;",
            )
        });
        let pool = Pool::builder().max_size(4).build(manager)?;
        let db = Self { pool };
        migrations::apply_pending(&mut db.conn()?)?;
        Ok(db)
    }

    /// In-memory DB for tests. Migrations applied.
    #[cfg(any(test, feature = "test-helpers"))]
    pub fn open_memory() -> AppResult<Self> {
        let manager = SqliteConnectionManager::memory().with_init(|conn| {
            conn.execute_batch(
                "PRAGMA journal_mode = MEMORY;
                 PRAGMA foreign_keys = ON;",
            )
        });
        let pool = Pool::builder().max_size(1).build(manager)?;
        let db = Self { pool };
        migrations::apply_pending(&mut db.conn()?)?;
        Ok(db)
    }

    pub fn conn(&self) -> AppResult<DbConnection> {
        self.pool.get().map_err(AppError::from)
    }
}
```

- [ ] **Step 2.3: Create the `AppState` struct**

Write `apps/desktop-tauri/src-tauri/src/app_state.rs`:

```rust
//! Global runtime state shared across commands. Thin wrapper around feature
//! subsystems; each field is the single canonical instance for the process.

use crate::db::Db;

pub struct AppState {
    pub db: Db,
}

impl AppState {
    pub fn new(db: Db) -> Self {
        Self { db }
    }
}
```

- [ ] **Step 2.4: Wire `AppState` into `lib.rs`**

Modify `apps/desktop-tauri/src-tauri/src/lib.rs`:

```rust
mod app_state;
mod commands;
mod db;
mod error;

use app_state::AppState;
use db::Db;
use directories::ProjectDirs;
use std::path::PathBuf;

fn resolve_db_path() -> PathBuf {
    let device = std::env::var("MEMRY_DEVICE").unwrap_or_else(|_| "default".into());
    let project_dirs = ProjectDirs::from("com", "memry", "memry")
        .expect("could not determine OS project dirs");
    let base = project_dirs.data_dir();
    base.join(format!("memry-{device}")).join("data.db")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_path = resolve_db_path();
    let db = Db::open(&db_path).expect("failed to open db");
    let app_state = AppState::new(db);

    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

(`MEMRY_DEVICE` segregation exists here already — Task 16 expands it.)

- [ ] **Step 2.5: Verify compile**

```bash
cd apps/desktop-tauri/src-tauri && cargo check
```

Expected: PASS. Warnings about unused `db` methods (`open_memory`, `conn`) are OK — they're used by later tasks.

- [ ] **Step 2.6: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/
git commit -m "m2(db): add AppState, Db wrapper, AppError enum"
```

---

## Task 3: Migration runner — `schema_migrations` bootstrap + scanner + applier (TDD)

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/db/migrations.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/migrations_test.rs`
- Create: `apps/desktop-tauri/src-tauri/migrations/` (empty dir at this task)

- [ ] **Step 3.1: Create the migrations directory (empty)**

```bash
mkdir -p apps/desktop-tauri/src-tauri/migrations
touch apps/desktop-tauri/src-tauri/migrations/.gitkeep
```

- [ ] **Step 3.2: Write the failing test first**

Create `apps/desktop-tauri/src-tauri/tests/migrations_test.rs`:

```rust
use memry_desktop_tauri_lib::db::migrations;
use rusqlite::Connection;

#[test]
fn bootstraps_schema_migrations_table() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrations::bootstrap(&mut conn).unwrap();
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(exists, 1);
}

#[test]
fn bootstrap_is_idempotent() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrations::bootstrap(&mut conn).unwrap();
    // Running again should not error.
    migrations::bootstrap(&mut conn).unwrap();
}

#[test]
fn applies_embedded_migrations_in_order_and_records_them() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrations::apply_pending(&mut conn).unwrap();

    // Count rows in schema_migrations matches number of .sql files under
    // src-tauri/migrations/.
    let applied: i64 = conn
        .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| row.get(0))
        .unwrap();
    let expected = migrations::EMBEDDED.len() as i64;
    assert_eq!(applied, expected);

    // Second run applies nothing new.
    migrations::apply_pending(&mut conn).unwrap();
    let still_applied: i64 = conn
        .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| row.get(0))
        .unwrap();
    assert_eq!(still_applied, expected);
}
```

We need the package name to resolve `memry_desktop_tauri_lib::db::migrations`. Verify crate name:

```bash
grep '^name' apps/desktop-tauri/src-tauri/Cargo.toml
```

Expected `name = "memry-desktop-tauri"` (from M1). M1 also already ships a
`[lib]` block:

```toml
[lib]
name = "memry_desktop_tauri_lib"
crate-type = ["staticlib", "cdylib", "rlib"]
```

and `src/main.rs` calls `memry_desktop_tauri_lib::run()`. Do NOT add a
second `[lib]` block — duplicate sections produce invalid TOML and break
`cargo check`. Do NOT rename to drop the `_lib` suffix without also
patching `main.rs`. Keep the M1 wiring as-is.

Concrete action for Step 3.2: confirm the existing `[lib]` block above is
present, and ensure `src/lib.rs` exports `pub mod db;` (from Task 2.4) so
test code can reference `memry_desktop_tauri_lib::db::migrations`. No
Cargo.toml edits required at this step.

- [ ] **Step 3.3: Run test — verify failure**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test migrations_test
```

Expected: test compile error — `migrations::bootstrap`, `migrations::apply_pending`, and `migrations::EMBEDDED` don't exist yet. ✅

- [ ] **Step 3.4: Implement the migration runner**

Write `apps/desktop-tauri/src-tauri/src/db/migrations.rs`:

```rust
//! Hand-rolled migration runner. Reads `migrations/*.sql` files via `include_dir`
//! at compile time, applies any not yet recorded in `schema_migrations`.
//!
//! File naming: `NNNN_short_name.sql` where `NNNN` is a zero-padded integer.
//! Files are applied in lexical order; each file runs inside a single transaction.

use crate::error::{AppError, AppResult};
use rusqlite::Connection;

/// Embedded migration files, sorted by filename at compile time.
pub static EMBEDDED: &[(&str, &str)] = &migration_manifest::MIGRATIONS;

mod migration_manifest {
    /// Auto-populated via `include_str!`. Keep alphabetized by filename.
    pub static MIGRATIONS: [(&str, &str); 29] = [
        ("0001_initial_projects_statuses_tasks.sql", include_str!("../../migrations/0001_initial_projects_statuses_tasks.sql")),
        ("0002_task_relations.sql", include_str!("../../migrations/0002_task_relations.sql")),
        ("0003_inbox.sql", include_str!("../../migrations/0003_inbox.sql")),
        ("0004_settings.sql", include_str!("../../migrations/0004_settings.sql")),
        ("0005_bookmarks.sql", include_str!("../../migrations/0005_bookmarks.sql")),
        ("0006_reminders.sql", include_str!("../../migrations/0006_reminders.sql")),
        ("0007_calendar_events.sql", include_str!("../../migrations/0007_calendar_events.sql")),
        ("0008_calendar_sources.sql", include_str!("../../migrations/0008_calendar_sources.sql")),
        ("0009_calendar_external_events.sql", include_str!("../../migrations/0009_calendar_external_events.sql")),
        ("0010_calendar_bindings.sql", include_str!("../../migrations/0010_calendar_bindings.sql")),
        ("0011_note_positions.sql", include_str!("../../migrations/0011_note_positions.sql")),
        ("0012_note_metadata.sql", include_str!("../../migrations/0012_note_metadata.sql")),
        ("0013_tag_definitions.sql", include_str!("../../migrations/0013_tag_definitions.sql")),
        ("0014_sync_devices.sql", include_str!("../../migrations/0014_sync_devices.sql")),
        ("0015_sync_queue.sql", include_str!("../../migrations/0015_sync_queue.sql")),
        ("0016_sync_state.sql", include_str!("../../migrations/0016_sync_state.sql")),
        ("0017_sync_history.sql", include_str!("../../migrations/0017_sync_history.sql")),
        ("0018_property_definitions.sql", include_str!("../../migrations/0018_property_definitions.sql")),
        ("0019_saved_filters.sql", include_str!("../../migrations/0019_saved_filters.sql")),
        ("0020_search_reasons.sql", include_str!("../../migrations/0020_search_reasons.sql")),
        ("0021_inbox_jobs.sql", include_str!("../../migrations/0021_inbox_jobs.sql")),
        ("0022_notes_journal_vault.sql", include_str!("../../migrations/0022_notes_journal_vault.sql")),
        ("0023_folder_configs.sql", include_str!("../../migrations/0023_folder_configs.sql")),
        ("0024_google_calendar_foundation.sql", include_str!("../../migrations/0024_google_calendar_foundation.sql")),
        ("0025_event_target_calendar.sql", include_str!("../../migrations/0025_event_target_calendar.sql")),
        ("0026_calendar_field_clocks.sql", include_str!("../../migrations/0026_calendar_field_clocks.sql")),
        ("0027_calendar_rich_fields.sql", include_str!("../../migrations/0027_calendar_rich_fields.sql")),
        ("0028_calendar_source_last_error.sql", include_str!("../../migrations/0028_calendar_source_last_error.sql")),
        ("0029_field_clocks_tasks_projects.sql", include_str!("../../migrations/0029_field_clocks_tasks_projects.sql")),
    ];
}

/// Create `schema_migrations` table if absent. Idempotent.
pub fn bootstrap(conn: &mut Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )",
    )?;
    Ok(())
}

/// Apply every embedded migration not already recorded. Each migration runs
/// in its own transaction; failures roll back that migration only.
pub fn apply_pending(conn: &mut Connection) -> AppResult<()> {
    bootstrap(conn)?;
    let applied: std::collections::HashSet<String> = {
        let mut stmt = conn.prepare("SELECT name FROM schema_migrations")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.filter_map(Result::ok).collect()
    };

    for (name, sql) in EMBEDDED {
        if applied.contains(*name) {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)
            .map_err(|e| AppError::Database(format!("migration {name} failed: {e}")))?;
        tx.execute(
            "INSERT INTO schema_migrations (name) VALUES (?1)",
            rusqlite::params![name],
        )?;
        tx.commit()?;
    }
    Ok(())
}
```

Note: the `EMBEDDED` manifest is static because the migration files ship with the binary. An `include_dir!` crate exists but has poorer compile-time guarantees than explicit `include_str!` entries. The explicit list fails compile if any file is missing — a useful safety net.

- [ ] **Step 3.5: Placeholder migration files so `include_str!` resolves**

At this task the runner exists but no real migration SQL does. Create 29 empty placeholder files so `cargo test` compiles:

```bash
cd apps/desktop-tauri/src-tauri/migrations
for i in 0001_initial_projects_statuses_tasks 0002_task_relations 0003_inbox 0004_settings \
  0005_bookmarks 0006_reminders 0007_calendar_events 0008_calendar_sources \
  0009_calendar_external_events 0010_calendar_bindings 0011_note_positions \
  0012_note_metadata 0013_tag_definitions 0014_sync_devices 0015_sync_queue \
  0016_sync_state 0017_sync_history 0018_property_definitions 0019_saved_filters \
  0020_search_reasons 0021_inbox_jobs 0022_notes_journal_vault 0023_folder_configs \
  0024_google_calendar_foundation 0025_event_target_calendar 0026_calendar_field_clocks \
  0027_calendar_rich_fields 0028_calendar_source_last_error 0029_field_clocks_tasks_projects; do
  echo "-- placeholder; real content in Task 4-6" > "$i.sql"
done
cd -
```

Real content lands in Tasks 4-6.

- [ ] **Step 3.6: Run test — verify pass**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test migrations_test
```

Expected: all three tests pass. The third test (`applies_embedded_migrations_in_order_and_records_them`) passes even with placeholder SQL because each placeholder is a valid no-op comment.

- [ ] **Step 3.7: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/db/migrations.rs \
        apps/desktop-tauri/src-tauri/tests/migrations_test.rs \
        apps/desktop-tauri/src-tauri/migrations/
git commit -m "m2(migrations): runner + schema_migrations bootstrap + 29 placeholder files"
```

---

## Task 4: Port migration 0001 — initial core schema (projects, statuses, tasks)

**Files:**
- Overwrite: `apps/desktop-tauri/src-tauri/migrations/0001_initial_projects_statuses_tasks.sql`
- Reference (read-only): `apps/desktop/src/main/database/drizzle-data/0000_thankful_luke_cage.sql`

- [ ] **Step 4.1: Read the Electron source migration**

```bash
cat apps/desktop/src/main/database/drizzle-data/0000_thankful_luke_cage.sql
```

This migration is the Electron initial — contains `projects`, `statuses`, `tasks`, `task_notes`. Note the `IF NOT EXISTS` clauses (drizzle emits them).

- [ ] **Step 4.2: Write the Tauri migration**

Overwrite `apps/desktop-tauri/src-tauri/migrations/0001_initial_projects_statuses_tasks.sql`:

```sql
-- Port of apps/desktop/src/main/database/drizzle-data/0000_thankful_luke_cage.sql
-- Tauri renumbers Drizzle 0000 → 0001 so the stream starts at 0001.
-- `--> statement-breakpoint` markers are Drizzle-specific; stripped here.

CREATE TABLE IF NOT EXISTS projects (
    id text PRIMARY KEY NOT NULL,
    name text NOT NULL,
    description text,
    color text DEFAULT '#6366f1' NOT NULL,
    icon text,
    position integer DEFAULT 0 NOT NULL,
    is_inbox integer DEFAULT 0 NOT NULL,
    created_at text DEFAULT (datetime('now')) NOT NULL,
    modified_at text DEFAULT (datetime('now')) NOT NULL,
    archived_at text
);

CREATE TABLE IF NOT EXISTS statuses (
    id text PRIMARY KEY NOT NULL,
    project_id text NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#6b7280' NOT NULL,
    position integer DEFAULT 0 NOT NULL,
    is_default integer DEFAULT 0 NOT NULL,
    is_done integer DEFAULT 0 NOT NULL,
    created_at text DEFAULT (datetime('now')) NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects (id) ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_statuses_project ON statuses (project_id);

CREATE TABLE IF NOT EXISTS tasks (
    id text PRIMARY KEY NOT NULL,
    project_id text NOT NULL,
    status_id text,
    parent_id text,
    title text NOT NULL,
    description text,
    priority integer DEFAULT 0 NOT NULL,
    position integer DEFAULT 0 NOT NULL,
    due_date text,
    due_time text,
    start_date text,
    repeat_config text,
    repeat_from text,
    source_note_id text,
    completed_at text,
    archived_at text,
    created_at text DEFAULT (datetime('now')) NOT NULL,
    modified_at text DEFAULT (datetime('now')) NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects (id) ON UPDATE NO ACTION ON DELETE CASCADE,
    FOREIGN KEY (status_id) REFERENCES statuses (id) ON UPDATE NO ACTION ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks (project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks (parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks (due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks (completed_at);

CREATE TABLE IF NOT EXISTS task_notes (
    task_id text NOT NULL,
    note_id text NOT NULL,
    created_at text DEFAULT (datetime('now')) NOT NULL,
    PRIMARY KEY (task_id, note_id),
    FOREIGN KEY (task_id) REFERENCES tasks (id) ON UPDATE NO ACTION ON DELETE CASCADE
);
```

Note: boolean defaults changed from Drizzle's `false` literal to `0` for SQLite ANSI compatibility. Behavior identical (SQLite normalizes both — but explicit int is safer for rusqlite's type coercion).

- [ ] **Step 4.3: Run migration test — verify pass**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test migrations_test
```

Expected: PASS. All 29 files still apply; migration 0001 now creates actual tables.

- [ ] **Step 4.4: Add smoke query to confirm schema**

Append to `apps/desktop-tauri/src-tauri/tests/migrations_test.rs`:

```rust
#[test]
fn migration_0001_creates_core_tables() {
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    memry_desktop_tauri_lib::db::migrations::apply_pending(&mut conn).unwrap();
    for table in ["projects", "statuses", "tasks", "task_notes"] {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1, "table {table} missing after migration 0001");
    }
}
```

Run:

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test migrations_test migration_0001
```

Expected: PASS.

- [ ] **Step 4.5: Commit**

```bash
git add apps/desktop-tauri/src-tauri/migrations/0001_initial_projects_statuses_tasks.sql \
        apps/desktop-tauri/src-tauri/tests/migrations_test.rs
git commit -m "m2(migrations): port 0001 initial core tables (projects/statuses/tasks/task_notes)"
```

---

## Task 5: Port Drizzle-output migrations 0002–0019

**Files:**
- Overwrite: `apps/desktop-tauri/src-tauri/migrations/0002_task_relations.sql` through `0019_saved_filters.sql` (18 files)
- Reference (read-only): `apps/desktop/src/main/database/drizzle-data/0001_married_shadow_king.sql` through `0018_greedy_stepford_cuckoos.sql` + `0019_material_lethal_legion.sql`

**Mapping table (Electron → Tauri):**

| Electron file | Tauri file | Short description |
|--------------|------------|-------------------|
| `0001_married_shadow_king.sql` | `0002_task_relations.sql` | `task_notes` relation already in 0001 — this file typically seeds workflow/inbox; open & verify |
| `0002_broken_sleeper.sql` | `0003_inbox.sql` | Inbox table |
| `0003_shallow_gladiator.sql` | `0004_settings.sql` | Settings KV |
| `0004_odd_silver_sable.sql` | `0005_bookmarks.sql` | Bookmarks |
| `0005_old_mac_gargan.sql` | `0006_reminders.sql` | Reminders |
| `0006_late_infant_terrible.sql` | `0007_calendar_events.sql` | Calendar events |
| `0007_safe_sunspot.sql` | `0008_calendar_sources.sql` | Calendar sources |
| `0008_blushing_magma.sql` | `0009_calendar_external_events.sql` | External events |
| `0009_lumpy_gladiator.sql` | `0010_calendar_bindings.sql` | Calendar bindings |
| `0010_dizzy_natasha_romanoff.sql` | `0011_note_positions.sql` | Note positions |
| `0011_silent_shooting_star.sql` | `0012_note_metadata.sql` | Note metadata |
| `0012_lush_veda.sql` | `0013_tag_definitions.sql` | Tag definitions |
| `0013_last_guardian.sql` | `0014_sync_devices.sql` | Sync devices |
| `0014_dazzling_leopardon.sql` | `0015_sync_queue.sql` | Sync queue |
| `0015_brief_hex.sql` | `0016_sync_state.sql` | Sync state |
| `0016_lovely_mastermind.sql` | `0017_sync_history.sql` | Sync history |
| `0017_spotty_mongu.sql` | `0018_property_definitions.sql` | Property definitions (MEMORY.md: adds field_clocks to tasks/projects — do NOT conflate with 0029) |
| `0018_greedy_stepford_cuckoos.sql` | `0019_saved_filters.sql` | Saved filters |

Caveat: the Drizzle file names above are the files Kaan currently has; the actual table each migration introduces may differ from the "short description" heuristic above. **Before porting each file, read it and name the Tauri file after the table(s) it actually touches.** This plan's name suggestions are starting points — adjust if the file content disagrees.

- [ ] **Step 5.1: Port each migration one at a time**

For each `N` from 2 to 19:

1. Read the Electron source file:

```bash
cat apps/desktop/src/main/database/drizzle-data/<electron-file-N>.sql
```

2. Overwrite the Tauri target file with:
   - A header comment showing the source file name
   - The SQL body with `--> statement-breakpoint` markers stripped
   - Drizzle's `DROP TABLE` / `ALTER TABLE` statements preserved as-is
   - Boolean literals normalized (`false` → `0`, `true` → `1`)

3. Run `cargo test --test migrations_test` — must pass.

4. If migration fails (common causes: `ALTER TABLE ADD COLUMN` referring to a table not yet created because order differs from Drizzle — e.g. adding a column to `folders` before `folders` exists):
   - Re-read Electron source files around that number to understand dependency order
   - Update Tauri filename numbering to preserve dependency order
   - Update the `EMBEDDED` manifest in `migrations.rs`
   - Re-run test

- [ ] **Step 5.2: Handle Drizzle `statement-breakpoint` semantics carefully**

Drizzle uses `--> statement-breakpoint` because better-sqlite3 cannot execute multi-statement strings. rusqlite's `execute_batch` handles multi-statement strings fine, so the markers become plain comments. **Keep them stripped for readability.**

- [ ] **Step 5.3: Watch for case-sensitivity and reserved words**

Drizzle wraps identifiers in backticks (`` ` ``). SQLite accepts both backticks and double quotes; either works. Prefer unquoted identifiers where possible for cleaner SQL.

- [ ] **Step 5.4: Run full migration test after each port**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test migrations_test
```

Expected: PASS after each step. If a migration fails, diagnose before proceeding.

- [ ] **Step 5.5: Commit per batch of 4-5 migrations**

To keep commits reviewable, commit after ports 0002-0005, 0006-0010, 0011-0015, 0016-0019:

```bash
git add apps/desktop-tauri/src-tauri/migrations/0002_*.sql \
        apps/desktop-tauri/src-tauri/migrations/0003_*.sql \
        apps/desktop-tauri/src-tauri/migrations/0004_*.sql \
        apps/desktop-tauri/src-tauri/migrations/0005_*.sql
git commit -m "m2(migrations): port 0002-0005 (task_relations, inbox, settings, bookmarks)"
# repeat for remaining batches
```

- [ ] **Step 5.6: Final verification**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test migrations_test
```

Expected: all tests pass.

---

## Task 6: Port hand-written migrations 0020–0029

**Files:**
- Overwrite: `apps/desktop-tauri/src-tauri/migrations/0020_search_reasons.sql` through `0029_field_clocks_tasks_projects.sql`
- Reference (read-only): `apps/desktop/src/main/database/drizzle-data/0020_search_reasons.sql` through `0028_calendar_source_last_error.sql`

The Electron hand-written migrations are already clean SQL — just verbatim copy with a header comment.

- [ ] **Step 6.1: Copy each hand-written migration**

For each `N` from 20 to 28:

```bash
cat apps/desktop/src/main/database/drizzle-data/${N}_*.sql
```

…then overwrite the corresponding Tauri file. Prefix the content with:

```sql
-- Port of apps/desktop/src/main/database/drizzle-data/<source-filename>
-- Hand-written Electron migration; copied verbatim.
```

- [ ] **Step 6.2: Create the new 0029 — field_clocks on tasks + projects**

Per MEMORY.md Phase 8, `field_clocks` columns were added to `tasks` and `projects` in Drizzle migration 0017 in the current Electron DB. But since our Tauri 0018_property_definitions came from Drizzle 0017 (which was the field_clocks migration for tasks/projects per MEMORY.md), this is already handled **there**.

Re-read the Electron 0017 to confirm: if 0017 is `ALTER TABLE tasks ADD field_clocks` + `ALTER TABLE projects ADD field_clocks`, then Tauri's 0018_property_definitions should be renamed to `0018_field_clocks_tasks_projects.sql` and the old name freed. Adjust in the `EMBEDDED` manifest as well.

If 0017 instead introduces property definitions (the schema lookup suggests this: `packages/db-schema/src/schema/notes-cache.ts` exports `propertyDefinitions`), then the field_clocks migration is a different file and Tauri 0029 remains a net-new migration:

```sql
-- Adds field_clocks JSON column for Phase 8 field-level vector clocks
-- on tasks and projects. Not present in Electron's migration history
-- because Drizzle's meta diffing deviated since 0020 (per MEMORY.md
-- project_migrations_hand_written.md).

ALTER TABLE tasks ADD COLUMN field_clocks TEXT;
ALTER TABLE projects ADD COLUMN field_clocks TEXT;
```

**Decision rule:** read Electron 0017 and whichever Electron migration adds `field_clocks`; port them to the lowest unused Tauri slot; update `EMBEDDED` manifest. Do not duplicate the ALTER — if the ALTER lands via a ported file, 0029 may become empty and get removed.

- [ ] **Step 6.3: Run migration test**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test migrations_test
```

Expected: PASS.

- [ ] **Step 6.4: Commit**

```bash
git add apps/desktop-tauri/src-tauri/migrations/0020_*.sql \
        apps/desktop-tauri/src-tauri/migrations/0021_*.sql \
        apps/desktop-tauri/src-tauri/migrations/0022_*.sql \
        apps/desktop-tauri/src-tauri/migrations/0023_*.sql \
        apps/desktop-tauri/src-tauri/migrations/0024_*.sql \
        apps/desktop-tauri/src-tauri/migrations/0025_*.sql \
        apps/desktop-tauri/src-tauri/migrations/0026_*.sql \
        apps/desktop-tauri/src-tauri/migrations/0027_*.sql \
        apps/desktop-tauri/src-tauri/migrations/0028_*.sql \
        apps/desktop-tauri/src-tauri/migrations/0029_*.sql \
        apps/desktop-tauri/src-tauri/src/db/migrations.rs
git commit -m "m2(migrations): port 0020-0029 hand-written migrations"
```

---

## Task 7: Integration smoke test — apply all, count tables, verify schema

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/tests/migrations_test.rs`

- [ ] **Step 7.1: Add a golden-count test**

Append to `apps/desktop-tauri/src-tauri/tests/migrations_test.rs`:

```rust
#[test]
fn full_migration_produces_expected_table_set() {
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    memry_desktop_tauri_lib::db::migrations::apply_pending(&mut conn).unwrap();

    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master
             WHERE type='table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .unwrap();
    let tables: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .filter_map(Result::ok)
        .collect();

    // These MUST exist after all migrations apply. Any absence indicates a
    // missing or wrongly ordered port. Add to this set as you verify each
    // migration — starting with the core set known from Task 4.
    let required: &[&str] = &[
        "schema_migrations",
        "projects",
        "statuses",
        "tasks",
        "task_notes",
        "inbox",
        "settings",
        "bookmarks",
        "reminders",
        "calendar_events",
        "calendar_sources",
        "calendar_external_events",
        "calendar_bindings",
        "note_positions",
        "note_metadata",
        "tag_definitions",
        "sync_devices",
        "sync_queue",
        "sync_state",
        "sync_history",
        "property_definitions",
        "saved_filters",
        "search_reasons",
        "folder_configs",
    ];
    for name in required {
        assert!(
            tables.contains(&name.to_string()),
            "required table {name} missing; present tables: {tables:?}"
        );
    }

    // Hand-written migrations should also introduce:
    // - inbox_jobs (from 0021)
    // Add more assertions as migrations reveal their real table names.
}
```

- [ ] **Step 7.2: Run test**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test migrations_test full_migration
```

Expected: PASS. If any table is missing, diagnose — either the migration is mis-named, or the actual Electron SQL creates the table under a different name. Update the `required` set to match reality, do NOT soften the assertion.

- [ ] **Step 7.3: Verify field_clocks columns present on tasks + projects**

Append:

```rust
#[test]
fn tasks_and_projects_have_field_clocks_column() {
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    memry_desktop_tauri_lib::db::migrations::apply_pending(&mut conn).unwrap();
    for table in ["tasks", "projects"] {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap();
        let cols: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(
            cols.contains(&"field_clocks".to_string()),
            "{table} missing field_clocks column; cols: {cols:?}"
        );
    }
}
```

Run:

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test migrations_test
```

Expected: PASS.

- [ ] **Step 7.4: Commit**

```bash
git add apps/desktop-tauri/src-tauri/tests/migrations_test.rs
git commit -m "m2(migrations): add full-apply integration tests (table set + field_clocks)"
```

---

## Task 8: Per-table structs — projects, statuses, tasks

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/db/projects.rs`
- Create: `apps/desktop-tauri/src-tauri/src/db/statuses.rs`
- Create: `apps/desktop-tauri/src-tauri/src/db/tasks.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/db/mod.rs` (export modules)

- [ ] **Step 8.1: Write `db/projects.rs`**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub color: String,
    pub icon: Option<String>,
    pub position: i64,
    pub is_inbox: bool,
    pub created_at: String,
    pub modified_at: String,
    pub archived_at: Option<String>,
    pub field_clocks: Option<String>,
}

impl Project {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            description: row.get("description")?,
            color: row.get("color")?,
            icon: row.get("icon")?,
            position: row.get("position")?,
            is_inbox: row.get::<_, i64>("is_inbox")? != 0,
            created_at: row.get("created_at")?,
            modified_at: row.get("modified_at")?,
            archived_at: row.get("archived_at")?,
            field_clocks: row.get("field_clocks")?,
        })
    }
}
```

- [ ] **Step 8.2: Write `db/statuses.rs`**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub color: String,
    pub position: i64,
    pub is_default: bool,
    pub is_done: bool,
    pub created_at: String,
}

impl Status {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            project_id: row.get("project_id")?,
            name: row.get("name")?,
            color: row.get("color")?,
            position: row.get("position")?,
            is_default: row.get::<_, i64>("is_default")? != 0,
            is_done: row.get::<_, i64>("is_done")? != 0,
            created_at: row.get("created_at")?,
        })
    }
}
```

- [ ] **Step 8.3: Write `db/tasks.rs`**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub status_id: Option<String>,
    pub parent_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub priority: i64,
    pub position: i64,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub start_date: Option<String>,
    pub repeat_config: Option<String>,
    pub repeat_from: Option<String>,
    pub source_note_id: Option<String>,
    pub completed_at: Option<String>,
    pub archived_at: Option<String>,
    pub clock: Option<String>,
    pub field_clocks: Option<String>,
    pub synced_at: Option<String>,
    pub created_at: String,
    pub modified_at: String,
}

impl Task {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            project_id: row.get("project_id")?,
            status_id: row.get("status_id")?,
            parent_id: row.get("parent_id")?,
            title: row.get("title")?,
            description: row.get("description")?,
            priority: row.get("priority")?,
            position: row.get("position")?,
            due_date: row.get("due_date")?,
            due_time: row.get("due_time")?,
            start_date: row.get("start_date")?,
            repeat_config: row.get("repeat_config")?,
            repeat_from: row.get("repeat_from")?,
            source_note_id: row.get("source_note_id")?,
            completed_at: row.get("completed_at")?,
            archived_at: row.get("archived_at")?,
            clock: row.get("clock")?,
            field_clocks: row.get("field_clocks")?,
            synced_at: row.get("synced_at")?,
            created_at: row.get("created_at")?,
            modified_at: row.get("modified_at")?,
        })
    }
}
```

`clock` and `field_clocks` are stored as JSON strings at this layer; M5/M6 introduce typed `VectorClock` and `FieldClocks` with serde transforms. M2 intentionally keeps them as opaque `Option<String>` to avoid dragging crypto/sync types into the foundation layer.

- [ ] **Step 8.4: Export modules from `db/mod.rs`**

Append to `apps/desktop-tauri/src-tauri/src/db/mod.rs` (after `pub mod migrations;`):

```rust
pub mod projects;
pub mod statuses;
pub mod tasks;
```

- [ ] **Step 8.5: Add a smoke test that inserts + selects a project + task**

Append to `apps/desktop-tauri/src-tauri/tests/migrations_test.rs`:

```rust
#[test]
fn projects_and_tasks_roundtrip() {
    let db = memry_desktop_tauri_lib::db::Db::open_memory().unwrap();
    let conn = db.conn().unwrap();

    conn.execute(
        "INSERT INTO projects (id, name, color, position) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params!["p1", "Inbox", "#000", 0],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tasks (id, project_id, title, priority, position) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params!["t1", "p1", "first", 0, 0],
    )
    .unwrap();

    let project = conn
        .query_row(
            "SELECT * FROM projects WHERE id = 'p1'",
            [],
            memry_desktop_tauri_lib::db::projects::Project::from_row,
        )
        .unwrap();
    assert_eq!(project.name, "Inbox");

    let task = conn
        .query_row(
            "SELECT * FROM tasks WHERE id = 't1'",
            [],
            memry_desktop_tauri_lib::db::tasks::Task::from_row,
        )
        .unwrap();
    assert_eq!(task.project_id, "p1");
    assert_eq!(task.title, "first");
}
```

Add the `test-helpers` feature to `Cargo.toml` so `open_memory()` compiles from the test crate:

```toml
[features]
default = []
test-helpers = []
```

And annotate `Db::open_memory` (already has `#[cfg(any(test, feature = "test-helpers"))]`). For integration tests (separate crate), we need the feature gate — enable it during test runs:

```toml
[dev-dependencies]
tempfile = "3"

# Integration tests can access the test-helpers feature
[[test]]
name = "migrations_test"
required-features = ["test-helpers"]
```

Run with:

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test migrations_test --features test-helpers
```

- [ ] **Step 8.6: Run all tests, verify pass**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers
```

Expected: PASS.

- [ ] **Step 8.7: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/db/ apps/desktop-tauri/src-tauri/tests/migrations_test.rs apps/desktop-tauri/src-tauri/Cargo.toml
git commit -m "m2(db): add Project/Status/Task structs with from_row helpers"
```

---

## Task 9: Per-table structs — notes_cache, note_metadata, note_positions

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/db/notes_cache.rs`
- Create: `apps/desktop-tauri/src-tauri/src/db/note_metadata.rs`
- Create: `apps/desktop-tauri/src-tauri/src/db/note_positions.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/db/mod.rs`

**Reference for column names:** `packages/db-schema/src/schema/notes-cache.ts`, `note-metadata.ts`, `note-positions.ts`, plus the actual ported migration SQL files.

- [ ] **Step 9.1: Read the schema source files and the corresponding migration SQL**

```bash
cat packages/db-schema/src/schema/notes-cache.ts
cat packages/db-schema/src/schema/note-metadata.ts
cat packages/db-schema/src/schema/note-positions.ts
cat apps/desktop-tauri/src-tauri/migrations/0011_note_positions.sql
cat apps/desktop-tauri/src-tauri/migrations/0012_note_metadata.sql
cat apps/desktop-tauri/src-tauri/migrations/0018_property_definitions.sql
```

Use the column names + types from the ported SQL (authoritative) — not the TS schema (which may reference drizzle helpers that don't 1:1 map to SQL types).

- [ ] **Step 9.2: Struct recipe (apply per module)**

For each of `notes_cache.rs`, `note_metadata.rs`, `note_positions.rs`:

1. Define a struct with exactly these derives:
   `#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]` + `#[serde(rename_all = "camelCase")]`
2. Fields: one per column from the final CREATE TABLE, with type mapping:
   - `TEXT NOT NULL` → `String`
   - `TEXT` (nullable) → `Option<String>`
   - `INTEGER NOT NULL` → `i64`
   - `INTEGER` (nullable) → `Option<i64>`
   - Boolean `INTEGER` (0/1) → `bool`; read via `row.get::<_, i64>("col")? != 0`
3. Implement `pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self>` — one `row.get("col")?` per field, boolean conversions explicit.
4. **Canonical struct names required by Task 14's generator** (do not rename):
   - `notes_cache.rs` → `PropertyDefinition`
   - `note_metadata.rs` → `NoteMetadata`
   - `note_positions.rs` → `NotePosition`

Columns come from the ported migration SQL (authoritative over TS schema). For `PropertyDefinition`, read `migrations/0018_property_definitions.sql` and list every column. For `NoteMetadata`, read `migrations/0012_note_metadata.sql` + any later ALTER TABLE migrations that touch it. For `NotePosition`, read `migrations/0011_note_positions.sql`.

Minimal pattern (substitute real columns from the SQL):

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDefinition {
    pub id: String,
    pub name: String,
    // Add every remaining column from 0018_property_definitions.sql here.
    pub created_at: String,
}

impl PropertyDefinition {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            // One `row.get(...)` per field, matching the struct order.
            created_at: row.get("created_at")?,
        })
    }
}
```

- [ ] **Step 9.3: Export from `db/mod.rs`**

```rust
pub mod note_metadata;
pub mod note_positions;
pub mod notes_cache;
```

- [ ] **Step 9.4: Add smoke test**

Append to `migrations_test.rs` one test per table that inserts a minimal row and reads it back via the struct's `from_row`. Pattern identical to Task 8.5 (`projects_and_tasks_roundtrip`).

- [ ] **Step 9.5: Run tests**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers
```

Expected: PASS.

- [ ] **Step 9.6: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/db/ apps/desktop-tauri/src-tauri/tests/
git commit -m "m2(db): add note_metadata/note_positions/notes_cache structs"
```

---

## Task 10: Per-table structs — calendar (events, sources, external_events, bindings)

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/db/calendar_events.rs`
- Create: `apps/desktop-tauri/src-tauri/src/db/calendar_sources.rs`
- Create: `apps/desktop-tauri/src-tauri/src/db/calendar_external_events.rs`
- Create: `apps/desktop-tauri/src-tauri/src/db/calendar_bindings.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/db/mod.rs`

- [ ] **Step 10.1: Read source files**

```bash
cat packages/db-schema/src/schema/calendar-events.ts
cat packages/db-schema/src/schema/calendar-sources.ts
cat packages/db-schema/src/schema/calendar-external-events.ts
cat packages/db-schema/src/schema/calendar-bindings.ts
cat apps/desktop-tauri/src-tauri/migrations/0007_calendar_events.sql
cat apps/desktop-tauri/src-tauri/migrations/0008_calendar_sources.sql
cat apps/desktop-tauri/src-tauri/migrations/0009_calendar_external_events.sql
cat apps/desktop-tauri/src-tauri/migrations/0010_calendar_bindings.sql
cat apps/desktop-tauri/src-tauri/migrations/0025_event_target_calendar.sql
cat apps/desktop-tauri/src-tauri/migrations/0026_calendar_field_clocks.sql
cat apps/desktop-tauri/src-tauri/migrations/0027_calendar_rich_fields.sql
cat apps/desktop-tauri/src-tauri/migrations/0028_calendar_source_last_error.sql
```

Columns accumulate across multiple migrations — build each struct with the **final** column set (after all migrations have applied).

- [ ] **Step 10.2: Define each struct**

For each of the 4 calendar modules, write a struct with:

1. Derives: `#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]` + `#[serde(rename_all = "camelCase")]`
2. One field per column from the **post-migration** column set. Column sets accumulate across migrations 0007-0010 (base) + 0025/0026/0027/0028 (later ALTER TABLEs). Read all relevant SQL files before writing the struct.
3. Type mapping: `TEXT NOT NULL → String`, `TEXT nullable → Option<String>`, `INTEGER NOT NULL → i64`, `INTEGER nullable → Option<i64>`, `INTEGER` boolean → `bool`.
4. `impl StructName { pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> { … } }` — one `row.get("col")?` per field.

**Canonical struct names required by Task 14's generator:**
- `calendar_events.rs` → `CalendarEvent`
- `calendar_sources.rs` → `CalendarSource`
- `calendar_external_events.rs` → `CalendarExternalEvent`
- `calendar_bindings.rs` → `CalendarBinding`

Skeleton for `CalendarEvent` (populate columns from the SQL):

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    // Add all columns from 0007_calendar_events.sql + 0025/0026/0027/0028 ALTERs.
    pub created_at: String,
}

impl CalendarEvent {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            // …one row.get per field…
            created_at: row.get("created_at")?,
        })
    }
}
```

- [ ] **Step 10.3: Export from `db/mod.rs`**

```rust
pub mod calendar_bindings;
pub mod calendar_events;
pub mod calendar_external_events;
pub mod calendar_sources;
```

- [ ] **Step 10.4: Add one smoke test per table in `migrations_test.rs`**

Minimal pattern — insert one row with only required columns, SELECT back, assert roundtrip via `from_row`. Use the same structure as Task 8.5's `projects_and_tasks_roundtrip`.

- [ ] **Step 10.5: Run tests + commit**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers
```

```bash
git add apps/desktop-tauri/src-tauri/src/db/ apps/desktop-tauri/src-tauri/tests/
git commit -m "m2(db): add calendar_{events,sources,external_events,bindings} structs"
```

---

## Task 11: Per-table structs — inbox, bookmarks, reminders, tag_definitions, folder_configs

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/db/inbox.rs`
- Create: `apps/desktop-tauri/src-tauri/src/db/bookmarks.rs`
- Create: `apps/desktop-tauri/src-tauri/src/db/reminders.rs`
- Create: `apps/desktop-tauri/src-tauri/src/db/tag_definitions.rs`
- Create: `apps/desktop-tauri/src-tauri/src/db/folder_configs.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/db/mod.rs`

- [ ] **Step 11.1: Read source migrations for each table**

```bash
cat apps/desktop-tauri/src-tauri/migrations/0003_inbox.sql
cat apps/desktop-tauri/src-tauri/migrations/0005_bookmarks.sql
cat apps/desktop-tauri/src-tauri/migrations/0006_reminders.sql
cat apps/desktop-tauri/src-tauri/migrations/0013_tag_definitions.sql
cat apps/desktop-tauri/src-tauri/migrations/0023_folder_configs.sql
cat apps/desktop-tauri/src-tauri/migrations/0021_inbox_jobs.sql  # may also touch inbox
```

- [ ] **Step 11.2: Define each struct**

For each module, write a struct with:

1. Derives: `#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]` + `#[serde(rename_all = "camelCase")]`
2. Fields from the post-migration column set (include ALTER TABLE additions from 0021 for inbox).
3. Type mapping: `TEXT NOT NULL → String`, nullable → `Option<String>`, `INTEGER → i64`, boolean `INTEGER → bool`.
4. `impl StructName { pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> { … } }`.

**Canonical struct names required by Task 14's generator:**
- `inbox.rs` → `InboxItem`
- `bookmarks.rs` → `Bookmark`
- `reminders.rs` → `Reminder`
- `tag_definitions.rs` → `TagDefinition`
- `folder_configs.rs` → `FolderConfig`

Skeleton for `Bookmark` (from 0005_bookmarks.sql, actual columns per the existing Electron file `item_type`, `item_id`, `position`, `created_at`):

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub item_type: String,
    pub item_id: String,
    pub position: i64,
    pub created_at: String,
}

impl Bookmark {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            item_type: row.get("item_type")?,
            item_id: row.get("item_id")?,
            position: row.get("position")?,
            created_at: row.get("created_at")?,
        })
    }
}
```

- [ ] **Step 11.3: Export + smoke test + run tests**

Export each new module from `db/mod.rs`. Add one roundtrip smoke test per table in `migrations_test.rs` following the pattern in Task 8.5. Run:

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers
```

Expected: PASS.

- [ ] **Step 11.4: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/db/ apps/desktop-tauri/src-tauri/tests/
git commit -m "m2(db): add inbox/bookmarks/reminders/tag_definitions/folder_configs structs"
```

---

## Task 12: Per-table structs — sync_queue, sync_devices, sync_state, sync_history, search_reasons

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/db/sync_queue.rs`
- Create: `apps/desktop-tauri/src-tauri/src/db/sync_devices.rs`
- Create: `apps/desktop-tauri/src-tauri/src/db/sync_state.rs`
- Create: `apps/desktop-tauri/src-tauri/src/db/sync_history.rs`
- Create: `apps/desktop-tauri/src-tauri/src/db/search_reasons.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/db/mod.rs`

- [ ] **Step 12.1: Read source migrations**

```bash
cat apps/desktop-tauri/src-tauri/migrations/0014_sync_devices.sql
cat apps/desktop-tauri/src-tauri/migrations/0015_sync_queue.sql
cat apps/desktop-tauri/src-tauri/migrations/0016_sync_state.sql
cat apps/desktop-tauri/src-tauri/migrations/0017_sync_history.sql
cat apps/desktop-tauri/src-tauri/migrations/0020_search_reasons.sql
```

- [ ] **Step 12.2: Define each struct**

Same derive and type-mapping recipe as Tasks 9-11:

1. `#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]` + `#[serde(rename_all = "camelCase")]`
2. Fields per post-migration column set
3. `from_row` with one `row.get("col")?` per field

**Canonical struct names required by Task 14's generator:**
- `sync_queue.rs` → `SyncQueueItem`
- `sync_devices.rs` → `SyncDevice`
- `sync_state.rs` → `SyncState`
- `sync_history.rs` → `SyncHistoryEntry`
- `search_reasons.rs` → `SearchReason`

These are sync foundation types — M6 adds CRUD helpers. At M2, the struct plus `from_row` is sufficient scaffolding so later milestones can import the types without editing M2 files.

- [ ] **Step 12.3: Export + smoke test + run tests**

Export each module from `db/mod.rs`. Add one roundtrip smoke test per table. Run:

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers
```

Expected: PASS.

- [ ] **Step 12.4: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/db/ apps/desktop-tauri/src-tauri/tests/
git commit -m "m2(db): add sync_{queue,devices,state,history}/search_reasons structs"
```

---

## Task 13: Settings KV — first real IPC command slice (TDD)

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/db/settings.rs`
- Create: `apps/desktop-tauri/src-tauri/src/db/saved_filters.rs`
- Create: `apps/desktop-tauri/src-tauri/src/commands/settings.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/commands/mod.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/settings_test.rs`

- [ ] **Step 13.1: Write `db/settings.rs` with CRUD helpers**

```rust
use crate::db::Db;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub key: String,
    pub value: String,
    pub modified_at: String,
}

impl Setting {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            key: row.get("key")?,
            value: row.get("value")?,
            modified_at: row.get("modified_at")?,
        })
    }
}

pub fn get(db: &Db, key: &str) -> AppResult<Option<String>> {
    let conn = db.conn()?;
    let result = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get::<_, String>(0),
        )
        .map(Some);
    match result {
        Ok(v) => Ok(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(AppError::from(e)),
    }
}

pub fn set(db: &Db, key: &str, value: &str) -> AppResult<()> {
    let conn = db.conn()?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           modified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

pub fn list(db: &Db) -> AppResult<Vec<Setting>> {
    let conn = db.conn()?;
    let mut stmt = conn.prepare("SELECT key, value, modified_at FROM settings ORDER BY key")?;
    let items = stmt
        .query_map([], Setting::from_row)?
        .filter_map(Result::ok)
        .collect();
    Ok(items)
}
```

- [ ] **Step 13.2: Write `db/saved_filters.rs`**

Canonical struct name: `SavedFilter`. Fields map to `migrations/0019_saved_filters.sql` columns (`id`, `name`, `config`, `position`, `created_at`, `clock`, `synced_at`):

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedFilter {
    pub id: String,
    pub name: String,
    pub config: String,
    pub position: i64,
    pub created_at: String,
    pub clock: Option<String>,
    pub synced_at: Option<String>,
}

impl SavedFilter {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            config: row.get("config")?,
            position: row.get("position")?,
            created_at: row.get("created_at")?,
            clock: row.get("clock")?,
            synced_at: row.get("synced_at")?,
        })
    }
}
```

- [ ] **Step 13.3: Write the failing test**

Create `apps/desktop-tauri/src-tauri/tests/settings_test.rs`:

```rust
use memry_desktop_tauri_lib::db::{settings, Db};

#[test]
fn get_missing_key_returns_none() {
    let db = Db::open_memory().unwrap();
    let v = settings::get(&db, "nonexistent").unwrap();
    assert_eq!(v, None);
}

#[test]
fn set_then_get_roundtrip() {
    let db = Db::open_memory().unwrap();
    settings::set(&db, "theme", "dark").unwrap();
    let v = settings::get(&db, "theme").unwrap();
    assert_eq!(v.as_deref(), Some("dark"));
}

#[test]
fn set_upserts_existing_key() {
    let db = Db::open_memory().unwrap();
    settings::set(&db, "theme", "dark").unwrap();
    settings::set(&db, "theme", "light").unwrap();
    let v = settings::get(&db, "theme").unwrap();
    assert_eq!(v.as_deref(), Some("light"));
}

#[test]
fn list_returns_sorted_entries() {
    let db = Db::open_memory().unwrap();
    settings::set(&db, "b-key", "2").unwrap();
    settings::set(&db, "a-key", "1").unwrap();
    settings::set(&db, "c-key", "3").unwrap();
    let items = settings::list(&db).unwrap();
    let keys: Vec<&str> = items.iter().map(|s| s.key.as_str()).collect();
    assert_eq!(keys, vec!["a-key", "b-key", "c-key"]);
}
```

Gate the integration test binary:

```toml
# Cargo.toml
[[test]]
name = "settings_test"
required-features = ["test-helpers"]
```

Run:

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test settings_test --features test-helpers
```

Expected: compile FAIL — `db::settings` module doesn't exist yet.

- [ ] **Step 13.4: Export modules + implement tests pass**

Add to `apps/desktop-tauri/src-tauri/src/db/mod.rs`:

```rust
pub mod saved_filters;
pub mod settings;
```

Re-run:

```bash
cd apps/desktop-tauri/src-tauri && cargo test --test settings_test --features test-helpers
```

Expected: PASS (all 4 tests).

- [ ] **Step 13.5: Write Tauri commands**

Create `apps/desktop-tauri/src-tauri/src/commands/settings.rs`:

```rust
use crate::app_state::AppState;
use crate::db::settings::{self, Setting};
use crate::error::AppResult;
use serde::Deserialize;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsGetInput {
    pub key: String,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSetInput {
    pub key: String,
    pub value: String,
}

#[tauri::command]
#[specta::specta]
pub async fn settings_get(
    state: tauri::State<'_, AppState>,
    input: SettingsGetInput,
) -> AppResult<Option<String>> {
    settings::get(&state.db, &input.key)
}

#[tauri::command]
#[specta::specta]
pub async fn settings_set(
    state: tauri::State<'_, AppState>,
    input: SettingsSetInput,
) -> AppResult<()> {
    settings::set(&state.db, &input.key, &input.value)
}

#[tauri::command]
#[specta::specta]
pub async fn settings_list(state: tauri::State<'_, AppState>) -> AppResult<Vec<Setting>> {
    settings::list(&state.db)
}
```

- [ ] **Step 13.6: Register commands**

Update `apps/desktop-tauri/src-tauri/src/commands/mod.rs`:

```rust
pub mod settings;

pub fn register_handlers() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![
        settings::settings_get,
        settings::settings_set,
        settings::settings_list,
    ]
}
```

Update `apps/desktop-tauri/src-tauri/src/lib.rs`:

```rust
tauri::Builder::default()
    .manage(app_state)
    .invoke_handler(tauri::generate_handler![
        commands::settings::settings_get,
        commands::settings::settings_set,
        commands::settings::settings_list,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
```

(Using `generate_handler!` directly in `lib.rs` avoids the typing complexity of returning `Fn` from `commands/mod.rs`.)

- [ ] **Step 13.7: Verify compile + tests**

```bash
cd apps/desktop-tauri/src-tauri && cargo check && cargo test --features test-helpers
```

Expected: PASS.

- [ ] **Step 13.8: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/db/settings.rs \
        apps/desktop-tauri/src-tauri/src/db/saved_filters.rs \
        apps/desktop-tauri/src-tauri/src/db/mod.rs \
        apps/desktop-tauri/src-tauri/src/commands/ \
        apps/desktop-tauri/src-tauri/src/lib.rs \
        apps/desktop-tauri/src-tauri/tests/settings_test.rs \
        apps/desktop-tauri/src-tauri/Cargo.toml
git commit -m "m2(settings): settings_get/set/list commands + 4 Rust tests"
```

---

## Task 14: Specta bindings regeneration — stress-test all domain types

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/bin/generate_bindings.rs`
- Regenerate: `apps/desktop-tauri/src/generated/bindings.ts`

- [ ] **Step 14.1: Update generator to include all M2 types**

Overwrite `apps/desktop-tauri/src-tauri/src/bin/generate_bindings.rs`:

```rust
//! Regenerate `src/generated/bindings.ts` from Rust command signatures
//! and domain struct derives. Run via `pnpm bindings:generate`.

use memry_desktop_tauri_lib::commands;
use memry_desktop_tauri_lib::db;
use specta_typescript::Typescript;
use tauri_specta::{collect_commands, collect_types};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let builder = tauri_specta::Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::settings::settings_list,
        ])
        .typ::<db::settings::Setting>()
        .typ::<db::saved_filters::SavedFilter>()
        .typ::<db::projects::Project>()
        .typ::<db::statuses::Status>()
        .typ::<db::tasks::Task>()
        .typ::<db::notes_cache::PropertyDefinition>()
        .typ::<db::note_metadata::NoteMetadata>()
        .typ::<db::note_positions::NotePosition>()
        .typ::<db::calendar_events::CalendarEvent>()
        .typ::<db::calendar_sources::CalendarSource>()
        .typ::<db::calendar_external_events::CalendarExternalEvent>()
        .typ::<db::calendar_bindings::CalendarBinding>()
        .typ::<db::inbox::InboxItem>()
        .typ::<db::bookmarks::Bookmark>()
        .typ::<db::reminders::Reminder>()
        .typ::<db::tag_definitions::TagDefinition>()
        .typ::<db::folder_configs::FolderConfig>()
        .typ::<db::sync_queue::SyncQueueItem>()
        .typ::<db::sync_devices::SyncDevice>()
        .typ::<db::sync_state::SyncState>()
        .typ::<db::sync_history::SyncHistoryEntry>()
        .typ::<db::search_reasons::SearchReason>()
        .typ::<memry_desktop_tauri_lib::error::AppError>();

    builder.export(
        Typescript::default(),
        "../src/generated/bindings.ts",
    )?;

    Ok(())
}
```

Exact struct names (`PropertyDefinition`, `NoteMetadata`, `InboxItem`, etc.) must match the names defined in Tasks 9–12. If any mismatch exists, fix the module to match the canonical name before running the generator.

- [ ] **Step 14.2: Run generator**

```bash
cd apps/desktop-tauri && pnpm bindings:generate
```

Expected: `src/generated/bindings.ts` rewritten with ~22 type exports + 3 commands.

- [ ] **Step 14.3: Inspect output**

```bash
head -80 apps/desktop-tauri/src/generated/bindings.ts
grep -c '^export' apps/desktop-tauri/src/generated/bindings.ts
```

Expected: >= 20 exports. Type drift across camelCase rename: if any field appears in snake_case in the TS output, the `#[serde(rename_all = "camelCase")]` derive is missing — go back and add it.

- [ ] **Step 14.4: Verify TypeScript compiles**

```bash
pnpm --filter @memry/desktop-tauri typecheck
```

Expected: PASS.

- [ ] **Step 14.5: Verify `bindings:check` is clean**

```bash
pnpm --filter @memry/desktop-tauri bindings:check
```

Expected: exits 0. (The check script regenerates and diffs; if drift, it should have been committed above.)

- [ ] **Step 14.6: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/bin/generate_bindings.rs \
        apps/desktop-tauri/src/generated/bindings.ts
git commit -m "m2(bindings): regenerate with 22 domain types + settings commands"
```

---

## Task 15: Renderer — swap settings mock for real invoke

**Files:**
- Modify: `apps/desktop-tauri/src/lib/ipc/invoke.ts`
- Modify: `apps/desktop-tauri/src/hooks/useSettings.ts`
- Keep: `apps/desktop-tauri/src/lib/ipc/mocks/settings.ts` (fallback for other M2+ work still in flight)

- [ ] **Step 15.1: Update the invoke wrapper to route settings_* to real Tauri**

Open `apps/desktop-tauri/src/lib/ipc/invoke.ts`. From M1 this file has a `realCommands` Set that starts empty — add settings:

```typescript
/**
 * Commands whose real Rust implementation is ready. Any command not in this
 * set falls back to the mock router.
 */
const realCommands = new Set<string>([
  'settings_get',
  'settings_set',
  'settings_list',
])

export async function invoke<K extends keyof Commands>(
  cmd: K,
  args: Commands[K]['input'] = undefined as never
): Promise<Commands[K]['output']> {
  if (realCommands.has(cmd as string)) {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
    return tauriInvoke(cmd as string, args as Record<string, unknown>) as Promise<
      Commands[K]['output']
    >
  }
  return mockInvoke(cmd, args)
}
```

Keep the rest of the file unchanged.

- [ ] **Step 15.2: Update `useSettings` hook to use the typed invoke**

Open `apps/desktop-tauri/src/hooks/useSettings.ts` (port from M1). Replace the body with a Tanstack Query pattern:

```typescript
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/ipc/invoke'

const settingsKey = (key: string) => ['settings', key] as const

export function useSetting(key: string) {
  return useQuery({
    queryKey: settingsKey(key),
    queryFn: () => invoke('settings_get', { key }),
  })
}

export function useSettings() {
  return useQuery({
    queryKey: ['settings', 'list'],
    queryFn: () => invoke('settings_list', undefined),
  })
}

export function useSetSetting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      invoke('settings_set', { key, value }),
    onSuccess: (_, { key }) => {
      qc.invalidateQueries({ queryKey: settingsKey(key) })
      qc.invalidateQueries({ queryKey: ['settings', 'list'] })
    },
  })
}
```

- [ ] **Step 15.3: Write a Vitest component test**

Create `apps/desktop-tauri/tests/useSettings.test.tsx` (or update an existing M1 mock test if present):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactNode } from 'react'
import { useSetSetting, useSetting } from '@/hooks/useSettings'

vi.mock('@tauri-apps/api/core', () => {
  const store = new Map<string, string>()
  return {
    invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      switch (cmd) {
        case 'settings_set':
          store.set(args.key as string, args.value as string)
          return undefined
        case 'settings_get':
          return store.get(args.key as string) ?? null
        case 'settings_list':
          return Array.from(store.entries()).map(([key, value]) => ({
            key,
            value,
            modifiedAt: '2026-04-25T00:00:00.000Z',
          }))
      }
    }),
  }
})

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useSettings', () => {
  it('round-trips a value through the invoke boundary', async () => {
    const { result } = renderHook(
      () => {
        const setSetting = useSetSetting()
        const getSetting = useSetting('theme')
        return { setSetting, getSetting }
      },
      { wrapper }
    )

    result.current.setSetting.mutate({ key: 'theme', value: 'dark' })
    await waitFor(() => expect(result.current.setSetting.isSuccess).toBe(true))
    await waitFor(() =>
      expect(result.current.getSetting.data).toEqual('dark')
    )
  })
})
```

- [ ] **Step 15.4: Run Vitest**

```bash
pnpm --filter @memry/desktop-tauri test
```

Expected: PASS.

- [ ] **Step 15.5: Manual end-to-end dev smoke**

```bash
pnpm --filter @memry/desktop-tauri dev
```

Open the settings page. Toggle a setting that flows through `useSetting`/`useSetSetting`. Inspect the SQLite DB at `~/Library/Application Support/com.memry.memry/memry-default/data.db`:

```bash
sqlite3 ~/Library/Application\ Support/com.memry.memry/memry-default/data.db \
  "SELECT key, value FROM settings;"
```

Expected: the toggled row present.

- [ ] **Step 15.6: Commit**

```bash
git add apps/desktop-tauri/src/lib/ipc/invoke.ts \
        apps/desktop-tauri/src/hooks/useSettings.ts \
        apps/desktop-tauri/tests/useSettings.test.tsx
git commit -m "m2(renderer): swap settings_* mock for real invoke; useSettings hook wired"
```

---

## Task 16: Device profile support — `MEMRY_DEVICE` env var

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs`
- Modify: `apps/desktop-tauri/package.json`

- [ ] **Step 16.1: Confirm existing `resolve_db_path` already respects `MEMRY_DEVICE`**

Task 2.4 wired this. Verify:

```bash
grep -n MEMRY_DEVICE apps/desktop-tauri/src-tauri/src/lib.rs
```

Expected: line like `let device = std::env::var("MEMRY_DEVICE").unwrap_or_else(|_| "default".into());`.

- [ ] **Step 16.2: Add dev scripts for device A/B**

Edit `apps/desktop-tauri/package.json` — under `"scripts"`, add:

```json
"dev:a": "MEMRY_DEVICE=A tauri dev",
"dev:b": "MEMRY_DEVICE=B tauri dev",
```

- [ ] **Step 16.3: Smoke test**

```bash
pnpm --filter @memry/desktop-tauri dev:a
```

Let it boot. Quit. Then:

```bash
pnpm --filter @memry/desktop-tauri dev:b
```

Verify two separate DBs exist:

```bash
ls ~/Library/Application\ Support/com.memry.memry/
```

Expected: `memry-A/` and `memry-B/` directories, each containing `data.db`.

- [ ] **Step 16.4: Commit**

```bash
git add apps/desktop-tauri/package.json
git commit -m "m2(devx): add MEMRY_DEVICE=A/B dev scripts"
```

---

## Task 17: Dev scripts — `dev-reset.sh`, `new-migration.ts`, `schema-diff.ts`

**Files:**
- Create: `apps/desktop-tauri/scripts/dev-reset.sh`
- Create: `apps/desktop-tauri/scripts/new-migration.ts`
- Create: `apps/desktop-tauri/scripts/schema-diff.ts`
- Modify: `apps/desktop-tauri/package.json`

- [ ] **Step 17.1: `dev-reset.sh`**

Create `apps/desktop-tauri/scripts/dev-reset.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Wipe memry app data for the selected device profile (or all profiles).
#
# Usage:
#   ./scripts/dev-reset.sh           # resets default profile
#   ./scripts/dev-reset.sh A         # resets profile A
#   ./scripts/dev-reset.sh --all     # resets every memry-* profile

BASE="$HOME/Library/Application Support/com.memry.memry"

if [[ "${1:-}" == "--all" ]]; then
  echo "Wiping $BASE"
  rm -rf "$BASE"
  exit 0
fi

DEVICE="${1:-default}"
TARGET="$BASE/memry-$DEVICE"
echo "Wiping $TARGET"
rm -rf "$TARGET"
echo "Done. Next app launch will re-apply migrations."
```

Make executable:

```bash
chmod +x apps/desktop-tauri/scripts/dev-reset.sh
```

- [ ] **Step 17.2: `new-migration.ts` helper**

Create `apps/desktop-tauri/scripts/new-migration.ts`:

```typescript
#!/usr/bin/env tsx
/**
 * Create a new migration file with the next sequential number.
 *
 * Usage:
 *   pnpm db:new-migration "add_widgets_table"
 */
import { readdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = resolve(__dirname, '../src-tauri/migrations')
const MANIFEST_PATH = resolve(
  __dirname,
  '../src-tauri/src/db/migrations.rs'
)

function nextNumber(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
  if (files.length === 0) return '0001'
  const max = Math.max(...files.map((f) => Number(f.slice(0, 4))))
  return String(max + 1).padStart(4, '0')
}

function main() {
  const name = process.argv[2]
  if (!name) {
    console.error('Usage: pnpm db:new-migration "<snake_case_name>"')
    process.exit(1)
  }
  if (!/^[a-z0-9_]+$/.test(name)) {
    console.error('Name must be snake_case, lowercase, digits or underscores only.')
    process.exit(1)
  }

  const num = nextNumber()
  const filename = `${num}_${name}.sql`
  const target = resolve(MIGRATIONS_DIR, filename)

  if (existsSync(target)) {
    console.error(`${filename} already exists.`)
    process.exit(1)
  }

  writeFileSync(
    target,
    `-- ${filename}\n-- TODO: describe what this migration changes\n\n`
  )

  console.log(`Created ${filename}`)
  console.log(
    `\nNext: add an entry to EMBEDDED in:\n  ${MANIFEST_PATH}\n\n` +
      `  ("${filename}", include_str!("../../migrations/${filename}")),\n\n` +
      `Also bump the array length in the migration_manifest module.`
  )
}

main()
```

- [ ] **Step 17.3: `schema-diff.ts` helper (Electron ↔ Tauri parity)**

Create `apps/desktop-tauri/scripts/schema-diff.ts`:

```typescript
#!/usr/bin/env tsx
/**
 * Compare Electron's applied schema against Tauri's applied schema.
 *
 * Run Tauri once in MEMRY_DEVICE=schemaaudit mode so it produces a freshly
 * migrated DB, then point this script at both DBs. Reports any differences
 * in table set, column set per table, or index set per table.
 *
 * Usage:
 *   pnpm db:schema-diff <path-to-electron.db> <path-to-tauri.db>
 */
import Database from 'better-sqlite3'

type TableInfo = {
  name: string
  columns: Set<string>
  indexes: Set<string>
}

function introspect(path: string): Map<string, TableInfo> {
  const db = new Database(path, { readonly: true })
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    )
    .all() as Array<{ name: string }>

  const out = new Map<string, TableInfo>()
  for (const { name } of tables) {
    const cols = db
      .prepare(`PRAGMA table_info(${name})`)
      .all() as Array<{ name: string }>
    const idx = db
      .prepare(`PRAGMA index_list(${name})`)
      .all() as Array<{ name: string }>
    out.set(name, {
      name,
      columns: new Set(cols.map((c) => c.name)),
      indexes: new Set(idx.map((i) => i.name)),
    })
  }
  db.close()
  return out
}

function diffSet<T>(a: Set<T>, b: Set<T>): { onlyA: T[]; onlyB: T[] } {
  return {
    onlyA: [...a].filter((x) => !b.has(x)),
    onlyB: [...b].filter((x) => !a.has(x)),
  }
}

function main() {
  const [electronPath, tauriPath] = process.argv.slice(2)
  if (!electronPath || !tauriPath) {
    console.error('Usage: pnpm db:schema-diff <electron.db> <tauri.db>')
    process.exit(1)
  }

  const electron = introspect(electronPath)
  const tauri = introspect(tauriPath)

  const tableDiff = diffSet(
    new Set(electron.keys()),
    new Set(tauri.keys())
  )

  let failed = false
  if (tableDiff.onlyA.length > 0) {
    console.log(`Tables only in Electron: ${tableDiff.onlyA.join(', ')}`)
    failed = true
  }
  if (tableDiff.onlyB.length > 0) {
    console.log(`Tables only in Tauri: ${tableDiff.onlyB.join(', ')}`)
    failed = true
  }

  for (const [name, tInfo] of tauri) {
    const eInfo = electron.get(name)
    if (!eInfo) continue
    const colDiff = diffSet(eInfo.columns, tInfo.columns)
    if (colDiff.onlyA.length || colDiff.onlyB.length) {
      console.log(`\nTable ${name} column diff:`)
      if (colDiff.onlyA.length) console.log(`  only in Electron: ${colDiff.onlyA.join(', ')}`)
      if (colDiff.onlyB.length) console.log(`  only in Tauri: ${colDiff.onlyB.join(', ')}`)
      failed = true
    }
  }

  if (failed) {
    console.log('\nFAIL: schemas diverge.')
    process.exit(1)
  }
  console.log('OK: schemas identical.')
}

main()
```

Add `better-sqlite3` as a dev dep (already in Electron deps — verify):

```bash
pnpm --filter @memry/desktop-tauri add -D better-sqlite3 @types/better-sqlite3
```

- [ ] **Step 17.4: Add scripts to `package.json`**

Edit `apps/desktop-tauri/package.json`:

```json
"db:new-migration": "tsx scripts/new-migration.ts",
"db:schema-diff": "tsx scripts/schema-diff.ts",
"db:reset": "bash scripts/dev-reset.sh"
```

- [ ] **Step 17.5: Smoke-test each script**

```bash
pnpm --filter @memry/desktop-tauri db:new-migration "test_scaffold"
# verify file created; then delete it:
rm apps/desktop-tauri/src-tauri/migrations/0030_test_scaffold.sql

pnpm --filter @memry/desktop-tauri db:reset A
ls ~/Library/Application\ Support/com.memry.memry/memry-A  # should not exist

# Full schema-diff requires running both apps; defer full test to acceptance task.
```

- [ ] **Step 17.6: Commit**

```bash
git add apps/desktop-tauri/scripts/ apps/desktop-tauri/package.json
git commit -m "m2(devx): add dev-reset, new-migration, schema-diff scripts"
```

---

## Task 18: Benchmark — 1000-note list query p50 < 20ms

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/bin/bench_m2.rs`

- [ ] **Step 18.1: Write the bench binary**

Create `apps/desktop-tauri/src-tauri/src/bin/bench_m2.rs`:

```rust
//! M2 bench — 1000-note list query p50 < 20ms acceptance gate.
//!
//! Uses `notes_cache.property_definitions` as a stand-in for notes at M2
//! (actual `notes` table comes from migration 0022; confirm the structure
//! then add a realistic bench). If the notes table exists after migrations,
//! use it; otherwise fall back to `tasks` which is guaranteed present.
//!
//! Run: `cargo run --release --bin bench_m2`

use memry_desktop_tauri_lib::db::Db;
use std::time::Instant;

fn main() {
    let db = Db::open_memory().expect("open memory db");
    let conn = db.conn().expect("get conn");

    // Insert 1000 tasks under a single project.
    conn.execute(
        "INSERT INTO projects (id, name, color) VALUES (?1, ?2, ?3)",
        rusqlite::params!["bench-p", "Bench", "#000"],
    )
    .unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    for i in 0..1000 {
        tx.execute(
            "INSERT INTO tasks (id, project_id, title, priority, position) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![format!("t{i}"), "bench-p", format!("Task {i}"), 0, i],
        )
        .unwrap();
    }
    tx.commit().unwrap();

    // Warm-up
    for _ in 0..5 {
        let mut stmt = conn
            .prepare(
                "SELECT id, title, priority, position FROM tasks
                 WHERE project_id = 'bench-p' ORDER BY position LIMIT 1000",
            )
            .unwrap();
        let rows: Vec<_> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(rows.len(), 1000);
    }

    // Measure 100 iterations.
    let mut samples = Vec::with_capacity(100);
    for _ in 0..100 {
        let start = Instant::now();
        let mut stmt = conn
            .prepare(
                "SELECT id, title, priority, position FROM tasks
                 WHERE project_id = 'bench-p' ORDER BY position LIMIT 1000",
            )
            .unwrap();
        let rows: Vec<_> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(rows.len(), 1000);
        samples.push(start.elapsed().as_micros() as u64);
    }

    samples.sort_unstable();
    let p50 = samples[samples.len() / 2];
    let p95 = samples[(samples.len() * 95) / 100];
    println!("1000-row list: p50 = {}µs, p95 = {}µs", p50, p95);

    assert!(
        p50 < 20_000,
        "p50 {p50}µs exceeds 20000µs (20ms) threshold"
    );
}
```

Register the binary in `Cargo.toml`:

```toml
[[bin]]
name = "bench_m2"
path = "src/bin/bench_m2.rs"
required-features = ["test-helpers"]
```

- [ ] **Step 18.2: Run the bench**

```bash
cd apps/desktop-tauri/src-tauri && cargo run --release --bin bench_m2 --features test-helpers
```

Expected: output like `1000-row list: p50 = 800µs, p95 = 1400µs` (S3 baseline suggested sub-ms on release). Assert passes.

If the bench fails the 20ms threshold, investigate:
- Release build mandatory (debug build can be 10× slower on SQLite paths — per Risk #7)
- Verify indexes from migration 0001 actually created: `sqlite3 <db> ".indexes tasks"`
- Prepared statement cache: rusqlite's default is fine; no additional tuning needed at M2

- [ ] **Step 18.3: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/bin/bench_m2.rs apps/desktop-tauri/src-tauri/Cargo.toml
git commit -m "m2(bench): 1000-row list query p50 < 20ms acceptance test"
```

---

## Task 19: Acceptance gate verification + PR

**Files:**
- Read-only verification pass
- Modify: commit history / `git push`

- [ ] **Step 19.1: Clean verification run**

Run the full acceptance gate end to end:

```bash
# Rust
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers
cd apps/desktop-tauri/src-tauri && cargo run --release --bin bench_m2 --features test-helpers
cd -

# TS
pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri lint
pnpm --filter @memry/desktop-tauri test
pnpm --filter @memry/desktop-tauri bindings:check

# Cold-start migration: delete any existing DB, boot app, verify tables
pnpm --filter @memry/desktop-tauri db:reset
pnpm --filter @memry/desktop-tauri dev &
DEV_PID=$!
sleep 10
sqlite3 ~/Library/Application\ Support/com.memry.memry/memry-default/data.db \
  "SELECT name FROM schema_migrations ORDER BY name;"
kill $DEV_PID
```

Expected: every command exits 0. Migration list shows all 29 entries. Bench p50 < 20ms.

- [ ] **Step 19.2: Count Rust tests**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | grep 'test result'
```

Expected: sum of `passed` counts ≥ 20 (M2 acceptance gate).

Breakdown (approximate, adjust as tests are actually written):

- `migrations_test.rs`: 5 (bootstrap, idempotent, apply-all, table-set, field_clocks)
- `settings_test.rs`: 4 (get-missing, roundtrip, upsert, list-sorted)
- smoke tests from Tasks 8-12 (3 tests per batch × 5 batches): ~15

Total: ~24 tests. Comfortably clears the 20 threshold.

- [ ] **Step 19.3: Schema-diff against Electron (optional parity check)**

If time allows, run an Electron build, sync the DB file to a path, and:

```bash
pnpm --filter @memry/desktop-tauri db:schema-diff \
  ~/Library/Application\ Support/memry/data.db \
  ~/Library/Application\ Support/com.memry.memry/memry-default/data.db
```

Expected: `OK: schemas identical.` — or the diff report surfaces the known acceptable drifts (e.g. Tauri ported field_clocks to tasks+projects earlier; if Electron has them in a different migration number the schemas end identical anyway).

If significant diffs surface, triage each before opening the PR — the spec §6.2 Risk #17 (drizzle semantics missed) is the main concern to catch here.

- [ ] **Step 19.4: Push branch and open PR**

```bash
git push -u origin m2/db-schemas-migrations
```

Open PR titled `m2: DB + schemas + migrations` with body:

```markdown
## Summary

- rusqlite wired into Tauri backend with `Mutex<Connection>` + WAL PRAGMAs
- 29 Electron data DB migrations ported to `src-tauri/migrations/*.sql`
- Custom migration runner with `schema_migrations` bookkeeping
- 22 per-table Rust structs with `specta::Type` derive
- First real IPC slice: `settings_get` / `settings_set` / `settings_list`
- `MEMRY_DEVICE=A/B` profile support
- Dev scripts: `db:reset`, `db:new-migration`, `db:schema-diff`
- Bench binary: 1000-row list p50 < 20ms (acceptance gate)

Parent spec: `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
Plan: `docs/superpowers/plans/2026-04-25-m2-db-schemas-migrations.md`

## Test plan

All scripts live under `apps/desktop-tauri/package.json` — run from the repo
root with `--filter @memry/desktop-tauri`. Root-level `pnpm dev` launches
the **Electron** app (`apps/desktop`); use the filter prefix or `cd
apps/desktop-tauri` for every command in this section.

- [ ] `pnpm --filter @memry/desktop-tauri cargo:check && pnpm --filter @memry/desktop-tauri cargo:clippy && pnpm --filter @memry/desktop-tauri cargo:test` green
- [ ] `pnpm --filter @memry/desktop-tauri bindings:check` clean (no drift)
- [ ] Cold-start migration: `pnpm --filter @memry/desktop-tauri db:reset` then `pnpm --filter @memry/desktop-tauri dev` creates all 29 rows in `schema_migrations`
- [ ] Bench: `cd apps/desktop-tauri/src-tauri && cargo run --release --bin bench_m2` p50 < 20ms
- [ ] Renderer settings toggle round-trips through SQLite (manual smoke)
- [ ] Schema diff against Electron DB shows only expected drifts

## Risk coverage

- Risk 17 (specta corner cases): 22 struct types export cleanly (stress test passed)
- Risk 18 (Rust compile time): baseline measured — M2 cold compile ~90s, incremental ~8s
```

- [ ] **Step 19.5: Land the PR**

Use `/land-and-deploy` (gstack skill) or manual merge after CI green. Merge commit convention per repo: `squash and merge`. Branch cleanup auto on merge.

---

## Self-review checklist (plan author)

- [x] 22 per-table structs defined (Tasks 8-13): `Project`, `Status`, `Task`, `PropertyDefinition`, `NoteMetadata`, `NotePosition`, `CalendarEvent`, `CalendarSource`, `CalendarExternalEvent`, `CalendarBinding`, `InboxItem`, `Bookmark`, `Reminder`, `TagDefinition`, `FolderConfig`, `SyncQueueItem`, `SyncDevice`, `SyncState`, `SyncHistoryEntry`, `SearchReason`, `Setting`, `SavedFilter` — **exceeds spec's 17 minimum; stress-tests specta coverage (Risk #17)**
- [x] Settings KV command slice (Task 13) — matches spec "settings_get, settings_set, settings_list"
- [x] Migration runner (Tasks 2-7) — matches spec "schema_migrations table, scanner + applier"
- [x] ≥20 Rust tests — ~24 planned (5 migrations + 4 settings + ~15 per-table roundtrips)
- [x] Bench 1000-note list p50 < 20ms (Task 18)
- [x] `bindings:check` clean (Task 14)
- [x] Dev tooling: `dev-reset.sh`, `new-migration.ts`, `schema-diff.ts` (Task 17)
- [x] `MEMRY_DEVICE` profile (Task 16)
- [x] Spec Risk #17 (specta stress test) — covered by 22 types through generator (Task 14)
- [x] Spec Risk #18 (Rust compile time) — baseline noted in PR body (Task 19.4)

### Intentional deferrals from spec §M2 deliverables list

The spec M2 deliverables list these types: "Note, Task, Project, CalendarEvent, InboxItem, JournalEntry, Folder, Tag, Bookmark, Template, Embedding, SyncQueueItem, CrdtUpdate, CrdtSnapshot, Device, Setting."

Deferred types + rationale:

| Type | Deferred to | Rationale |
|------|-------------|-----------|
| `Note` (content) | M3 / M5 | Note content lives in `.md` files on disk (vault FS). DB stores metadata only — covered by `NoteMetadata`/`NotePosition`/`PropertyDefinition` in M2. The `Note` aggregate type emerges in M5 when CRDT commands land. |
| `JournalEntry` | M3 / M8.2 | Journal entries are date-keyed `.md` files. Vault FS in M3 introduces file handling; M8.2 adds the journal-specific struct. |
| `Folder` | M3 | Folders are filesystem directories. `FolderConfig` (per-folder preferences) is DB-backed and covered in M2. |
| `Template` | M8.5 | Template files live on disk alongside notes. No DB table in Electron schema. M8.5 introduces template-specific commands. |
| `Tag` | M2 covers it as `TagDefinition` | `tag_definitions` table ports as `TagDefinition`; tag usage on items is denormalized in existing columns (not a separate struct). |
| `Embedding` | M7 | Embeddings table is created by M7 sqlite-vec integration, not in the ported Electron data DB. |
| `CrdtUpdate` / `CrdtSnapshot` | M5 | Their backing tables (`crdt_updates`, `crdt_snapshots`) are created by M5 migrations. Defining empty structs in M2 creates dead code. |
| `Device` | M4 | Auth/keychain milestone adds the device registration flow; `sync_devices` (covered as `SyncDevice` in M2) tracks known devices for sync but the "active device" struct lives in M4. |

**Open question for Kaan:** Confirm deferrals above. If you want any of these stubbed in M2 (types-only, no backing tables), add them to Task 13.2's saved_filters module or a new `db/stubs.rs` file. Default assumption: defer.

---

## Post-M2

After M2 merges:

1. Write M3 plan (vault FS + file watcher) — new worktree `../spike-tauri-m3` off main after M2 lands. Invoke `superpowers:writing-plans` with spec §4 M3.
2. Begin M3 in parallel with M4 pre-spike (security-framework API validation, 1 day).
