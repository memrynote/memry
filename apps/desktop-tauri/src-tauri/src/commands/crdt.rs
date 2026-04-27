//! CRDT IPC commands for renderer-backed Yjs providers.

use crate::app_state::AppState;
use crate::crdt::wire::{CrdtUpdateEvent, CRDT_UPDATE_EVENT};
use crate::crdt::{
    apply_update_v1, encode_diff_since_v1, encode_snapshot_v1, encode_state_vector_v1, origin_tag,
    CrdtRuntime, DocHandle,
};
use crate::error::{AppError, AppResult};
use crate::vault::{notes_io, VaultRuntime};
use std::sync::Arc;
use tauri::{ipc::Response, AppHandle, Emitter, State};

pub const MAX_INLINE_UPDATE_BYTES: usize = 8 * 1024;

pub async fn crdt_open_doc_inner(
    conn: &rusqlite::Connection,
    vault: &VaultRuntime,
    crdt: Arc<CrdtRuntime>,
    note_id: &str,
) -> AppResult<()> {
    let mut open_state = load_open_doc_state(conn, note_id)?;
    hydrate_open_doc_seed(vault, &mut open_state).await?;
    let seed = apply_open_doc_state(crdt, note_id, open_state).await?;
    if let Some(seed) = seed {
        crate::db::crdt_updates::append(conn, note_id, &seed, origin_tag() as i64)?;
    }

    Ok(())
}

