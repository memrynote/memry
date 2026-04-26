//! Notes IPC commands. Thin handlers that compose vault FS + DB + CRDT.

use crate::app_state::AppState;
use crate::db::note_metadata::NoteMetadata;
use crate::db::note_metadata::NoteMetadataRow;
use crate::error::{AppError, AppResult};
use crate::vault::frontmatter::NoteFrontmatter;
use crate::vault::{notes_io, VaultRuntime};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

/// Renderer-shape note (matches `@memry/contracts/notes-api.ts::Note`).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteDto {
    pub id: String,
    pub path: String,
    pub title: String,
    pub content: String,
    pub frontmatter: serde_json::Value,
    pub created: String,
    pub modified: String,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub word_count: i64,
    pub emoji: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteListItem {
    pub id: String,
    pub path: String,
    pub title: String,
    pub created: String,
    pub modified: String,
    pub tags: Vec<String>,
    pub word_count: i64,
    pub snippet: String,
    pub emoji: Option<String>,
    pub local_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteListResponse {
    pub notes: Vec<NoteListItem>,
    pub total: i64,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteListOptions {
    pub folder: Option<String>,
    pub tags: Option<Vec<String>>,
    pub sort_by: Option<String>,
    pub sort_order: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteCreateInput {
    pub title: String,
    pub content: Option<String>,
    pub folder: Option<String>,
    pub tags: Option<Vec<String>>,
    pub template: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteCreateResponse {
    pub success: bool,
    pub note: Option<NoteDto>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpdateInput {
    pub id: String,
    pub title: Option<String>,
    pub content: Option<String>,
    pub tags: Option<Vec<String>>,
    pub frontmatter: Option<serde_json::Value>,
    pub emoji: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpdateResponse {
    pub success: bool,
    pub note: Option<NoteDto>,
    pub error: Option<String>,
}

pub(crate) fn into_dto(row: &NoteMetadata, body: &str, frontmatter: &NoteFrontmatter) -> NoteDto {
    NoteDto {
        id: row.id.clone(),
        path: row.path.clone(),
        title: row.title.clone(),
        content: body.to_string(),
        frontmatter: serde_json::Value::Object(Default::default()),
        created: row.created_at.clone(),
        modified: row.modified_at.clone(),
        tags: frontmatter.tags.clone(),
        aliases: frontmatter.aliases.clone(),
        word_count: body.split_whitespace().count() as i64,
        emoji: row.emoji.clone(),
    }
}

pub(crate) fn snippet_of(body: &str) -> String {
    body.chars().take(200).collect()
}

pub(crate) fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = nanos.as_secs();
    let millis = nanos.subsec_millis();
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(secs as i64, millis * 1_000_000)
        .unwrap_or_else(chrono::Utc::now);
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub async fn notes_create_inner(
    conn: &Connection,
    vault: &VaultRuntime,
    input: NoteCreateInput,
) -> AppResult<NoteCreateResponse> {
    let prepared = prepare_create(input)?;
    let root = vault.require_current()?;

    notes_io::write_note_to_disk(
        &root,
        &prepared.relative,
        &prepared.frontmatter,
        &prepared.body,
    )
    .await?;
    let read = notes_io::read_note_from_disk(&root, &prepared.relative)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("note file {}", prepared.relative)))?;

    finish_create(
        conn,
        prepared,
        &read.parsed.content,
        &read.parsed.frontmatter,
    )
}

pub async fn notes_get_inner(
    conn: &Connection,
    vault: &VaultRuntime,
    id: &str,
) -> AppResult<Option<NoteDto>> {
    let Some(row) = crate::db::note_metadata::get_by_id(conn, id)? else {
        return Ok(None);
    };

    read_note_dto(vault, row).await.map(Some)
}

pub async fn notes_get_by_path_inner(
    conn: &Connection,
    vault: &VaultRuntime,
    path: &str,
) -> AppResult<Option<NoteDto>> {
    let Some(row) = crate::db::note_metadata::get_by_path(conn, path)? else {
        return Ok(None);
    };

    read_note_dto(vault, row).await.map(Some)
}

pub async fn notes_update_inner(
    conn: &Connection,
    vault: &VaultRuntime,
    input: NoteUpdateInput,
) -> AppResult<NoteUpdateResponse> {
    let row = crate::db::note_metadata::get_by_id(conn, &input.id)?
        .ok_or_else(|| AppError::NotFound(format!("note {}", input.id)))?;
    let updated = apply_update_to_vault(vault, row, input).await?;

    finish_update(conn, updated)
}

pub async fn notes_delete_inner(
    conn: &Connection,
    vault: &VaultRuntime,
    id: &str,
) -> AppResult<serde_json::Value> {
    let row = crate::db::note_metadata::get_by_id(conn, id)?
        .ok_or_else(|| AppError::NotFound(format!("note {id}")))?;
    let root = vault.require_current()?;
    notes_io::move_note_to_trash(&root, &row.path, &row.id).await?;
    let deleted_at = now_iso();

    finish_delete(conn, &row, &deleted_at)
}

pub fn notes_list_inner(
    conn: &Connection,
    options: Option<NoteListOptions>,
) -> AppResult<NoteListResponse> {
    let opts = options.unwrap_or_else(default_list_options);
    let limit = opts.limit.unwrap_or(100).clamp(0, 1000);
    let offset = opts.offset.unwrap_or(0).max(0);
    let sort_by = opts.sort_by.as_deref().unwrap_or("modified");
    let sort_order = opts.sort_order.as_deref().unwrap_or("desc");
    let folder = opts.folder.as_deref();

    let rows = crate::db::notes_cache::list_active_filtered(
        conn, folder, limit, offset, sort_by, sort_order,
    )?;
    let total = crate::db::notes_cache::count_active_filtered(conn, folder)?;
    let has_more = offset + (rows.len() as i64) < total;

    Ok(NoteListResponse {
        notes: rows.into_iter().map(list_item_from_cache).collect(),
        total,
        has_more,
    })
}

pub fn notes_list_by_folder_inner(
    conn: &Connection,
    folder_id: &str,
) -> AppResult<NoteListResponse> {
    notes_list_inner(
        conn,
        Some(NoteListOptions {
            folder: Some(folder_id.to_string()),
            tags: None,
            sort_by: Some("position".into()),
            sort_order: Some("asc".into()),
            limit: Some(1000),
            offset: Some(0),
        }),
    )
}

#[tauri::command]
#[specta::specta]
pub async fn notes_create(
    state: State<'_, AppState>,
    app: AppHandle,
    input: NoteCreateInput,
) -> AppResult<NoteCreateResponse> {
    let prepared = prepare_create(input)?;
    let root = state.vault.require_current()?;

    notes_io::write_note_to_disk(
        &root,
        &prepared.relative,
        &prepared.frontmatter,
        &prepared.body,
    )
    .await?;
    let read = notes_io::read_note_from_disk(&root, &prepared.relative)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("note file {}", prepared.relative)))?;

    let conn = state.db.conn()?;
    let resp = finish_create(
        &conn,
        prepared,
        &read.parsed.content,
        &read.parsed.frontmatter,
    )?;
    drop(conn);

    if let Some(note) = &resp.note {
        let _ = app.emit(
            "note-created",
            serde_json::json!({ "note": note, "source": "internal" }),
        );
    }
    Ok(resp)
}

#[tauri::command]
#[specta::specta]
pub async fn notes_get(state: State<'_, AppState>, id: String) -> AppResult<Option<NoteDto>> {
    let row = {
        let conn = state.db.conn()?;
        crate::db::note_metadata::get_by_id(&conn, &id)?
    };
    let Some(row) = row else {
        return Ok(None);
    };

    read_note_dto(&state.vault, row).await.map(Some)
}

#[tauri::command]
#[specta::specta]
pub async fn notes_get_by_path(
    state: State<'_, AppState>,
    path: String,
) -> AppResult<Option<NoteDto>> {
    let row = {
        let conn = state.db.conn()?;
        crate::db::note_metadata::get_by_path(&conn, &path)?
    };
    let Some(row) = row else {
        return Ok(None);
    };

    read_note_dto(&state.vault, row).await.map(Some)
}

#[tauri::command]
#[specta::specta]
pub async fn notes_update(
    state: State<'_, AppState>,
    app: AppHandle,
    input: NoteUpdateInput,
) -> AppResult<NoteUpdateResponse> {
    let row = {
        let conn = state.db.conn()?;
        crate::db::note_metadata::get_by_id(&conn, &input.id)?
    }
    .ok_or_else(|| AppError::NotFound(format!("note {}", input.id)))?;

    let updated = apply_update_to_vault(&state.vault, row, input).await?;
    let conn = state.db.conn()?;
    let resp = finish_update(&conn, updated)?;
    drop(conn);

    if let Some(note) = &resp.note {
        let _ = app.emit(
            "note-updated",
            serde_json::json!({
                "id": note.id,
                "changes": { "title": note.title },
                "source": "internal"
            }),
        );
    }
    Ok(resp)
}

#[tauri::command]
#[specta::specta]
pub async fn notes_delete(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
) -> AppResult<serde_json::Value> {
    let row = {
        let conn = state.db.conn()?;
        crate::db::note_metadata::get_by_id(&conn, &id)?
    }
    .ok_or_else(|| AppError::NotFound(format!("note {id}")))?;

    let root = state.vault.require_current()?;
    notes_io::move_note_to_trash(&root, &row.path, &row.id).await?;
    let deleted_at = now_iso();

    let conn = state.db.conn()?;
    let resp = finish_delete(&conn, &row, &deleted_at)?;
    drop(conn);

    let _ = app.emit(
        "note-deleted",
        serde_json::json!({ "id": id, "path": row.path, "source": "internal" }),
    );
    Ok(resp)
}

#[tauri::command]
#[specta::specta]
pub fn notes_list(
    state: State<'_, AppState>,
    options: Option<NoteListOptions>,
) -> AppResult<NoteListResponse> {
    let conn = state.db.conn()?;
    notes_list_inner(&conn, options)
}

#[tauri::command]
#[specta::specta]
pub fn notes_list_by_folder(
    state: State<'_, AppState>,
    folder_id: String,
) -> AppResult<NoteListResponse> {
    let conn = state.db.conn()?;
    notes_list_by_folder_inner(&conn, &folder_id)
}

async fn read_note_dto(vault: &VaultRuntime, row: NoteMetadata) -> AppResult<NoteDto> {
    let root = vault.require_current()?;
    let read = notes_io::read_note_from_disk(&root, &row.path)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("note file {}", row.path)))?;

    Ok(into_dto(
        &row,
        &read.parsed.content,
        &read.parsed.frontmatter,
    ))
}

