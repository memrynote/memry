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

    finish_create(conn, prepared, &read.parsed.content, &read.parsed.frontmatter)
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
