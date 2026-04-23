// S2 Prototype A: Renderer-owned Y.Doc. Rust side is persistence ONLY.
// Yjs lives in renderer (JS Yjs + y-prosemirror). Each Y.Doc.on('update') pushes
// binary update bytes to Rust via append_crdt_update; snapshots via save/load.

use rusqlite::{params, Connection};
use std::sync::Mutex;
use tauri::State;

struct DbState(Mutex<Connection>);

fn init_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open sqlite");
    conn.execute(
        "CREATE TABLE IF NOT EXISTS crdt_snapshots (
            note_id TEXT PRIMARY KEY,
            bytes BLOB NOT NULL
        )",
        [],
    )
    .expect("create snapshots table");
    conn.execute(
        "CREATE TABLE IF NOT EXISTS crdt_updates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id TEXT NOT NULL,
            bytes BLOB NOT NULL,
            ts INTEGER NOT NULL
        )",
        [],
    )
    .expect("create updates table");
    conn
}

#[tauri::command]
fn save_crdt_snapshot(
    note_id: String,
    bytes: Vec<u8>,
    state: State<DbState>,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO crdt_snapshots (note_id, bytes) VALUES (?, ?)
         ON CONFLICT(note_id) DO UPDATE SET bytes = excluded.bytes",
        params![note_id, bytes],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_crdt_snapshot(
    note_id: String,
    state: State<DbState>,
) -> Result<Option<Vec<u8>>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT bytes FROM crdt_snapshots WHERE note_id = ?")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![note_id]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let bytes: Vec<u8> = row.get(0).map_err(|e| e.to_string())?;
        Ok(Some(bytes))
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn append_crdt_update(
    note_id: String,
    bytes: Vec<u8>,
    state: State<DbState>,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO crdt_updates (note_id, bytes, ts) VALUES (?, ?, ?)",
        params![note_id, bytes, ts],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn count_crdt_updates(note_id: String, state: State<DbState>) -> Result<i64, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM crdt_updates WHERE note_id = ?",
            params![note_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(count)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let conn = init_db();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(DbState(Mutex::new(conn)))
        .invoke_handler(tauri::generate_handler![
            save_crdt_snapshot,
            load_crdt_snapshot,
            append_crdt_update,
            count_crdt_updates,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
