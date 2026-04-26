//! Notes IPC commands. Thin handlers that compose vault FS + DB + CRDT.

use crate::app_state::AppState;
use crate::db::note_metadata::NoteMetadata;
use crate::db::note_metadata::NoteMetadataRow;
use crate::error::{AppError, AppResult};
use crate::vault::frontmatter::NoteFrontmatter;
use crate::vault::{VaultRuntime, fs as vault_fs, notes_io, paths as vault_paths};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ops::Deref;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct JsonUnknown(serde_json::Value);

impl JsonUnknown {
    fn into_value(self) -> serde_json::Value {
        self.0
    }
}

impl From<serde_json::Value> for JsonUnknown {
    fn from(value: serde_json::Value) -> Self {
        Self(value)
    }
}

impl Deref for JsonUnknown {
    type Target = serde_json::Value;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl specta::Type for JsonUnknown {
    fn definition(types: &mut specta::Types) -> specta::datatype::DataType {
        <specta_typescript::Unknown as specta::Type>::definition(types)
    }
}

/// Renderer-shape note (matches `@memry/contracts/notes-api.ts::Note`).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteDto {
    pub id: String,
    pub path: String,
    pub title: String,
    pub content: String,
    pub frontmatter: JsonUnknown,
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
    pub frontmatter: Option<JsonUnknown>,
    pub emoji: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpdateResponse {
    pub success: bool,
    pub note: Option<NoteDto>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteDeleteResponse {
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteSimpleSuccess {
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteLocalOnlyCount {
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteTagInfo {
    pub tag: String,
    pub count: i64,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteLink {
    pub source_id: String,
    pub target_id: Option<String>,
    pub target_title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteIncomingLink {
    pub source_id: String,
    pub source_path: String,
    pub source_title: String,
    pub contexts: Vec<NoteLinkContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteLinkContext {
    pub snippet: String,
    pub link_start: i64,
    pub link_end: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteLinksResponse {
    pub outgoing: Vec<NoteLink>,
    pub incoming: Vec<NoteIncomingLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NotePreview {
    pub id: String,
    pub title: String,
    pub path: String,
    pub snippet: String,
    pub emoji: Option<String>,
    pub tags: Vec<NotePreviewTag>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NotePreviewTag {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WikiLinkResolution {
    pub id: String,
    pub path: String,
    pub title: String,
    pub file_type: String,
}

pub(crate) fn into_dto(
    row: &NoteMetadata,
    body: &str,
    frontmatter: &NoteFrontmatter,
) -> AppResult<NoteDto> {
    Ok(NoteDto {
        id: row.id.clone(),
        path: row.path.clone(),
        title: row.title.clone(),
        content: body.to_string(),
        frontmatter: JsonUnknown::from(serde_json::to_value(frontmatter)?),
        created: row.created_at.clone(),
        modified: row.modified_at.clone(),
        tags: frontmatter.tags.clone(),
        aliases: frontmatter.aliases.clone(),
        word_count: body.split_whitespace().count() as i64,
        emoji: row.emoji.clone(),
    })
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
    let prepared = prepare_create(vault, input).await?;
    let root = vault.require_current()?;

    ensure_db_path_available(conn, &prepared.relative)?;
    ensure_vault_path_available(&root, &prepared.relative).await?;
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
    let Some(row) = crate::db::note_metadata::get_active_by_id(conn, id)? else {
        return Ok(None);
    };

    read_note_dto(vault, row).await.map(Some)
}

pub async fn notes_get_by_path_inner(
    conn: &Connection,
    vault: &VaultRuntime,
    path: &str,
) -> AppResult<Option<NoteDto>> {
    let Some(row) = crate::db::note_metadata::get_active_by_path(conn, path)? else {
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
) -> AppResult<NoteDeleteResponse> {
    let row = crate::db::note_metadata::get_by_id(conn, id)?
        .ok_or_else(|| AppError::NotFound(format!("note {id}")))?;
    let root = vault.require_current()?;
    notes_io::move_note_to_trash(&root, &row.path, &row.id).await?;
    let deleted_at = now_iso();

    finish_delete(conn, &row, &deleted_at)
}

pub async fn notes_rename_inner(
    conn: &Connection,
    vault: &VaultRuntime,
    id: &str,
    new_title: &str,
) -> AppResult<NoteUpdateResponse> {
    let trimmed = new_title.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("title is empty".into()));
    }
    let row = crate::db::note_metadata::get_by_id(conn, id)?
        .ok_or_else(|| AppError::NotFound(format!("note {id}")))?;
    let folder = row
        .path
        .rsplit_once('/')
        .map(|(prefix, _)| prefix.to_string())
        .unwrap_or_default();
    let slug = slug_for(trimmed);
    let new_path = if folder.is_empty() {
        format!("{slug}.md")
    } else {
        format!("{folder}/{slug}.md")
    };
    if new_path != row.path {
        ensure_db_path_available(conn, &new_path)?;
    }

    let prepared = relocate_note_on_disk(vault, &row, &new_path, Some(trimmed.to_string())).await?;
    finish_update(conn, prepared)
}

pub async fn notes_move_inner(
    conn: &Connection,
    vault: &VaultRuntime,
    id: &str,
    new_folder: &str,
) -> AppResult<NoteUpdateResponse> {
    let folder = new_folder.trim().trim_matches('/');
    let row = crate::db::note_metadata::get_by_id(conn, id)?
        .ok_or_else(|| AppError::NotFound(format!("note {id}")))?;
    let basename = row.path.rsplit('/').next().unwrap_or(&row.path).to_string();
    let new_path = if folder.is_empty() {
        basename
    } else {
        format!("{folder}/{basename}")
    };
    if new_path != row.path {
        ensure_db_path_available(conn, &new_path)?;
    }

    let prepared = relocate_note_on_disk(vault, &row, &new_path, None).await?;
    finish_update(conn, prepared)
}

pub fn notes_exists_inner(conn: &Connection, title_or_path: &str) -> AppResult<bool> {
    if crate::db::note_metadata::exists_path(conn, title_or_path)? {
        return Ok(true);
    }
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM note_metadata
         WHERE title = ?1 COLLATE NOCASE
           AND coalesce(json_extract(clock, '$.deleted_at'), '') = ''",
        [title_or_path],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

pub async fn notes_set_local_only_inner(
    vault: &VaultRuntime,
    conn: &Connection,
    id: &str,
    local_only: bool,
) -> AppResult<NoteSimpleSuccess> {
    let mut row = crate::db::note_metadata::get_by_id(conn, id)?
        .ok_or_else(|| AppError::NotFound(format!("note {id}")))?;
    let root = vault.require_current()?;
    let read = notes_io::read_note_from_disk(&root, &row.path)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("note file {}", row.path)))?;
    let mut frontmatter = read.parsed.frontmatter;
    let body = read.parsed.content;

    frontmatter.local_only = Some(local_only);
    let modified_at = now_iso();
    frontmatter.modified = modified_at.clone();
    notes_io::write_note_to_disk(&root, &row.path, &frontmatter, &body).await?;

    row.local_only = local_only;
    row.sync_policy = if local_only {
        "local-only".into()
    } else {
        "sync".into()
    };
    row.modified_at = modified_at.clone();
    let upsert_row = metadata_to_upsert_row(&row);
    crate::db::note_metadata::upsert(conn, &upsert_row)?;
    crate::db::notes_cache::set_local_only(conn, id, local_only)?;
    Ok(NoteSimpleSuccess { success: true })
}

pub fn notes_get_local_only_count_inner(conn: &Connection) -> AppResult<NoteLocalOnlyCount> {
    let count = crate::db::note_metadata::count_local_only(conn)?;
    Ok(NoteLocalOnlyCount { count })
}

pub fn notes_get_tags_inner(conn: &Connection) -> AppResult<Vec<NoteTagInfo>> {
    let rows = crate::db::tag_definitions::list_with_counts(conn)?;
    Ok(rows
        .into_iter()
        .map(|tag| NoteTagInfo {
            tag: tag.name,
            count: tag.count,
            color: tag.color,
        })
        .collect())
}

pub async fn notes_get_links_inner(
    conn: &Connection,
    vault: &VaultRuntime,
    id: &str,
) -> AppResult<NoteLinksResponse> {
    let row = crate::db::note_metadata::get_active_by_id(conn, id)?
        .ok_or_else(|| AppError::NotFound(format!("note {id}")))?;
    let root = vault.require_current()?;

    let body = notes_io::read_note_from_disk(&root, &row.path)
        .await?
        .map(|read| read.parsed.content)
        .unwrap_or_default();
    let outgoing = extract_wikilinks(&body)
        .into_iter()
        .map(|target| NoteLink {
            source_id: row.id.clone(),
            target_id: None,
            target_title: target,
        })
        .collect();

    // TODO(M7): replace LIKE-scan with FTS5 backlink index. M5 stays on
    // SQLite LIKE because the corpus is small enough that an O(N) scan is
    // cheaper than maintaining a parallel index.
    let candidates: Vec<(String, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, path, title FROM note_metadata
             WHERE id != ?1
               AND coalesce(json_extract(clock, '$.deleted_at'), '') = ''",
        )?;
        let rows = stmt.query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        out
    };

    let mut incoming = Vec::new();
    for (source_id, source_path, source_title) in candidates {
        let candidate_body = notes_io::read_note_from_disk(&root, &source_path)
            .await
            .ok()
            .flatten()
            .map(|read| read.parsed.content)
            .unwrap_or_default();
        if body_links_to_title(&candidate_body, &row.title) {
            incoming.push(NoteIncomingLink {
                source_id,
                source_path,
                source_title,
                contexts: vec![NoteLinkContext {
                    snippet: snippet_of(&candidate_body),
                    link_start: 0,
                    link_end: 0,
                }],
            });
        }
    }

    Ok(NoteLinksResponse { outgoing, incoming })
}

pub fn notes_resolve_by_title_inner(
    conn: &Connection,
    title: &str,
) -> AppResult<Option<WikiLinkResolution>> {
    // SQL LIKE/COLLATE NOCASE is good enough for M5; FTS upgrade in M7.
    let row = conn.query_row(
        "SELECT c.id, c.title, c.path, coalesce(m.file_type, 'markdown')
           FROM notes_cache c
           LEFT JOIN note_metadata m ON m.id = c.id
          WHERE c.title = ?1 COLLATE NOCASE
          LIMIT 1",
        [title],
        |r| {
            Ok(WikiLinkResolution {
                id: r.get(0)?,
                title: r.get(1)?,
                path: r.get(2)?,
                file_type: r.get(3)?,
            })
        },
    );
    match row {
        Ok(item) => Ok(Some(item)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

pub fn notes_preview_by_title_inner(
    conn: &Connection,
    title: &str,
) -> AppResult<Option<NotePreview>> {
    let Some(item) = note_list_item_by_title(conn, title)? else {
        return Ok(None);
    };
    let tags = note_preview_tags(conn, &item.tags)?;
    Ok(Some(NotePreview {
        id: item.id,
        title: item.title,
        path: item.path,
        snippet: item.snippet,
        emoji: item.emoji,
        tags,
        created_at: item.created,
    }))
}

fn note_list_item_by_title(conn: &Connection, title: &str) -> AppResult<Option<NoteListItem>> {
    let row = conn.query_row(
        "SELECT id, title, path, snippet, word_count, tags_json, emoji,
                modified_at, created_at, local_only
           FROM notes_cache
          WHERE title = ?1 COLLATE NOCASE
          LIMIT 1",
        [title],
        |r| {
            Ok(NoteListItem {
                id: r.get(0)?,
                title: r.get(1)?,
                path: r.get(2)?,
                snippet: r.get(3)?,
                word_count: r.get(4)?,
                tags: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
                emoji: r.get(6)?,
                modified: r.get(7)?,
                created: r.get(8)?,
                local_only: r.get::<_, i64>(9)? != 0,
            })
        },
    );
    match row {
        Ok(item) => Ok(Some(item)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn note_preview_tags(conn: &Connection, tags: &[String]) -> AppResult<Vec<NotePreviewTag>> {
    let mut out = Vec::with_capacity(tags.len());
    for tag in tags {
        let color = conn.query_row(
            "SELECT color FROM tag_definitions WHERE name = ?1 LIMIT 1",
            [tag],
            |row| row.get::<_, String>(0),
        );
        let color = match color {
            Ok(color) => color,
            Err(rusqlite::Error::QueryReturnedNoRows) => String::new(),
            Err(err) => return Err(err.into()),
        };
        out.push(NotePreviewTag {
            name: tag.clone(),
            color,
        });
    }
    Ok(out)
}

fn extract_wikilinks(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(end) = body[i + 2..].find("]]") {
                let inner = &body[i + 2..i + 2 + end];
                let target = inner.split('|').next().unwrap_or("").trim();
                if !target.is_empty() {
                    out.push(target.to_string());
                }
                i += 2 + end + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn body_links_to_title(body: &str, title: &str) -> bool {
    let normalized_title = title.trim().to_lowercase();
    extract_wikilinks(body)
        .into_iter()
        .any(|target| target.trim().to_lowercase() == normalized_title)
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
    let tag_filter: Option<&[String]> = opts.tags.as_deref();

    let rows = crate::db::notes_cache::list_active_filtered(
        conn, folder, tag_filter, limit, offset, sort_by, sort_order,
    )?;
    let total = crate::db::notes_cache::count_active_filtered(conn, folder, tag_filter)?;
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
    title: String,
    content: Option<String>,
    folder: Option<String>,
    tags: Option<Vec<String>>,
    template: Option<String>,
) -> AppResult<NoteCreateResponse> {
    let input = NoteCreateInput {
        title,
        content,
        folder,
        tags,
        template,
    };
    let prepared = prepare_create(&state.vault, input).await?;
    let root = state.vault.require_current()?;

    {
        let conn = state.db.conn()?;
        ensure_db_path_available(&conn, &prepared.relative)?;
    }
    ensure_vault_path_available(&root, &prepared.relative).await?;
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
pub async fn notes_get(
    state: State<'_, AppState>,
    args: Vec<String>,
) -> AppResult<Option<NoteDto>> {
    let id = single_string_arg(args, "id")?;
    let row = {
        let conn = state.db.conn()?;
        crate::db::note_metadata::get_active_by_id(&conn, &id)?
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
    args: Vec<String>,
) -> AppResult<Option<NoteDto>> {
    let path = single_string_arg(args, "path")?;
    let row = {
        let conn = state.db.conn()?;
        crate::db::note_metadata::get_active_by_path(&conn, &path)?
    };
    let Some(row) = row else {
        return Ok(None);
    };

    read_note_dto(&state.vault, row).await.map(Some)
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn notes_update(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
    title: Option<String>,
    content: Option<String>,
    tags: Option<Vec<String>>,
    frontmatter: Option<JsonUnknown>,
    emoji: Option<Option<String>>,
) -> AppResult<NoteUpdateResponse> {
    let input = NoteUpdateInput {
        id,
        title,
        content,
        tags,
        frontmatter,
        emoji,
    };
    let event_input = input.clone();
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
                "changes": note_update_event_changes(&event_input, note),
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
    args: Vec<String>,
) -> AppResult<NoteDeleteResponse> {
    let id = single_string_arg(args, "id")?;
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
    folder: Option<String>,
    tags: Option<Vec<String>>,
    sort_by: Option<String>,
    sort_order: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<NoteListResponse> {
    let conn = state.db.conn()?;
    let options = Some(NoteListOptions {
        folder,
        tags,
        sort_by,
        sort_order,
        limit,
        offset,
    });
    notes_list_inner(&conn, options)
}

#[tauri::command]
#[specta::specta]
pub fn notes_list_by_folder(
    state: State<'_, AppState>,
    args: Vec<String>,
) -> AppResult<NoteListResponse> {
    let folder_id = single_string_arg(args, "folder_id")?;
    let conn = state.db.conn()?;
    notes_list_by_folder_inner(&conn, &folder_id)
}

#[tauri::command]
#[specta::specta]
pub async fn notes_rename(
    state: State<'_, AppState>,
    app: AppHandle,
    args: Vec<String>,
) -> AppResult<NoteUpdateResponse> {
    // Renderer calls `notesService.rename(id, newTitle)` which the forwarder
    // packs as `{ args: [id, newTitle] }`. Mirror the positional shape used
    // by `notes_get` / `notes_delete` so deserialization succeeds.
    let (id, new_title) = two_string_args(args, "notes_rename", "id", "new_title")?;
    let trimmed = new_title.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("title is empty".into()));
    }
    let row = {
        let conn = state.db.conn()?;
        crate::db::note_metadata::get_by_id(&conn, &id)?
    }
    .ok_or_else(|| AppError::NotFound(format!("note {id}")))?;

    let folder = row
        .path
        .rsplit_once('/')
        .map(|(prefix, _)| prefix.to_string())
        .unwrap_or_default();
    let slug = slug_for(trimmed);
    let new_path = if folder.is_empty() {
        format!("{slug}.md")
    } else {
        format!("{folder}/{slug}.md")
    };

    if new_path != row.path {
        let conn = state.db.conn()?;
        ensure_db_path_available(&conn, &new_path)?;
    }

    let old_path = row.path.clone();
    let old_title = row.title.clone();
    let prepared =
        relocate_note_on_disk(&state.vault, &row, &new_path, Some(trimmed.to_string())).await?;

    let conn = state.db.conn()?;
    let resp = finish_update(&conn, prepared)?;
    drop(conn);

    if let Some(note) = &resp.note {
        let _ = app.emit(
            "note-renamed",
            serde_json::json!({
                "id": note.id,
                "oldPath": old_path,
                "newPath": note.path,
                "oldTitle": old_title,
                "newTitle": note.title,
                "source": "internal"
            }),
        );
    }
    Ok(resp)
}

#[tauri::command]
#[specta::specta]
pub async fn notes_move(
    state: State<'_, AppState>,
    app: AppHandle,
    args: Vec<String>,
) -> AppResult<NoteUpdateResponse> {
    // Renderer calls `notesService.move(id, newFolder)` → `{ args: [id, newFolder] }`.
    let (id, new_folder) = two_string_args(args, "notes_move", "id", "new_folder")?;
    let folder = new_folder.trim().trim_matches('/');
    let row = {
        let conn = state.db.conn()?;
        crate::db::note_metadata::get_by_id(&conn, &id)?
    }
    .ok_or_else(|| AppError::NotFound(format!("note {id}")))?;

    let basename = row.path.rsplit('/').next().unwrap_or(&row.path).to_string();
    let new_path = if folder.is_empty() {
        basename
    } else {
        format!("{folder}/{basename}")
    };

    if new_path != row.path {
        let conn = state.db.conn()?;
        ensure_db_path_available(&conn, &new_path)?;
    }

    let old_path = row.path.clone();
    let prepared = relocate_note_on_disk(&state.vault, &row, &new_path, None).await?;

    let conn = state.db.conn()?;
    let resp = finish_update(&conn, prepared)?;
    drop(conn);

    if let Some(note) = &resp.note {
        let _ = app.emit(
            "note-moved",
            serde_json::json!({
                "id": note.id,
                "oldPath": old_path,
                "newPath": note.path,
                "source": "internal"
            }),
        );
    }
    Ok(resp)
}

#[tauri::command]
#[specta::specta]
pub fn notes_exists(state: State<'_, AppState>, args: Vec<String>) -> AppResult<bool> {
    let title_or_path = single_string_arg(args, "title_or_path")?;
    let conn = state.db.conn()?;
    notes_exists_inner(&conn, &title_or_path)
}

#[tauri::command]
#[specta::specta]
pub async fn notes_set_local_only(
    state: State<'_, AppState>,
    args: Vec<JsonUnknown>,
) -> AppResult<NoteSimpleSuccess> {
    // Renderer calls `notesService.setLocalOnly(id, value)` → `{ args: [id, true] }`.
    // Mixed-type positional args (string + bool) so we use the json-value
    // envelope and pluck both fields manually.
    let (id, local_only) = match args.as_slice() {
        [first, second] => {
            let id = first
                .as_str()
                .ok_or_else(|| {
                    AppError::Validation("notes_set_local_only id must be string".into())
                })?
                .to_string();
            let local_only = second.as_bool().ok_or_else(|| {
                AppError::Validation("notes_set_local_only local_only must be boolean".into())
            })?;
            (id, local_only)
        }
        _ => {
            return Err(AppError::Validation(
                "notes_set_local_only expects exactly two args (id, local_only)".into(),
            ));
        }
    };
    // Snapshot the row, then drop the guard before any disk I/O — the
    // MutexGuard is !Send so it cannot live across `.await` when Tauri runs
    // commands on the multi-threaded runtime. Mirrors `notes_update`.
    let row = {
        let conn = state.db.conn()?;
        crate::db::note_metadata::get_by_id(&conn, &id)?
    }
    .ok_or_else(|| AppError::NotFound(format!("note {id}")))?;

    let root = state.vault.require_current()?;
    let read = notes_io::read_note_from_disk(&root, &row.path)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("note file {}", row.path)))?;
    let mut frontmatter = read.parsed.frontmatter;
    let body = read.parsed.content;

    frontmatter.local_only = Some(local_only);
    let modified_at = now_iso();
    frontmatter.modified = modified_at.clone();
    notes_io::write_note_to_disk(&root, &row.path, &frontmatter, &body).await?;

    let mut updated = row;
    updated.local_only = local_only;
    updated.sync_policy = if local_only {
        "local-only".into()
    } else {
        "sync".into()
    };
    updated.modified_at = modified_at;

    let conn = state.db.conn()?;
    crate::db::note_metadata::upsert(&conn, &metadata_to_upsert_row(&updated))?;
    crate::db::notes_cache::set_local_only(&conn, &id, local_only)?;

    Ok(NoteSimpleSuccess { success: true })
}

#[tauri::command]
#[specta::specta]
pub fn notes_get_local_only_count(state: State<'_, AppState>) -> AppResult<NoteLocalOnlyCount> {
    let conn = state.db.conn()?;
    notes_get_local_only_count_inner(&conn)
}

#[tauri::command]
#[specta::specta]
pub fn notes_get_tags(state: State<'_, AppState>) -> AppResult<Vec<NoteTagInfo>> {
    let conn = state.db.conn()?;
    notes_get_tags_inner(&conn)
}

#[tauri::command]
#[specta::specta]
pub async fn notes_get_links(
    state: State<'_, AppState>,
    args: Vec<String>,
) -> AppResult<NoteLinksResponse> {
    let id = single_string_arg(args, "id")?;
    let row = {
        let conn = state.db.conn()?;
        crate::db::note_metadata::get_active_by_id(&conn, &id)?
    }
    .ok_or_else(|| AppError::NotFound(format!("note {id}")))?;
    let root = state.vault.require_current()?;
    let body = notes_io::read_note_from_disk(&root, &row.path)
        .await?
        .map(|read| read.parsed.content)
        .unwrap_or_default();
    let outgoing = extract_wikilinks(&body)
        .into_iter()
        .map(|target| NoteLink {
            source_id: row.id.clone(),
            target_id: None,
            target_title: target,
        })
        .collect();

    let candidates: Vec<(String, String, String)> = {
        let conn = state.db.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, path, title FROM note_metadata
             WHERE id != ?1
               AND coalesce(json_extract(clock, '$.deleted_at'), '') = ''",
        )?;
        let rows = stmt.query_map([&id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        out
    };

    let mut incoming = Vec::new();
    for (source_id, source_path, source_title) in candidates {
        let candidate_body = notes_io::read_note_from_disk(&root, &source_path)
            .await
            .ok()
            .flatten()
            .map(|read| read.parsed.content)
            .unwrap_or_default();
        if body_links_to_title(&candidate_body, &row.title) {
            incoming.push(NoteIncomingLink {
                source_id,
                source_path,
                source_title,
                contexts: vec![NoteLinkContext {
                    snippet: snippet_of(&candidate_body),
                    link_start: 0,
                    link_end: 0,
                }],
            });
        }
    }

    Ok(NoteLinksResponse { outgoing, incoming })
}

#[tauri::command]
#[specta::specta]
pub fn notes_resolve_by_title(
    state: State<'_, AppState>,
    args: Vec<String>,
) -> AppResult<Option<WikiLinkResolution>> {
    let title = single_string_arg(args, "title")?;
    let conn = state.db.conn()?;
    notes_resolve_by_title_inner(&conn, &title)
}

#[tauri::command]
#[specta::specta]
pub fn notes_preview_by_title(
    state: State<'_, AppState>,
    args: Vec<String>,
) -> AppResult<Option<NotePreview>> {
    let title = single_string_arg(args, "title")?;
    let conn = state.db.conn()?;
    notes_preview_by_title_inner(&conn, &title)
}

fn single_string_arg(args: Vec<String>, name: &str) -> AppResult<String> {
    match args.as_slice() {
        [value] => Ok(value.clone()),
        _ => Err(AppError::Validation(format!(
            "{name} expects exactly one argument"
        ))),
    }
}

fn two_string_args(
    args: Vec<String>,
    command: &str,
    first: &str,
    second: &str,
) -> AppResult<(String, String)> {
    match args.as_slice() {
        [a, b] => Ok((a.clone(), b.clone())),
        _ => Err(AppError::Validation(format!(
            "{command} expects exactly two arguments ({first}, {second})"
        ))),
    }
}

fn ensure_db_path_available(conn: &Connection, relative: &str) -> AppResult<()> {
    if crate::db::note_metadata::get_by_path(conn, relative)?.is_some() {
        return Err(AppError::Conflict(format!(
            "note path already exists: {relative}"
        )));
    }
    Ok(())
}

async fn ensure_vault_path_available(root: &std::path::Path, relative: &str) -> AppResult<()> {
    let abs = vault_paths::resolve_supported(root, relative)?;
    if vault_fs::safe_read(&abs).await?.is_some() {
        return Err(AppError::Conflict(format!(
            "note file already exists: {relative}"
        )));
    }
    Ok(())
}

async fn read_note_dto(vault: &VaultRuntime, row: NoteMetadata) -> AppResult<NoteDto> {
    let root = vault.require_current()?;
    let read = notes_io::read_note_from_disk(&root, &row.path)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("note file {}", row.path)))?;

    into_dto(&row, &read.parsed.content, &read.parsed.frontmatter)
}

struct PreparedUpdate {
    row: NoteMetadata,
    body: String,
    frontmatter: NoteFrontmatter,
}

async fn relocate_note_on_disk(
    vault: &VaultRuntime,
    row: &NoteMetadata,
    new_path: &str,
    new_title: Option<String>,
) -> AppResult<PreparedUpdate> {
    let root = vault.require_current()?;
    let read = notes_io::read_note_from_disk(&root, &row.path)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("note file {}", row.path)))?;
    let mut frontmatter = read.parsed.frontmatter;
    let body = read.parsed.content;
    let mut updated = row.clone();
    updated.modified_at = now_iso();
    frontmatter.modified = updated.modified_at.clone();

    if let Some(title) = new_title {
        updated.title = title.clone();
        frontmatter.title = Some(title);
    }

    if new_path == row.path {
        notes_io::write_note_to_disk(&root, new_path, &frontmatter, &body).await?;
    } else {
        ensure_vault_path_available(&root, new_path).await?;
        notes_io::write_note_to_disk(&root, new_path, &frontmatter, &body).await?;
        notes_io::delete_note_from_disk(&root, &row.path).await?;
        updated.path = new_path.to_string();
    }

    Ok(PreparedUpdate {
        row: updated,
        body,
        frontmatter,
    })
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
    let parsed = read.parsed;
    let mut frontmatter = parsed.frontmatter;
    let old_body = parsed.content;
    let mut body = old_body.clone();
    let body_changed = input.content.is_some();
    let explicit_tags = input.tags.is_some();

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
    if let Some(frontmatter_patch) = input.frontmatter {
        merge_frontmatter_patch(&mut row, &mut frontmatter, frontmatter_patch.into_value())?;
    }

    if body_changed && !explicit_tags {
        reconcile_inline_tags(&mut frontmatter.tags, &old_body, &body);
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

fn reconcile_inline_tags(existing: &mut Vec<String>, old_body: &str, new_body: &str) {
    let old_inline = crate::db::tag_definitions::inline_tags(old_body);
    let new_inline = crate::db::tag_definitions::inline_tags(new_body);

    existing.retain(|tag| {
        !old_inline.iter().any(|old_tag| old_tag == tag)
            || new_inline.iter().any(|new_tag| new_tag == tag)
    });

    for tag in new_inline {
        if !existing.iter().any(|t| t == &tag) {
            existing.push(tag);
        }
    }
}

fn merge_frontmatter_patch(
    row: &mut NoteMetadata,
    frontmatter: &mut NoteFrontmatter,
    patch: serde_json::Value,
) -> AppResult<()> {
    let object = patch
        .as_object()
        .ok_or_else(|| AppError::Validation("frontmatter must be an object".into()))?;

    for (key, value) in object {
        match key.as_str() {
            "id" | "created" | "modified" => {
                return Err(AppError::Validation(format!(
                    "frontmatter field {key} is read-only"
                )));
            }
            "title" => {
                let title = value
                    .as_str()
                    .ok_or_else(|| {
                        AppError::Validation("frontmatter title must be a string".into())
                    })?
                    .trim()
                    .to_string();
                if title.is_empty() {
                    return Err(AppError::Validation("title is empty".into()));
                }
                row.title = title.clone();
                frontmatter.title = Some(title);
            }
            "tags" => {
                frontmatter.tags = json_string_array(value, "frontmatter tags")?;
            }
            "aliases" => {
                frontmatter.aliases = json_string_array(value, "frontmatter aliases")?;
            }
            "emoji" => {
                let emoji = json_optional_string(value, "frontmatter emoji")?;
                row.emoji = emoji.clone();
                frontmatter.emoji = emoji;
            }
            "localOnly" => {
                let local_only = value.as_bool().ok_or_else(|| {
                    AppError::Validation("frontmatter localOnly must be a boolean".into())
                })?;
                row.local_only = local_only;
                row.sync_policy = if local_only {
                    "local-only".into()
                } else {
                    "sync".into()
                };
                frontmatter.local_only = Some(local_only);
            }
            "properties" => {
                frontmatter.properties = Some(json_object_to_yaml_map(value, "properties")?);
            }
            _ => {
                frontmatter
                    .extra
                    .insert(key.clone(), serde_yaml_ng::to_value(value)?);
            }
        }
    }

    Ok(())
}

fn json_string_array(value: &serde_json::Value, field: &str) -> AppResult<Vec<String>> {
    let array = value
        .as_array()
        .ok_or_else(|| AppError::Validation(format!("{field} must be an array")))?;
    let mut out = Vec::with_capacity(array.len());
    for item in array {
        let s = item
            .as_str()
            .ok_or_else(|| AppError::Validation(format!("{field} must contain strings")))?;
        out.push(s.to_string());
    }
    Ok(out)
}

fn json_optional_string(value: &serde_json::Value, field: &str) -> AppResult<Option<String>> {
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .map(|s| Some(s.to_string()))
        .ok_or_else(|| AppError::Validation(format!("{field} must be a string or null")))
}

pub fn note_update_event_changes(input: &NoteUpdateInput, note: &NoteDto) -> serde_json::Value {
    let mut changes = serde_json::Map::new();
    if input.title.is_some() {
        changes.insert("title".into(), serde_json::json!(note.title));
    }
    if input.content.is_some() {
        changes.insert("content".into(), serde_json::json!(note.content));
    }
    if input.tags.is_some() {
        changes.insert("tags".into(), serde_json::json!(note.tags));
    }
    if let Some(frontmatter) = &input.frontmatter {
        changes.insert("frontmatter".into(), serde_json::json!(note.frontmatter));
        if frontmatter.get("emoji").is_some() {
            changes.insert("emoji".into(), serde_json::json!(note.emoji));
        }
    }
    if input.emoji.is_some() {
        changes.insert("emoji".into(), serde_json::json!(note.emoji));
    }
    serde_json::Value::Object(changes)
}

fn json_object_to_yaml_map(
    value: &serde_json::Value,
    field: &str,
) -> AppResult<BTreeMap<String, serde_yaml_ng::Value>> {
    let object = value
        .as_object()
        .ok_or_else(|| AppError::Validation(format!("{field} must be an object")))?;
    let mut out = BTreeMap::new();
    for (key, value) in object {
        out.insert(key.clone(), serde_yaml_ng::to_value(value)?);
    }
    Ok(out)
}

fn finish_update(conn: &Connection, updated: PreparedUpdate) -> AppResult<NoteUpdateResponse> {
    use crate::db::{note_metadata, notes_cache};

    let row = metadata_to_upsert_row(&updated.row);
    note_metadata::upsert(conn, &row)?;
    notes_cache::refresh_for(conn, &updated.row, &updated.body, &updated.frontmatter.tags)?;

    Ok(NoteUpdateResponse {
        success: true,
        note: Some(into_dto(&updated.row, &updated.body, &updated.frontmatter)?),
        error: None,
    })
}

fn finish_delete(
    conn: &Connection,
    row: &NoteMetadata,
    deleted_at: &str,
) -> AppResult<NoteDeleteResponse> {
    use crate::db::{note_metadata, note_positions, notes_cache};

    note_metadata::delete_soft(conn, &row.id, deleted_at)?;
    notes_cache::delete(conn, &row.id)?;
    note_positions::drop_for_note(conn, &row.path)?;

    Ok(NoteDeleteResponse { success: true })
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

struct AppliedTemplate {
    body: String,
    tags: Vec<String>,
    properties: BTreeMap<String, serde_yaml_ng::Value>,
}

async fn prepare_create(vault: &VaultRuntime, input: NoteCreateInput) -> AppResult<PreparedCreate> {
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
    let applied_template = match input.template.as_deref() {
        Some(template_id) => load_template(vault, template_id, &title).await?,
        None => None,
    };
    let body = match input.content {
        Some(content) if content.trim().is_empty() => applied_template
            .as_ref()
            .map(|template| template.body.clone())
            .unwrap_or(content),
        Some(content) => content,
        None => applied_template
            .as_ref()
            .map(|template| template.body.clone())
            .unwrap_or_default(),
    };
    let id = nanoid::nanoid!(21);
    let now = now_iso();
    let mut tags = applied_template
        .as_ref()
        .map(|template| template.tags.clone())
        .unwrap_or_default();
    for tag in input.tags.unwrap_or_default() {
        if !tags.iter().any(|existing| existing == &tag) {
            tags.push(tag);
        }
    }

    let mut frontmatter = create_frontmatter(&title, &tags);
    if let Some(template) = &applied_template {
        if !template.properties.is_empty() {
            frontmatter.properties = Some(template.properties.clone());
        }
    }
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

async fn load_template(
    vault: &VaultRuntime,
    template_id: &str,
    title: &str,
) -> AppResult<Option<AppliedTemplate>> {
    let template_id = template_id.trim();
    if template_id.is_empty()
        || template_id.contains('/')
        || template_id.contains('\\')
        || template_id.contains("..")
    {
        return Err(AppError::Validation("invalid template id".into()));
    }

    let root = vault.require_current()?;
    let path = root
        .join(".memry")
        .join("templates")
        .join(format!("{template_id}.md"));
    let Some(raw) = vault_fs::safe_read(&path).await? else {
        return Ok(None);
    };

    Ok(Some(apply_template_markdown(&raw, title)?))
}

fn apply_template_markdown(raw: &str, title: &str) -> AppResult<AppliedTemplate> {
    let (yaml_text, body) = split_template_frontmatter(raw);
    let data: BTreeMap<String, serde_yaml_ng::Value> = if yaml_text.trim().is_empty() {
        BTreeMap::new()
    } else {
        serde_yaml_ng::from_str(yaml_text)?
    };
    let tags = data
        .get("tags")
        .and_then(|value| value.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    Ok(AppliedTemplate {
        body: body.trim().replace("{{title}}", title),
        tags,
        properties: template_properties(&data),
    })
}

fn split_template_frontmatter(raw: &str) -> (&str, &str) {
    let Some(rest) = raw
        .strip_prefix("---\n")
        .or_else(|| raw.strip_prefix("---\r\n"))
    else {
        return ("", raw);
    };
    let Some(end) = rest.find("\n---") else {
        return ("", raw);
    };
    let body = rest[end + 4..]
        .strip_prefix('\n')
        .or_else(|| rest[end + 4..].strip_prefix("\r\n"))
        .unwrap_or(&rest[end + 4..]);
    (&rest[..end], body)
}

fn template_properties(
    data: &BTreeMap<String, serde_yaml_ng::Value>,
) -> BTreeMap<String, serde_yaml_ng::Value> {
    let mut out = BTreeMap::new();
    match data.get("properties") {
        Some(serde_yaml_ng::Value::Mapping(map)) => {
            for (key, value) in map {
                if let Some(name) = key.as_str() {
                    out.insert(name.to_string(), value.clone());
                }
            }
        }
        Some(serde_yaml_ng::Value::Sequence(seq)) => {
            for item in seq {
                let Some(map) = item.as_mapping() else {
                    continue;
                };
                let Some(name) = yaml_mapping_get(map, "name").and_then(|value| value.as_str())
                else {
                    continue;
                };
                let value = yaml_mapping_get(map, "value")
                    .cloned()
                    .unwrap_or(serde_yaml_ng::Value::Null);
                out.insert(name.to_string(), value);
            }
        }
        _ => {}
    }
    out
}

fn yaml_mapping_get<'a>(
    map: &'a serde_yaml_ng::Mapping,
    key: &str,
) -> Option<&'a serde_yaml_ng::Value> {
    map.get(serde_yaml_ng::Value::String(key.to_string()))
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
        note: Some(into_dto(&metadata, body, frontmatter)?),
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
