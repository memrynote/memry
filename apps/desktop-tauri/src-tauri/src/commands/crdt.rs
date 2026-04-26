//! CRDT IPC commands for renderer-backed Yjs providers.

use crate::app_state::AppState;
use crate::crdt::{CrdtRuntime, apply_update_v1, encode_snapshot_v1, origin_tag};
use crate::error::AppResult;
use crate::vault::{VaultRuntime, frontmatter, paths as vault_paths};
use std::sync::Arc;
use tauri::State;
use yrs::{Text, WriteTxn};

pub const MAX_INLINE_UPDATE_BYTES: usize = 8 * 1024;

pub async fn crdt_open_doc_inner(
    conn: &rusqlite::Connection,
    vault: &VaultRuntime,
    crdt: Arc<CrdtRuntime>,
    note_id: &str,
) -> AppResult<()> {
    let open_state = load_open_doc_state(conn, vault, note_id)?;
    let seed = apply_open_doc_state(crdt, note_id, open_state).await?;
    if let Some(seed) = seed {
        crate::db::crdt_updates::append(conn, note_id, &seed, origin_tag() as i64)?;
    }

    Ok(())
}

pub async fn crdt_close_doc_inner(crdt: Arc<CrdtRuntime>, note_id: &str) {
    crdt.docs().drop_doc(note_id).await;
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_open_doc(
    state: State<'_, AppState>,
    note_id: String,
) -> AppResult<serde_json::Value> {
    let open_state = {
        let conn = state.db.conn()?;
        load_open_doc_state(&conn, &state.vault, &note_id)?
    };
    let seed = apply_open_doc_state(state.crdt.clone(), &note_id, open_state).await?;
    if let Some(seed) = seed {
        let conn = state.db.conn()?;
        crate::db::crdt_updates::append(&conn, &note_id, &seed, origin_tag() as i64)?;
    }
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_close_doc(state: State<'_, AppState>, note_id: String) -> AppResult<()> {
    crdt_close_doc_inner(state.crdt.clone(), &note_id).await;
    Ok(())
}

struct OpenDocState {
    snapshot: Option<Vec<u8>>,
    updates: Vec<PersistedUpdate>,
    seed_body: Option<String>,
}

struct PersistedUpdate {
    bytes: Vec<u8>,
    origin: u32,
}

fn load_open_doc_state(
    conn: &rusqlite::Connection,
    vault: &VaultRuntime,
    note_id: &str,
) -> AppResult<OpenDocState> {
    use crate::db::{crdt_snapshots, crdt_updates};

    let snapshot = crdt_snapshots::get_latest(conn, note_id)?.map(|row| row.snapshot_bytes);
    let updates = crdt_updates::list_for_note(conn, note_id)?
        .into_iter()
        .map(|row| PersistedUpdate {
            bytes: row.update_bytes,
            origin: row.origin as u32,
        })
        .collect::<Vec<_>>();
    let seed_body = if snapshot.is_none() && updates.is_empty() {
        crate::db::note_metadata::get_by_id(conn, note_id)?
            .map(|row| read_note_body(vault, &row.path))
            .transpose()?
    } else {
        None
    };

    Ok(OpenDocState {
        snapshot,
        updates,
        seed_body,
    })
}

async fn apply_open_doc_state(
    crdt: Arc<CrdtRuntime>,
    note_id: &str,
    open_state: OpenDocState,
) -> AppResult<Option<Vec<u8>>> {
    let handle = crdt.docs().get_or_init(note_id).await;

    let seed = if let Some(snapshot) = open_state.snapshot {
        apply_update_v1(&handle, &snapshot, origin_tag())?;
        None
    } else if let Some(body) = open_state.seed_body {
        if !body.is_empty() {
            handle.with_write(|txn| {
                txn.get_or_insert_text("body").insert(txn, 0, &body);
            });
        }
        Some(encode_snapshot_v1(&handle)?)
    } else {
        None
    };

    for update in open_state.updates {
        apply_update_v1(&handle, &update.bytes, update.origin)?;
    }

    Ok(seed)
}

fn read_note_body(vault: &VaultRuntime, relative_path: &str) -> AppResult<String> {
    let root = vault.require_current()?;
    let abs = vault_paths::resolve_supported(&root, relative_path)?;
    let raw = match std::fs::read_to_string(abs) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(err) => return Err(err.into()),
    };
    let parsed = frontmatter::parse_note(&raw, Some(relative_path))?;
    Ok(parsed.content)
}
