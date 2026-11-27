//! Synthetic Electron vault databases for the vault import tests (Step 36, #3553).
//!
//! Replays the frozen Electron migrations (`tests/fixtures/electron-schema`) the way drizzle's
//! migrator does (statements split on `--> statement-breakpoint`, one `__drizzle_migrations`
//! row per journal entry with `created_at` = the entry's `when`), then creates the tables the
//! Electron app creates in code at open with its own DDL. Shared by the crate's unit tests
//! (`#[path]`) and the `electron_vault_import` integration test, so it uses only crates both
//! can reach.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::Connection;
use rusqlite::types::Value;

pub const DATA_DIR: &str = "drizzle-data";
pub const INDEX_DIR: &str = "drizzle-index";

/// Tables Electron's data.db creates in code (`database/fts-tasks.ts`, `fts-inbox.ts`).
pub const DATA_CODE_DDL: &[&str] = &[
    "CREATE VIRTUAL TABLE IF NOT EXISTS fts_tasks USING fts5(
      id UNINDEXED, title, description, tags, tokenize='porter unicode61')",
    "CREATE VIRTUAL TABLE IF NOT EXISTS fts_inbox USING fts5(
      id UNINDEXED, title, content, transcription, source_title, tokenize='porter unicode61')",
];

/// Tables Electron's index.db creates in code (`database/fts.ts`, `client.ts`,
/// `voice-vectors.ts`), at `EMBEDDING_DIMENSION` 256.
pub const INDEX_CODE_DDL: &[&str] = &[
    "CREATE VIRTUAL TABLE IF NOT EXISTS fts_notes USING fts5(
      id UNINDEXED, title, content, tags, tokenize='porter unicode61')",
    "CREATE VIRTUAL TABLE IF NOT EXISTS vec_notes USING vec0(
      note_id TEXT PRIMARY KEY, embedding float[256] distance_metric=cosine)",
    "CREATE VIRTUAL TABLE IF NOT EXISTS vec_note_chunks USING vec0(
      chunk_id TEXT PRIMARY KEY, embedding float[256] distance_metric=cosine)",
    "CREATE VIRTUAL TABLE IF NOT EXISTS vec_note_similar USING vec0(
      note_id TEXT PRIMARY KEY, embedding float[256] distance_metric=cosine)",
    "CREATE VIRTUAL TABLE IF NOT EXISTS vec_images USING vec0(
      image_key TEXT PRIMARY KEY, embedding float[256] distance_metric=cosine)",
    "CREATE VIRTUAL TABLE IF NOT EXISTS vec_voice USING vec0(
      chunk_id TEXT PRIMARY KEY, embedding float[256] distance_metric=cosine)",
    "CREATE TABLE IF NOT EXISTS voice_embedding_state (
      item_id TEXT PRIMARY KEY NOT NULL, source TEXT NOT NULL,
      input_version INTEGER NOT NULL, chunks INTEGER NOT NULL)",
];

pub fn schema_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/electron-schema")
}

/// `(tag, when)` of every journal entry of one migration directory, in journal order.
pub fn journal(dir: &str) -> Vec<(String, i64)> {
    let path = schema_root().join(dir).join("meta/_journal.json");
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    json["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["tag"].as_str().unwrap().to_owned(),
                e["when"].as_i64().unwrap(),
            )
        })
        .collect()
}

/// Applies the first `upto` journal entries of `dir` (all when `None`) with their ledger rows.
pub fn replay(conn: &Connection, dir: &str, upto: Option<usize>) {
    conn.execute_batch(
        r#"CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
             id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)"#,
    )
    .unwrap();
    let entries = journal(dir);
    let upto = upto.unwrap_or(entries.len());
    for (tag, when) in &entries[..upto] {
        let sql =
            std::fs::read_to_string(schema_root().join(dir).join(format!("{tag}.sql"))).unwrap();
        for statement in sql.split("--> statement-breakpoint") {
            conn.execute_batch(statement)
                .unwrap_or_else(|e| panic!("{dir}/{tag}: {e}"));
        }
        conn.execute(
            r#"INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?1, ?2)"#,
            rusqlite::params![tag, when],
        )
        .unwrap();
    }
}

/// An Electron vault's `.memry/data.db` and `.memry/index.db`.
pub struct ElectronPair {
    pub data: PathBuf,
    pub index: PathBuf,
}

/// Creates both databases in `memry_dir` at the frozen schema, in WAL mode as Electron runs
/// them, and closes them.
pub fn create_pair(memry_dir: &Path) -> ElectronPair {
    memry_core::storage::vec::register().unwrap();
    std::fs::create_dir_all(memry_dir).unwrap();
    let pair = ElectronPair {
        data: memry_dir.join("data.db"),
        index: memry_dir.join("index.db"),
    };
    for (path, dir, code) in [
        (&pair.data, DATA_DIR, DATA_CODE_DDL),
        (&pair.index, INDEX_DIR, INDEX_CODE_DDL),
    ] {
        let conn = Connection::open(path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        replay(&conn, dir, None);
        for ddl in code {
            conn.execute_batch(ddl).unwrap();
        }
    }
    pair
}

/// A writer that keeps its WAL: autocheckpoint off and the connection held open, as a running
/// or crashed Electron leaves `data.db-wal` and `-shm` beside the file.
pub fn open_without_checkpoints(path: &Path) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    conn
}

/// Inserts one row into `table`: `values` as given, every other `NOT NULL` column without a
/// default filled with a value of its declared type, text and integers distinct per call so
/// unique columns hold. Typed builders per table come with the stage that imports the table.
pub fn seed(conn: &Connection, table: &str, values: &[(&str, Value)]) {
    static SEEDED: AtomicU64 = AtomicU64::new(0);
    let n = SEEDED.fetch_add(1, Ordering::Relaxed);
    let mut columns: Vec<String> = values.iter().map(|(c, _)| (*c).to_owned()).collect();
    let mut params: Vec<Value> = values.iter().map(|(_, v)| v.clone()).collect();
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info(\"{table}\")"))
        .unwrap();
    let info = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(!info.is_empty(), "no table {table}");
    for (name, ty, not_null, default) in info {
        if !not_null || default.is_some() || columns.contains(&name) {
            continue;
        }
        let ty = ty.to_ascii_uppercase();
        params.push(if ty.contains("INT") {
            Value::Integer(n as i64)
        } else if ty.contains("REAL") {
            Value::Real(0.0)
        } else if ty.contains("BLOB") {
            Value::Blob(Vec::new())
        } else {
            Value::Text(format!("seed-{name}-{n}"))
        });
        columns.push(name);
    }
    let names = columns
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let marks = (1..=columns.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute(
        &format!("INSERT INTO \"{table}\" ({names}) VALUES ({marks})"),
        rusqlite::params_from_iter(params),
    )
    .unwrap_or_else(|e| panic!("seed {table}: {e}"));
}

/// `(table, sql)` of every table in `conn` except `sqlite_*`, sorted.
pub fn tables(conn: &Connection) -> Vec<(String, String)> {
    let mut stmt = conn
        .prepare(
            "SELECT name, coalesce(sql, '') FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
        )
        .unwrap();
    stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}