struct PreparedUpdate {
    row: NoteMetadata,
    body: String,
    frontmatter: NoteFrontmatter,
}

async fn apply_update_to_vault(
    vault: &VaultRuntime,
    mut row: NoteMetadata,
    input: NoteUpdateInput,
) -> AppResult<PreparedUpdate> {
    let root = vault.require_current()?;
    let read = notes_io::read_note_from_disk(&root, &row.path)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("note file {}", row.path)))?;
    let mut frontmatter = read.parsed.frontmatter;
    let mut body = read.parsed.content;

    if let Some(title) = input.title {
        let title = title.trim().to_string();
        if title.is_empty() {
            return Err(AppError::Validation("title is empty".into()));
        }
        row.title = title.clone();
        frontmatter.title = Some(title);
    }
    if let Some(content) = input.content {
        row.file_size = Some(content.len() as i64);
        body = content;
    }
    if let Some(tags) = input.tags {
        frontmatter.tags = tags;
    }
    if let Some(emoji) = input.emoji {
        row.emoji = emoji.clone();
        frontmatter.emoji = emoji;
    }

    row.modified_at = now_iso();
    frontmatter.modified = row.modified_at.clone();
    notes_io::write_note_to_disk(&root, &row.path, &frontmatter, &body).await?;

    Ok(PreparedUpdate {
        row,
        body,
        frontmatter,
    })
}

