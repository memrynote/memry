//! The import's documents (stage 36c4): each folded Electron Yjs document, its body cursor, its
//! queued body pushes, the body sync state and the body debts, and the `note_files` hash that
//! lets the first write-back put a body that is ahead of its file on disk.

use std::path::Path;
use std::sync::Arc;

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

use super::{ImportWriter, failed};
use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::crdt::{DocumentRegistry, canonical_fragment, update_log};
use crate::domain::note_files::{self, NoteFileStat, StampMark};
use crate::domain::note_snapshots::{self, Reason, Version};
use crate::domain::owed_file_body;
use crate::storage::nested_tx;
use crate::sync::store::RECORD_CURSOR_SCOPE;
use crate::sync::{body_debt, outbox, store};

/// One Yjs document folded to a single state, with the server sequence it had applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportDocument {
    pub doc_id: String,
    pub state: Vec<u8>,
    pub watermark: Option<u64>,
    /// The stamp of the imported log entry: delete-keep rule 3 reads it as this device's last
    /// own body text (`sync::delete_keep`), and [`note_files::behind_bodies`] compares it with
    /// the row's stamp.
    pub created_at: i64,
}

/// A body kept as a version before the file's outside edit replaces it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportBodyVersion {
    pub note_id: String,
    /// The whole file the version restores to.
    pub content: String,
    /// The body within `content`.
    pub body: String,
    pub title: String,
}

/// One body update Electron still owes the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportBodyPush {
    pub doc_id: String,
    pub update: Vec<u8>,
    pub enqueued_at: i64,
}

/// The hashes of an imported document's markdown file: `content_hash` names the file the
/// document last held (Electron's cached hash), `file_hash` the bytes on disk now. `ahead` says
/// the body may hold text the file does not ([`ImportWriter::put_file_hashes`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportFileHash {
    pub note_id: String,
    pub content_hash: String,
    pub file_hash: Option<String>,
    pub ahead: bool,
}

/// One `note_body_sync` row, values as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportBodySync {
    pub note_id: String,
    pub last_sent_at: Option<i64>,
    pub last_confirmed_at: Option<i64>,
    pub last_failed_at: Option<i64>,
    pub last_rejected_at: Option<i64>,
    pub last_snapshot_at: Option<i64>,
    pub updated_at: i64,
}

/// A staged document as Step 37's check 3 compares it with the folded Electron state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentState {
    /// The v1 state vector.
    pub state_vector: Vec<u8>,
    /// [`canonical_fragment`] of the body.
    pub text: String,
}

impl ImportWriter {
    /// Writes each document as local update 1 (`local.<docId>`) stored at its `created_at`, and
    /// its `crdt:<docId>` cursor (written at `now_ms`) when it has a watermark. No epoch row: a
    /// document this device never purged is at epoch 0, as a new one is.
    pub fn put_documents(
        &mut self,
        docs: &[ImportDocument],
        now_ms: i64,
    ) -> Result<(), StorageError> {
        let tx = nested_tx::begin(&self.data).map_err(failed)?;
        for doc in docs {
            update_log::append_local_update_in(&tx, &doc.doc_id, &doc.state, doc.created_at)
                .map_err(crdt_failed)?;
            if let Some(watermark) = doc.watermark {
                let scope = format!("crdt:{}", doc.doc_id);
                store::write_cursor(&tx, &scope, Some(&watermark.to_string()), now_ms)?;
            }
        }
        tx.commit().map_err(failed)
    }

    /// Queues each body update in order through [`outbox::enqueue`], never collapsed. Returns,
    /// per push, whether a row was queued: `false` for a local-only note's.
    pub fn put_body_pushes(
        &mut self,
        pushes: &[ImportBodyPush],
    ) -> Result<Vec<bool>, StorageError> {
        let tx = nested_tx::begin(&self.data).map_err(failed)?;
        let mut queued = Vec::with_capacity(pushes.len());
        for push in pushes {
            let item_type = body_item_type(&tx, &push.doc_id)?;
            let change = outbox::Change::crdt_update(item_type, &push.doc_id, push.update.clone());
            queued.push(outbox::enqueue(&tx, &change, push.enqueued_at)?.is_some());
        }
        tx.commit().map_err(failed)?;
        Ok(queued)
    }

