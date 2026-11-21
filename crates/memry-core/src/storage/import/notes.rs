//! The device-local note rows of the import: each note's `note_files` row, the manual order
//! (`note_positions`), the version history (`note_snapshots`) and the instant each pinned tag
//! was pinned. The note and journal records themselves go through [`super::ImportRecord`].

use std::collections::HashSet;

use rusqlite::params;

use super::{ImportWriter, failed};
use crate::api::errors::StorageError;
use crate::domain::note_files::{self, NoteFileStat, StampMark};

/// One Electron `note_metadata` row's file state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportNoteFile {
    pub note_id: String,
    pub path: String,
    pub file_type: String,
    pub mime_type: Option<String>,
    pub file_size: Option<i64>,
    pub local_only: bool,
}

/// One `note_snapshots` row, values as Electron stored them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportNoteSnapshot {
    pub id: String,
    pub note_id: String,
    pub content: String,
    pub title: String,
    pub word_count: i64,
    pub content_hash: String,
    pub reason: String,
    pub created_at: String,
}

impl ImportWriter {
    /// Writes the `note_files` rows, stamped `now_ms`. No row names a hash: the hash says the
    /// note's document holds the file's text (the vault consumer's invariant), and documents
    /// are written later (36c) or seeded from the file at the first open.
    pub fn put_note_files(
        &mut self,
        files: &[ImportNoteFile],
        now_ms: i64,
    ) -> Result<(), StorageError> {
        let stats: Vec<NoteFileStat> = files
            .iter()
            .map(|file| NoteFileStat {
                note_id: file.note_id.clone(),
                path: file.path.clone(),
                file_type: file.file_type.clone(),
                mime_type: file.mime_type.clone(),
                file_size: file.file_size,
                content_hash: None,
                file_hash: None,
                indexed_at: now_ms,
            })
            .collect();
        note_files::upsert_stats_as(&mut self.data, &stats, StampMark::Now)?;
        let tx = self.data.transaction().map_err(failed)?;
        for file in files.iter().filter(|file| file.local_only) {
            note_files::set_local_only(&tx, &file.note_id, true)?;
        }
        tx.commit().map_err(failed)
    }

    /// `(path, folder_path, position)` rows of the manual order, unchanged.
    pub fn put_note_positions(
        &mut self,
        rows: &[(String, String, i64)],
    ) -> Result<(), StorageError> {
        let tx = self.data.transaction().map_err(failed)?;
        for (path, folder_path, position) in rows {
            tx.execute(
                "INSERT INTO note_positions (path, folder_path, position) VALUES (?1, ?2, ?3)",
                params![path, folder_path, position],
            )
            .map_err(failed)?;
        }
        tx.commit().map_err(failed)
    }

    pub fn put_note_snapshots(&mut self, rows: &[ImportNoteSnapshot]) -> Result<(), StorageError> {
        let tx = self.data.transaction().map_err(failed)?;
        for row in rows {
            tx.execute(
                "INSERT INTO note_snapshots
                   (id, note_id, content, title, word_count, content_hash, reason, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    row.id,
                    row.note_id,
                    row.content,
                    row.title,
                    row.word_count,
                    row.content_hash,
                    row.reason,
                    row.created_at
                ],
            )
            .map_err(failed)?;
        }
        tx.commit().map_err(failed)
    }

    /// `(note_id, tag, pinned_at_ms)`: the instant Electron pinned each tag, over the apply
    /// time the record projection gives a pin. Only a tag the projection pinned changes.
    pub fn put_pinned_at(&mut self, rows: &[(String, String, i64)]) -> Result<(), StorageError> {
        let tx = self.data.transaction().map_err(failed)?;
        for (note_id, tag, pinned_at) in rows {
            tx.execute(
                "UPDATE note_tags SET pinned_at = ?3
                 WHERE note_id = ?1 AND tag = ?2 AND pinned_at IS NOT NULL",
                params![note_id, tag, pinned_at],
            )
            .map_err(failed)?;
        }
        tx.commit().map_err(failed)
    }

    /// The ids of every staged note and journal entry.
    pub fn note_ids(&self) -> Result<HashSet<String>, StorageError> {
        let mut stmt = self
            .data
            .prepare("SELECT id FROM notes UNION SELECT id FROM journal_entries")
            .map_err(failed)?;
        stmt.query_map([], |row| row.get(0))
            .map_err(failed)?
            .collect::<Result<_, _>>()
            .map_err(failed)
    }
}
