// Option A — rusqlite + custom Tauri commands.
//
// All DB ops live in Rust. Renderer calls via invoke().
// Connection guarded by Mutex<Connection> in Tauri State.
//
// Schema is bench-focused (notes, embeddings, FTS, blobs). Real memry
// migrations are layered on top in Task 55 via run_migrations command.

use std::path::PathBuf;
use std::sync::Mutex;

use rand::{Rng, SeedableRng};
use rand::rngs::StdRng;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

const SEED: u64 = 0xCAFE_BABE_DEAD_BEEF;
pub const EMBEDDING_DIM: usize = 128;

#[derive(Serialize, Deserialize, Clone)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub body: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

pub struct OptionADb(pub Mutex<Connection>);

impl OptionADb {
    pub fn open(path: &PathBuf) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        init_schema(&conn)?;
        Ok(Self(Mutex::new(conn)))
    }
}

fn init_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS notes (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            body        TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL,
            deleted_at  INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_notes_updated
            ON notes(updated_at DESC) WHERE deleted_at IS NULL;

        CREATE TABLE IF NOT EXISTS embeddings (
            note_id    TEXT PRIMARY KEY,
            embedding  BLOB NOT NULL
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            id UNINDEXED, title, body
        );

        CREATE TABLE IF NOT EXISTS blobs (
            key   TEXT PRIMARY KEY,
            data  BLOB NOT NULL
        );
        ",
    )
}

#[tauri::command]
pub fn db_version(state: State<OptionADb>) -> Result<String, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT sqlite_version()", [], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn option_a_list_notes(limit: i64, state: State<OptionADb>) -> Result<Vec<Note>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, title, body, created_at, updated_at, deleted_at
             FROM notes WHERE deleted_at IS NULL
             ORDER BY updated_at DESC LIMIT ?",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit], |row| {
            Ok(Note {
                id: row.get(0)?,
                title: row.get(1)?,
                body: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                deleted_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn option_a_get_note(id: String, state: State<OptionADb>) -> Result<Option<Note>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, title, body, created_at, updated_at, deleted_at
             FROM notes WHERE id = ?",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![id]).map_err(|e| e.to_string())?;
    match rows.next().map_err(|e| e.to_string())? {
        Some(row) => Ok(Some(Note {
            id: row.get(0).map_err(|e| e.to_string())?,
            title: row.get(1).map_err(|e| e.to_string())?,
            body: row.get(2).map_err(|e| e.to_string())?,
            created_at: row.get(3).map_err(|e| e.to_string())?,
            updated_at: row.get(4).map_err(|e| e.to_string())?,
            deleted_at: row.get(5).map_err(|e| e.to_string())?,
        })),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn option_a_bulk_insert(notes: Vec<Note>, state: State<OptionADb>) -> Result<usize, String> {
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut count = 0usize;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO notes (id, title, body, created_at, updated_at, deleted_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .map_err(|e| e.to_string())?;
        for n in &notes {
            stmt.execute(params![
                n.id,
                n.title,
                n.body,
                n.created_at,
                n.updated_at,
                n.deleted_at
            ])
            .map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
pub fn option_a_seed_notes(n: usize, state: State<OptionADb>) -> Result<usize, String> {
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM notes", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM notes_fts", []).map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO notes (id, title, body, created_at, updated_at, deleted_at)
                 VALUES (?, ?, ?, ?, ?, NULL)",
            )
            .map_err(|e| e.to_string())?;
        let mut fts = tx
            .prepare("INSERT INTO notes_fts (id, title, body) VALUES (?, ?, ?)")
            .map_err(|e| e.to_string())?;
        let lorem = "Lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(8);
        for i in 0..n {
            let id = format!("note-{:06}", i);
            let title = format!("Test Note #{}", i);
            let body = format!("{} body-tag-{}", lorem, i);
            let ts = now - (i as i64 * 60_000);
            stmt.execute(params![id, title, body, ts, ts])
                .map_err(|e| e.to_string())?;
            fts.execute(params![id, title, body])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(n)
}

#[tauri::command]
pub fn option_a_seed_embeddings(n: usize, state: State<OptionADb>) -> Result<usize, String> {
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM embeddings", []).map_err(|e| e.to_string())?;
    let mut rng = StdRng::seed_from_u64(SEED);
    {
        let mut stmt = tx
            .prepare("INSERT INTO embeddings (note_id, embedding) VALUES (?, ?)")
            .map_err(|e| e.to_string())?;
        for i in 0..n {
            let note_id = format!("emb-{:06}", i);
            let mut buf = Vec::with_capacity(EMBEDDING_DIM * 4);
            for _ in 0..EMBEDDING_DIM {
                let v: f32 = rng.gen_range(-1.0..1.0);
                buf.extend_from_slice(&v.to_le_bytes());
            }
            stmt.execute(params![note_id, buf])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(n)
}

#[tauri::command]
pub fn option_a_vector_search(
    query: Vec<f32>,
    k: usize,
    state: State<OptionADb>,
) -> Result<Vec<(String, f32)>, String> {
    if query.len() != EMBEDDING_DIM {
        return Err(format!(
            "query dim {} != expected {}",
            query.len(),
            EMBEDDING_DIM
        ));
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT note_id, embedding FROM embeddings")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let bytes: Vec<u8> = row.get(1)?;
            Ok((id, bytes))
        })
        .map_err(|e| e.to_string())?;
    let mut scored: Vec<(String, f32)> = Vec::new();
    for r in rows {
        let (id, bytes) = r.map_err(|e| e.to_string())?;
        if bytes.len() != EMBEDDING_DIM * 4 {
            continue;
        }
        let mut dot = 0.0f32;
        let mut na = 0.0f32;
        let mut nb = 0.0f32;
        for i in 0..EMBEDDING_DIM {
            let off = i * 4;
            let v = f32::from_le_bytes([
                bytes[off],
                bytes[off + 1],
                bytes[off + 2],
                bytes[off + 3],
            ]);
            let q = query[i];
            dot += v * q;
            na += v * v;
            nb += q * q;
        }
        let cos = if na > 0.0 && nb > 0.0 {
            dot / (na.sqrt() * nb.sqrt())
        } else {
            0.0
        };
        scored.push((id, cos));
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(k);
    Ok(scored)
}

#[tauri::command]
pub fn option_a_fts_search(
    query: String,
    limit: i64,
    state: State<OptionADb>,
) -> Result<Vec<String>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id FROM notes_fts WHERE notes_fts MATCH ? LIMIT ?")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![query, limit], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn option_a_blob_write(
    key: String,
    data: Vec<u8>,
    state: State<OptionADb>,
) -> Result<usize, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let len = data.len();
    conn.execute(
        "INSERT OR REPLACE INTO blobs (key, data) VALUES (?, ?)",
        params![key, data],
    )
    .map_err(|e| e.to_string())?;
    Ok(len)
}

#[tauri::command]
pub fn option_a_blob_read(key: String, state: State<OptionADb>) -> Result<Option<Vec<u8>>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT data FROM blobs WHERE key = ?")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![key]).map_err(|e| e.to_string())?;
    match rows.next().map_err(|e| e.to_string())? {
        Some(row) => Ok(Some(row.get(0).map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn option_a_count_notes(state: State<OptionADb>) -> Result<i64, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

pub fn db_path(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    std::fs::create_dir_all(&dir).ok();
    dir.join("s3-rusqlite.db")
}