    /// Gives each row its hashes. Runs after [`Self::put_documents`] with the same `now_ms`.
    ///
    /// A row whose body is `ahead` (its file is the one the row names) is stamped `now_ms - 1`,
    /// before the document's log entry (stored at `now_ms`), with no log mark: the note is
    /// behind its body by the clock ([`note_files::behind_bodies`]), so the first write-back
    /// writes the body over the file and keeps the file as a version. Any other row is stamped
    /// `now_ms` with the log as it is now: the body holds the file the row names, so a file
    /// that is that one is left alone, and a file edited since is an outside edit the consumer
    /// feeds into the body. A row that is missing or not markdown is an error.
    pub fn put_file_hashes(
        &mut self,
        rows: &[ImportFileHash],
        now_ms: i64,
    ) -> Result<(), StorageError> {
        for ahead in [true, false] {
            let mut stats = Vec::new();
            for row in rows.iter().filter(|row| row.ahead == ahead) {
                let file = note_files::by_id(&self.data, &row.note_id)?
                    .filter(|file| file.file_type == "markdown")
                    .ok_or_else(|| StorageError::NotFound {
                        what: format!("markdown note_files row {}", row.note_id),
                    })?;
                stats.push(NoteFileStat {
                    note_id: file.note_id,
                    path: file.path,
                    file_type: file.file_type,
                    mime_type: file.mime_type,
                    file_size: file.file_size,
                    content_hash: Some(row.content_hash.clone()),
                    file_hash: row.file_hash.clone(),
                    indexed_at: if ahead { now_ms - 1 } else { now_ms },
                });
            }
            let mark = if ahead {
                StampMark::Kept
            } else {
                StampMark::Now
            };
            note_files::upsert_stats_as(&mut self.data, &stats, mark)?;
            if ahead {
                // The note_metadata import marked the row at `now_ms`: a later write that put
                // the stamp back there would make that mark count again.
                for stat in &stats {
                    self.data
                        .execute(
                            "DELETE FROM note_file_marks WHERE note_id = ?1",
                            params![stat.note_id],
                        )
                        .map_err(failed)?;
                }
            }
        }
        Ok(())
    }

    pub fn put_note_body_sync(&mut self, rows: &[ImportBodySync]) -> Result<(), StorageError> {
        let tx = nested_tx::begin(&self.data).map_err(failed)?;
        for row in rows {
            tx.execute(
                "INSERT INTO note_body_sync (note_id, last_sent_at, last_confirmed_at,
                   last_failed_at, last_rejected_at, last_snapshot_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    row.note_id,
                    row.last_sent_at,
                    row.last_confirmed_at,
                    row.last_failed_at,
                    row.last_rejected_at,
                    row.last_snapshot_at,
                    row.updated_at
                ],
            )
            .map_err(failed)?;
        }
        tx.commit().map_err(failed)
    }

    /// Keeps each body as a version ([`note_snapshots::keep`], an outside write's reason), at
    /// `now_ms`.
    pub fn put_body_versions(
        &mut self,
        versions: &[ImportBodyVersion],
        now_ms: i64,
    ) -> Result<(), StorageError> {
        let tx = nested_tx::begin(&self.data).map_err(failed)?;
        for version in versions {
            let version = Version {
                note_id: &version.note_id,
                content: &version.content,
                body: &version.body,
                title: &version.title,
                reason: Reason::OutsideWrite,
            };
            note_snapshots::keep(&tx, version, now_ms)?;
        }
        tx.commit().map_err(failed)
    }

    /// The item type a body's outbox rows go under ([`body_owner`]); `None` when no note,
    /// journal day or synced item owns it.
    pub fn body_owner(&self, doc_id: &str) -> Result<Option<&'static str>, StorageError> {
        body_owner(&self.data, doc_id)
    }

    /// Marks each document owed a body pull ([`body_debt::owe`]).
    pub fn put_body_debts(&mut self, doc_ids: &[String]) -> Result<(), StorageError> {
        let tx = nested_tx::begin(&self.data).map_err(failed)?;
        for doc_id in doc_ids {
            body_debt::owe(&tx, doc_id)?;
        }
        tx.commit().map_err(failed)
    }

    /// Owes a body pull to every live markdown note and journal day of a vault that synced (a
    /// record cursor is staged) whose record the server holds and whose body the import brought
    /// no log of: a document the fold skipped, or one Electron's store never held. Unowed, its
    /// empty body would take its file as a seed, and the server body would merge in beside that
    /// seed (#2536). A record the server lacks owes nothing: a local-only note, an unclocked one
    /// (Electron seeds it as a create), one with a queued create. Runs after
    /// [`Self::put_documents`] and the outbox; answers how many it owed.
    pub fn put_unfolded_body_debts(&mut self) -> Result<usize, StorageError> {
        let tx = nested_tx::begin(&self.data).map_err(failed)?;
        let ids: Vec<String> = {
            let mut stmt = tx
                .prepare(
                    "SELECT id FROM (
                       SELECT id FROM notes WHERE deleted_at IS NULL AND file_type = 'markdown'
                       UNION SELECT id FROM journal_entries WHERE deleted_at IS NULL
                     ) AS live
                     WHERE EXISTS (SELECT 1 FROM sync_cursors
                                   WHERE scope = ?1 AND cursor IS NOT NULL)
                       AND EXISTS (SELECT 1 FROM sync_items
                                   WHERE item_type IN ('note', 'journal') AND item_id = live.id
                                     AND deleted_at IS NULL AND clock IS NOT NULL)
                       AND NOT EXISTS (SELECT 1 FROM outbox WHERE item_id = live.id AND op = ?2)
                       AND NOT EXISTS (SELECT 1 FROM note_files
                                       WHERE note_id = live.id AND local_only != 0)
                       AND NOT EXISTS (SELECT 1 FROM yjs_updates
                                       WHERE doc_id IN (live.id, 'local.' || live.id))
                       AND NOT EXISTS (SELECT 1 FROM yjs_snapshots
                                       WHERE doc_id IN (live.id, 'local.' || live.id))
                     ORDER BY id",
                )
                .map_err(failed)?;
            stmt.query_map(params![RECORD_CURSOR_SCOPE, outbox::OP_CREATE], |row| {
                row.get(0)
            })
            .map_err(failed)?
            .collect::<Result<_, _>>()
            .map_err(failed)?
        };
        for doc_id in &ids {
            body_debt::owe(&tx, doc_id)?;
        }
        tx.commit().map_err(failed)?;
        Ok(ids.len())
    }

    /// `(note_id, recorded_at_ms)`: each note's file is ahead of its document
    /// ([`owed_file_body::record`]), at the time Electron recorded it.
    pub fn put_owed_file_bodies(&mut self, rows: &[(String, i64)]) -> Result<(), StorageError> {
        let tx = nested_tx::begin(&self.data).map_err(failed)?;
        for (note_id, recorded_at) in rows {
            owed_file_body::record(&tx, note_id, *recorded_at)?;
        }
        tx.commit().map_err(failed)
    }

    /// The staged `note_files` row of `note_id`.
    pub fn note_file(&self, note_id: &str) -> Result<Option<note_files::NoteFile>, StorageError> {
        note_files::by_id(&self.data, note_id)
    }
}