fn finish_update(conn: &Connection, updated: PreparedUpdate) -> AppResult<NoteUpdateResponse> {
    use crate::db::{note_metadata, notes_cache};

    let row = metadata_to_upsert_row(&updated.row);
    note_metadata::upsert(conn, &row)?;
    notes_cache::refresh_for(conn, &updated.row, &updated.body, &updated.frontmatter.tags)?;

    Ok(NoteUpdateResponse {
        success: true,
        note: Some(into_dto(&updated.row, &updated.body, &updated.frontmatter)),
        error: None,
    })
}

fn finish_delete(
    conn: &Connection,
    row: &NoteMetadata,
    deleted_at: &str,
) -> AppResult<serde_json::Value> {
    use crate::db::{note_metadata, note_positions, notes_cache};

    note_metadata::delete_soft(conn, &row.id, deleted_at)?;
    notes_cache::delete(conn, &row.id)?;
    note_positions::drop_for_note(conn, &row.path)?;

    Ok(serde_json::json!({ "success": true }))
}

fn default_list_options() -> NoteListOptions {
    NoteListOptions {
        folder: None,
        tags: None,
        sort_by: Some("modified".into()),
        sort_order: Some("desc".into()),
        limit: Some(100),
        offset: Some(0),
    }
}

fn list_item_from_cache(row: crate::db::notes_cache::NotesCacheRow) -> NoteListItem {
    let tags = serde_json::from_str(&row.tags_json).unwrap_or_default();
    NoteListItem {
        id: row.id,
        path: row.path,
        title: row.title,
        created: row.created_at,
        modified: row.modified_at,
        tags,
        word_count: row.word_count,
        snippet: snippet_of(&row.snippet),
        emoji: row.emoji,
        local_only: row.local_only,
    }
}

