//! Debug/test-only helpers for runtime e2e.

use crate::app_state::AppState;
use crate::db::note_metadata::NoteMetadataRow;
use crate::error::{AppError, AppResult};
use crate::vault::{notes_io, NoteFrontmatter, VaultRuntime};
use rusqlite::Connection;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::State;

#[tauri::command]
#[specta::specta]
pub async fn devtools_reset_db(state: State<'_, AppState>) -> AppResult<()> {
    let conn = state.db.conn()?;
    devtools_reset_db_inner(&conn)
}

#[tauri::command]
#[specta::specta]
pub async fn devtools_seed_vault(
    state: State<'_, AppState>,
    root: String,
) -> AppResult<serde_json::Value> {
    let seeded = seed_vault_files(&state.vault, &root).await?;
    let conn = state.db.conn()?;
    insert_seed_metadata(&conn, &seeded)?;
    Ok(seeded.to_json())
}

#[tauri::command]
#[specta::specta]
pub async fn devtools_open_test_vault(
    state: State<'_, AppState>,
    root: String,
) -> AppResult<serde_json::Value> {
    devtools_open_test_vault_inner(&state.vault, &root)
}

pub fn devtools_reset_db_inner(conn: &Connection) -> AppResult<()> {
    let tables = user_tables(conn)?;
    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
    for table in tables {
        let table = table.replace('"', "\"\"");
        conn.execute(&format!("DELETE FROM \"{table}\""), [])?;
    }
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    Ok(())
}

pub async fn devtools_seed_vault_inner(
    conn: &Connection,
    vault: &VaultRuntime,
    root: &str,
) -> AppResult<serde_json::Value> {
    let seeded = seed_vault_files(vault, root).await?;
    insert_seed_metadata(conn, &seeded)?;
    Ok(seeded.to_json())
}

pub fn devtools_open_test_vault_inner(
    vault: &VaultRuntime,
    root: &str,
) -> AppResult<serde_json::Value> {
    let root = ensure_test_root(root)?;
    vault.set_current(Some(root.clone()))?;
    let status = vault.status();
    Ok(json!({
        "isOpen": status.is_open,
        "path": status.path,
        "isIndexing": status.is_indexing,
        "indexProgress": status.index_progress,
        "error": status.error,
    }))
}

struct SeededVault {
    notes: Vec<SeededNote>,
    folder: String,
}

struct SeededNote {
    id: String,
    path: String,
    title: String,
    created: String,
    modified: String,
    content: String,
}

impl SeededVault {
    fn to_json(&self) -> serde_json::Value {
        json!({
            "folder": self.folder,
            "notes": self.notes.iter().map(|note| {
                json!({
                    "id": note.id,
                    "path": note.path,
                    "title": note.title,
                })
            }).collect::<Vec<_>>(),
        })
    }
}

async fn seed_vault_files(vault: &VaultRuntime, root: &str) -> AppResult<SeededVault> {
    let root = ensure_test_root(root)?;
    vault.set_current(Some(root.clone()))?;

    let folder = "notes/Inbox".to_string();
    std::fs::create_dir_all(root.join(&folder))?;

    let notes = vec![
        SeededNote::new(
            "devtools-note-one",
            "notes/Inbox/welcome.md",
            "Welcome",
            "# Welcome\n\nSeeded runtime note.",
        ),
        SeededNote::new(
            "devtools-note-two",
            "notes/Inbox/second.md",
            "Second Note",
            "Second seeded markdown note.",
        ),
    ];

    for note in &notes {
        let frontmatter = note.frontmatter();
        notes_io::write_new_note_to_disk(&root, &note.path, &frontmatter, &note.content).await?;
    }

    Ok(SeededVault { notes, folder })
}

fn insert_seed_metadata(conn: &Connection, seeded: &SeededVault) -> AppResult<()> {
    for note in &seeded.notes {
        crate::db::note_metadata::upsert(conn, &note.row())?;
    }
    Ok(())
}

impl SeededNote {
    fn new(id: &str, path: &str, title: &str, content: &str) -> Self {
        let now = crate::vault::frontmatter_iso(0);
        Self {
            id: id.to_string(),
            path: path.to_string(),
            title: title.to_string(),
            created: now.clone(),
            modified: now,
            content: content.to_string(),
        }
    }

    fn frontmatter(&self) -> NoteFrontmatter {
        NoteFrontmatter {
            id: self.id.clone(),
            title: Some(self.title.clone()),
            created: self.created.clone(),
            modified: self.modified.clone(),
            tags: Vec::new(),
            aliases: Vec::new(),
            emoji: None,
            local_only: Some(true),
            properties: None,
            extra: BTreeMap::new(),
        }
    }

    fn row(&self) -> NoteMetadataRow {
        NoteMetadataRow {
            id: self.id.clone(),
            path: self.path.clone(),
            title: self.title.clone(),
            emoji: None,
            file_type: "markdown".into(),
            mime_type: Some("text/markdown".into()),
            file_size: Some(self.content.len() as i64),
            attachment_id: None,
            attachment_references: None,
            local_only: true,
            sync_policy: "local".into(),
            journal_date: None,
            property_definition_names: None,
            clock: None,
            synced_at: None,
            created_at: self.created.clone(),
            modified_at: self.modified.clone(),
        }
    }
}

fn ensure_test_root(root: &str) -> AppResult<PathBuf> {
    if root.trim().is_empty() {
        return Err(AppError::Validation("root is empty".into()));
    }
    let root = Path::new(root);
    std::fs::create_dir_all(root)?;
    Ok(dunce::canonicalize(root)?)
}

fn user_tables(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
           AND name != 'schema_migrations'
         ORDER BY name",
    )?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut tables = Vec::new();
    for row in rows {
        tables.push(row?);
    }
    Ok(tables)
}