pub async fn crdt_close_doc_inner(crdt: Arc<CrdtRuntime>, note_id: &str) {
    crdt.docs().close_doc(note_id).await;
}

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CrdtApplyUpdateInput {
    pub note_id: String,
    pub update: Vec<u8>,
    pub origin: Option<u32>,
}

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CrdtChunkStartInput {
    pub note_id: String,
    pub transfer_id: String,
    pub total_bytes: usize,
}

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CrdtChunkAppendInput {
    pub transfer_id: String,
    pub offset: usize,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CrdtChunkFinishInput {
    pub note_id: String,
    pub transfer_id: String,
    pub origin: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncStep1Result {
    pub diff: Vec<u8>,
    pub state_vector: Vec<u8>,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CrdtSimpleSuccess {
    pub success: bool,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CrdtApplyUpdateResult {
    pub seq: i64,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CrdtGetOrInitDocResult {
    pub note_id: String,
    pub ready: bool,
}

pub async fn crdt_apply_update_inner(
    conn: &rusqlite::Connection,
    crdt: Arc<CrdtRuntime>,
    note_id: &str,
    update_bytes: &[u8],
    incoming_origin: u32,
) -> AppResult<i64> {
    let handle =
        apply_update_to_runtime(crdt, note_id, update_bytes, incoming_origin, true).await?;
    persist_applied_update(conn, &handle, note_id, update_bytes, incoming_origin)
}

pub async fn crdt_apply_update_chunk_start_inner(
    crdt: Arc<CrdtRuntime>,
    note_id: &str,
    transfer_id: &str,
    total_bytes: usize,
) -> AppResult<()> {
    if total_bytes > crate::db::crdt_updates::MAX_BLOB_BYTES {
        return Err(AppError::Validation(format!(
            "crdt update {} bytes exceeds cap {}",
            total_bytes,
            crate::db::crdt_updates::MAX_BLOB_BYTES
        )));
    }
    crdt.start_update_chunk(note_id, transfer_id, total_bytes)
        .await
}

pub async fn crdt_apply_update_chunk_append_inner(
    crdt: Arc<CrdtRuntime>,
    transfer_id: &str,
    offset: usize,
    bytes: Vec<u8>,
) -> AppResult<()> {
    crdt.append_update_chunk(transfer_id, offset, bytes).await
}

pub async fn crdt_apply_update_chunk_finish_inner(
    conn: &rusqlite::Connection,
    crdt: Arc<CrdtRuntime>,
    note_id: &str,
    transfer_id: &str,
    incoming_origin: u32,
) -> AppResult<i64> {
    let update = crdt.finish_update_chunk(note_id, transfer_id).await?;
    let handle = apply_update_to_runtime(crdt, note_id, &update, incoming_origin, false).await?;
    persist_applied_update(conn, &handle, note_id, &update, incoming_origin)
}

pub async fn crdt_get_snapshot_bytes(crdt: Arc<CrdtRuntime>, note_id: &str) -> AppResult<Vec<u8>> {
    let handle = crdt
        .docs()
        .get(note_id)
        .await
        .ok_or_else(|| AppError::NotFound(format!("crdt doc {note_id}")))?;
    encode_snapshot_v1(&handle)
}

pub async fn crdt_get_state_vector_bytes(
    crdt: Arc<CrdtRuntime>,
    note_id: &str,
) -> AppResult<Vec<u8>> {
    let handle = crdt
        .docs()
        .get(note_id)
        .await
        .ok_or_else(|| AppError::NotFound(format!("crdt doc {note_id}")))?;
    encode_state_vector_v1(&handle)
}

pub async fn crdt_sync_step_1_inner(
    crdt: Arc<CrdtRuntime>,
    note_id: &str,
    state_vector: &[u8],
) -> AppResult<SyncStep1Result> {
    let handle = crdt
        .docs()
        .get(note_id)
        .await
        .ok_or_else(|| AppError::NotFound(format!("crdt doc {note_id}")))?;
    let diff = encode_diff_since_v1(&handle, state_vector)?;
    let sv = encode_state_vector_v1(&handle)?;
    Ok(SyncStep1Result {
        diff,
        state_vector: sv,
    })
}

pub async fn crdt_sync_step_2_inner(
    conn: &rusqlite::Connection,
    crdt: Arc<CrdtRuntime>,
    note_id: &str,
    diff: &[u8],
) -> AppResult<i64> {
    crdt_apply_update_inner(conn, crdt, note_id, diff, origin_tag()).await
}

pub async fn crdt_get_or_init_doc_inner(
    conn: &rusqlite::Connection,
    vault: &VaultRuntime,
    crdt: Arc<CrdtRuntime>,
    note_id: &str,
) -> AppResult<()> {
    crdt_open_doc_inner(conn, vault, crdt, note_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_open_doc(
    state: State<'_, AppState>,
    note_id: String,
) -> AppResult<CrdtSimpleSuccess> {
    let mut open_state = {
        let conn = state.db.conn()?;
        load_open_doc_state(&conn, &note_id)?
    };
    hydrate_open_doc_seed(&state.vault, &mut open_state).await?;
    let seed = apply_open_doc_state(state.crdt.clone(), &note_id, open_state).await?;
    if let Some(seed) = seed {
        let conn = state.db.conn()?;
        crate::db::crdt_updates::append(&conn, &note_id, &seed, origin_tag() as i64)?;
    }
    Ok(CrdtSimpleSuccess { success: true })
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_close_doc(state: State<'_, AppState>, note_id: String) -> AppResult<()> {
    crdt_close_doc_inner(state.crdt.clone(), &note_id).await;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_apply_update(
    state: State<'_, AppState>,
    app: AppHandle,
    input: CrdtApplyUpdateInput,
) -> AppResult<CrdtApplyUpdateResult> {
    let incoming_origin = input.origin.unwrap_or_else(origin_tag);
    let handle = apply_update_to_runtime(
        state.crdt.clone(),
        &input.note_id,
        &input.update,
        incoming_origin,
        true,
    )
    .await?;
    let seq = {
        let conn = state.db.conn()?;
        persist_applied_update(
            &conn,
            &handle,
            &input.note_id,
            &input.update,
            incoming_origin,
        )?
    };

    let payload = CrdtUpdateEvent {
        note_id: input.note_id.clone(),
        update: input.update,
        origin: incoming_origin,
    };
    let _ = app.emit(CRDT_UPDATE_EVENT, payload);

    Ok(CrdtApplyUpdateResult { seq })
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_apply_update_chunk_start(
    state: State<'_, AppState>,
    input: CrdtChunkStartInput,
) -> AppResult<()> {
    crdt_apply_update_chunk_start_inner(
        state.crdt.clone(),
        &input.note_id,
        &input.transfer_id,
        input.total_bytes,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_apply_update_chunk_append(
    state: State<'_, AppState>,
    input: CrdtChunkAppendInput,
) -> AppResult<()> {
    crdt_apply_update_chunk_append_inner(
        state.crdt.clone(),
        &input.transfer_id,
        input.offset,
        input.bytes,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_apply_update_chunk_finish(
    state: State<'_, AppState>,
    app: AppHandle,
    input: CrdtChunkFinishInput,
) -> AppResult<CrdtApplyUpdateResult> {
    let incoming_origin = input.origin.unwrap_or_else(origin_tag);
    let update = state
        .crdt
        .finish_update_chunk(&input.note_id, &input.transfer_id)
        .await?;
    let handle = apply_update_to_runtime(
        state.crdt.clone(),
        &input.note_id,
        &update,
        incoming_origin,
        false,
    )
    .await?;
    let seq = {
        let conn = state.db.conn()?;
        persist_applied_update(&conn, &handle, &input.note_id, &update, incoming_origin)?
    };

    let payload = CrdtUpdateEvent {
        note_id: input.note_id.clone(),
        update,
        origin: incoming_origin,
    };
    let _ = app.emit(CRDT_UPDATE_EVENT, payload);

    Ok(CrdtApplyUpdateResult { seq })
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_get_snapshot(state: State<'_, AppState>, note_id: String) -> AppResult<Response> {
    let bytes = crdt_get_snapshot_bytes(state.crdt.clone(), &note_id).await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_get_state_vector(
    state: State<'_, AppState>,
    note_id: String,
) -> AppResult<Response> {
    let bytes = crdt_get_state_vector_bytes(state.crdt.clone(), &note_id).await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_sync_step_1(
    state: State<'_, AppState>,
    note_id: String,
    state_vector: Vec<u8>,
) -> AppResult<SyncStep1Result> {
    crdt_sync_step_1_inner(state.crdt.clone(), &note_id, &state_vector).await
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_sync_step_2(
    state: State<'_, AppState>,
    app: AppHandle,
    note_id: String,
    diff: Vec<u8>,
) -> AppResult<()> {
    let incoming_origin = origin_tag();
    let handle =
        apply_update_to_runtime(state.crdt.clone(), &note_id, &diff, incoming_origin, true).await?;
    {
        let conn = state.db.conn()?;
        persist_applied_update(&conn, &handle, &note_id, &diff, incoming_origin)?;
    }

    let payload = CrdtUpdateEvent {
        note_id,
        update: diff,
        origin: incoming_origin,
    };
    let _ = app.emit(CRDT_UPDATE_EVENT, payload);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_get_or_init_doc(
    state: State<'_, AppState>,
    note_id: String,
) -> AppResult<CrdtGetOrInitDocResult> {
    let mut open_state = {
        let conn = state.db.conn()?;
        load_open_doc_state(&conn, &note_id)?
    };
    hydrate_open_doc_seed(&state.vault, &mut open_state).await?;
    let seed = apply_open_doc_state(state.crdt.clone(), &note_id, open_state).await?;
    if let Some(seed) = seed {
        let conn = state.db.conn()?;
        crate::db::crdt_updates::append(&conn, &note_id, &seed, origin_tag() as i64)?;
    }
    Ok(CrdtGetOrInitDocResult {
        note_id,
        ready: true,
    })
}

struct OpenDocState {
    snapshot: Option<Vec<u8>>,
    updates: Vec<PersistedUpdate>,
    seed_path: Option<String>,
    seed_markdown: Option<String>,
}

struct PersistedUpdate {
    bytes: Vec<u8>,
    origin: u32,
}

fn load_open_doc_state(conn: &rusqlite::Connection, note_id: &str) -> AppResult<OpenDocState> {
    use crate::db::{crdt_snapshots, crdt_updates};

    let snapshot = crdt_snapshots::get_latest(conn, note_id)?.map(|row| row.snapshot_bytes);
    let updates = crdt_updates::list_for_note(conn, note_id)?
        .into_iter()
        .map(|row| PersistedUpdate {
            bytes: row.update_bytes,
            origin: row.origin as u32,
        })
        .collect::<Vec<_>>();

    let seed_path = if snapshot.is_none() && updates.is_empty() {
        crate::db::note_metadata::get_active_by_id(conn, note_id)?.map(|row| row.path)
    } else {
        None
    };

    Ok(OpenDocState {
        snapshot,
        updates,
        seed_path,
        seed_markdown: None,
    })
}

async fn hydrate_open_doc_seed(
    vault: &VaultRuntime,
    open_state: &mut OpenDocState,
) -> AppResult<()> {
    let Some(path) = open_state.seed_path.take() else {
        return Ok(());
    };
    open_state.seed_markdown = load_seed_markdown(vault, &path).await?;
    Ok(())
}

async fn load_seed_markdown(vault: &VaultRuntime, path: &str) -> AppResult<Option<String>> {
    let root = vault.require_current()?;
    let Some(read) = notes_io::read_note_from_disk(&root, path).await? else {
        return Ok(None);
    };
    Ok(Some(read.parsed.content))
}

async fn apply_open_doc_state(
    crdt: Arc<CrdtRuntime>,
    note_id: &str,
    open_state: OpenDocState,
) -> AppResult<Option<Vec<u8>>> {
    let (handle, created) = crdt.docs().open_or_init_with_created(note_id).await;
    if !created {
        return Ok(None);
    }

    let seed = if let Some(snapshot) = open_state.snapshot {
        apply_update_v1(&handle, &snapshot, origin_tag())?;
        None
    } else if open_state.updates.is_empty() {
        if let Some(markdown) = open_state.seed_markdown {
            crate::crdt::seed::seed_from_markdown(&handle, &markdown)?;
            Some(encode_snapshot_v1(&handle)?)
        } else {
            None
        }
    } else {
        None
    };

    for update in open_state.updates {
        apply_update_v1(&handle, &update.bytes, update.origin)?;
    }

    Ok(seed)
}

async fn apply_update_to_runtime(
    crdt: Arc<CrdtRuntime>,
    note_id: &str,
    update_bytes: &[u8],
    incoming_origin: u32,
    enforce_inline_cap: bool,
) -> AppResult<DocHandle> {
    if enforce_inline_cap && update_bytes.len() > MAX_INLINE_UPDATE_BYTES {
        return Err(AppError::Validation(format!(
            "update {} bytes exceeds inline cap {} - use chunked transport",
            update_bytes.len(),
            MAX_INLINE_UPDATE_BYTES
        )));
    }

    let handle = crdt.docs().get_or_init(note_id).await;
    apply_update_v1(&handle, update_bytes, incoming_origin)?;
    Ok(handle)
}

fn persist_applied_update(
    conn: &rusqlite::Connection,
    handle: &DocHandle,
    note_id: &str,
    update_bytes: &[u8],
    incoming_origin: u32,
) -> AppResult<i64> {
    use crate::db::{crdt_snapshots, crdt_updates};

    let seq = crdt_updates::append(conn, note_id, update_bytes, incoming_origin as i64)?;
    let replaced_through_seq = crdt_snapshots::get_latest(conn, note_id)?
        .map(|snapshot| snapshot.replaced_through_seq)
        .unwrap_or(0);
    if seq - replaced_through_seq >= crate::crdt::COMPACT_THRESHOLD {
        let result = crate::crdt::compact_doc(handle, seq)?;
        let sv = encode_state_vector_v1(handle)?;
        crdt_snapshots::upsert_with_compaction(
            conn,
            note_id,
            &result.snapshot_bytes,
            &sv,
            result.replaced_through_seq,
        )?;
    }
    Ok(seq)
}