struct PreparedCreate {
    relative: String,
    body: String,
    frontmatter: NoteFrontmatter,
    row: NoteMetadataRow,
}

fn prepare_create(input: NoteCreateInput) -> AppResult<PreparedCreate> {
    use crate::vault::frontmatter::create_frontmatter;

    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::Validation("title is empty".into()));
    }

    let folder = input.folder.unwrap_or_default();
    let slug = slug_for(&title);
    let relative = if folder.trim().is_empty() {
        format!("{slug}.md")
    } else {
        format!("{}/{slug}.md", folder.trim().trim_matches('/'))
    };
    let body = input.content.unwrap_or_default();
    let id = nanoid::nanoid!(21);
    let now = now_iso();
    let tags = input.tags.unwrap_or_default();

    let mut frontmatter = create_frontmatter(&title, &tags);
    frontmatter.id = id.clone();
    frontmatter.created = now.clone();
    frontmatter.modified = now.clone();

    let row = NoteMetadataRow {
        id: id.clone(),
        path: relative.clone(),
        title,
        emoji: None,
        file_type: "markdown".into(),
        mime_type: None,
        file_size: Some(body.len() as i64),
        attachment_id: None,
        attachment_references: None,
        local_only: false,
        sync_policy: "sync".into(),
        journal_date: None,
        property_definition_names: None,
        clock: None,
        synced_at: None,
        created_at: now.clone(),
        modified_at: now,
    };

    Ok(PreparedCreate {
        relative,
        body,
        frontmatter,
        row,
    })
}

fn finish_create(
    conn: &Connection,
    prepared: PreparedCreate,
    body: &str,
    frontmatter: &NoteFrontmatter,
) -> AppResult<NoteCreateResponse> {
    use crate::db::{note_metadata, notes_cache};

    let id = prepared.row.id.clone();
    note_metadata::upsert(conn, &prepared.row)?;

    let metadata = note_metadata::get_by_id(conn, &id)?
        .ok_or_else(|| AppError::NotFound(format!("note {id}")))?;
    notes_cache::refresh_for(conn, &metadata, body, &frontmatter.tags)?;

    Ok(NoteCreateResponse {
        success: true,
        note: Some(into_dto(&metadata, body, frontmatter)),
        error: None,
    })
}

fn metadata_to_upsert_row(row: &NoteMetadata) -> NoteMetadataRow {
    NoteMetadataRow {
        id: row.id.clone(),
        path: row.path.clone(),
        title: row.title.clone(),
        emoji: row.emoji.clone(),
        file_type: row.file_type.clone(),
        mime_type: row.mime_type.clone(),
        file_size: row.file_size,
        attachment_id: row.attachment_id.clone(),
        attachment_references: row.attachment_references.clone(),
        local_only: row.local_only,
        sync_policy: row.sync_policy.clone(),
        journal_date: row.journal_date.clone(),
        property_definition_names: row.property_definition_names.clone(),
        clock: row.clock.clone(),
        synced_at: row.synced_at.clone(),
        created_at: row.created_at.clone(),
        modified_at: row.modified_at.clone(),
    }
}

fn slug_for(title: &str) -> String {
    let slug = title
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    if slug.is_empty() {
        "untitled".into()
    } else {
        slug
    }
}