/// The item type a body's outbox rows go under: its live owner's (`journal_day::body_owner`),
/// else the type of its `sync_items` row (a note deleted after the push was queued). A body of
/// no known item is an error: queued under a guessed type, it would reach the wrong owner.
fn body_item_type(conn: &Connection, doc_id: &str) -> Result<&'static str, StorageError> {
    body_owner(conn, doc_id)?.ok_or_else(|| StorageError::NotFound {
        what: format!("the note or journal day of document {doc_id}"),
    })
}

fn body_owner(conn: &Connection, doc_id: &str) -> Result<Option<&'static str>, StorageError> {
    let found: Option<String> = conn
        .query_row(
            "SELECT 'note' FROM notes WHERE id = ?1 AND deleted_at IS NULL
             UNION ALL SELECT 'journal' FROM journal_entries WHERE id = ?1 AND deleted_at IS NULL
             UNION ALL SELECT item_type FROM sync_items
                        WHERE item_id = ?1 AND item_type IN ('note', 'journal')
             LIMIT 1",
            params![doc_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(match found.as_deref() {
        Some("note") => Some("note"),
        Some("journal") => Some("journal"),
        _ => None,
    })
}

/// The staged document `doc_id` of a staged `data.db`, read through a read-only connection;
/// `None` when it has no log.
pub fn document_state(data_db: &Path, doc_id: &str) -> Result<Option<DocumentState>, StorageError> {
    let conn = Connection::open_with_flags(
        data_db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(failed)?;
    let plan = update_log::load_plan(&conn, doc_id).map_err(crdt_failed)?;
    if plan.is_empty() {
        return Ok(None);
    }
    let read = || -> Result<DocumentState, CrdtError> {
        let document = DocumentRegistry::new("import", Arc::new(|_: &str, _: &[u8]| {}))
            .get_or_open(doc_id)?;
        for blob in plan.blobs() {
            document.apply_durable_update(blob)?;
        }
        Ok(DocumentState {
            state_vector: document.state_vector()?,
            text: canonical_fragment(&document)?,
        })
    };
    read().map(Some).map_err(crdt_failed)
}

fn crdt_failed(error: CrdtError) -> StorageError {
    StorageError::Failed {
        what: format!("import staging: {error}"),
    }
}
