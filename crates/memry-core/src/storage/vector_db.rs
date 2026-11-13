//! `vectors.db`: per vault, device-local, never synced. A cache rebuilt from
//! `data.db`, so losing it costs re-embedding and never a user's data.
//!
//! It lives apart from `index.db` because `index.db` is deleted on every
//! version mismatch, and re-embedding takes about an hour per thousand notes on
//! a phone. This file migrates forward instead, through additive
//! [`VECTOR_MIGRATIONS`], and is deleted only when it is corrupt or the device
//! opts out.

use std::path::Path;

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::storage::connection::Db;
use crate::storage::index_db;
use crate::storage::migrations::{self, VECTOR_MIGRATIONS};

/// One stored vector: 256 little-endian `f32`, unit length.
pub const VECTOR_BYTES: usize = 1024;
pub type VectorBytes = [u8; VECTOR_BYTES];

/// Opens this vault's `vectors.db`.
///
/// Opted out, it deletes the file and its sidecars and returns `None`. Opted
/// in, it migrates any `user_version` forward and keeps the rows; a file from a
/// newer build stays at its version, which is safe because every migration is
/// additive. A file that fails `quick_check` or cannot migrate is deleted and
/// built fresh, and the embedder refills it.
pub fn open(path: &Path, opted_in: bool) -> Result<Option<Db>, StorageError> {
    if !opted_in {
        index_db::delete(path)?;
        return Ok(None);
    }
    match migrated(path) {
        Ok(db) => Ok(Some(db)),
        Err(err) => {
            eprintln!("memry-core: vectors.db rebuilt: {err}");
            index_db::delete(path)?;
            migrated(path).map(Some)
        }
    }
}

fn migrated(path: &Path) -> Result<Db, StorageError> {
    let db = Db::open(path)?;
    db.call_blocking(|conn| {
        let check: String = conn
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(failed)?;
        if check != "ok" {
            return Err(StorageError::Failed {
                what: format!("integrity check reported {check}"),
            });
        }
        migrations::run(conn, VECTOR_MIGRATIONS)
    })?;
    Ok(db)
}

/// What a note's vectors were built from. One row per embedded note, including
/// a note too short to embed, which has `window_count` 0.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteState {
    pub note_id: String,
    pub vector_key: String,
    pub input_version: u32,
    pub source_key: [u8; 32],
    pub window_count: u32,
}

/// The only code that knows `vectors.db`'s SQL.
pub struct VectorStore<'c> {
    conn: &'c Connection,
}

impl<'c> VectorStore<'c> {
    pub fn new(conn: &'c Connection) -> Self {
        Self { conn }
    }

    pub fn states(&self) -> Result<Vec<NoteState>, StorageError> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT note_id, vector_key, input_version, source_key, window_count
                 FROM note_vector_state ORDER BY note_id",
            )
            .map_err(failed)?;
        statement
            .query_map([], |row| {
                Ok(NoteState {
                    note_id: row.get(0)?,
                    vector_key: row.get(1)?,
                    input_version: row.get(2)?,
                    source_key: row.get(3)?,
                    window_count: row.get(4)?,
                })
            })
            .and_then(Iterator::collect)
            .map_err(failed)
    }

    /// One transaction: delete the note's windows, insert the new ones, upsert
    /// the state row. A failure leaves the note's previous vectors serving.
    pub fn replace_note(
        &self,
        state: &NoteState,
        vectors: &[VectorBytes],
        now_ms: i64,
    ) -> Result<(), StorageError> {
        if usize::try_from(state.window_count).ok() != Some(vectors.len()) {
            return Err(StorageError::Failed {
                what: format!(
                    "note state says {} windows, {} vectors given",
                    state.window_count,
                    vectors.len()
                ),
            });
        }
        let tx = self.conn.unchecked_transaction().map_err(failed)?;
        tx.execute(
            "DELETE FROM note_vectors WHERE note_id = ?1",
            [&state.note_id],
        )
        .map_err(failed)?;
        let mut insert = tx
            .prepare("INSERT INTO note_vectors (note_id, window, embedding) VALUES (?1, ?2, ?3)")
            .map_err(failed)?;
        for (window, vector) in (0u32..).zip(vectors) {
            insert
                .execute(params![state.note_id, window, vector])
                .map_err(failed)?;
        }
        drop(insert);
        tx.execute(
            "INSERT INTO note_vector_state
               (note_id, vector_key, input_version, source_key, window_count, embedded_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (note_id) DO UPDATE SET
               vector_key = excluded.vector_key,
               input_version = excluded.input_version,
               source_key = excluded.source_key,
               window_count = excluded.window_count,
               embedded_at = excluded.embedded_at",
            params![
                state.note_id,
                state.vector_key,
                state.input_version,
                state.source_key,
                state.window_count,
                now_ms
            ],
        )
        .map_err(failed)?;
        tx.commit().map_err(failed)
    }

    /// Removes the notes' state and vectors. Absent notes are not an error.
    pub fn prune(&self, note_ids: &[String]) -> Result<(), StorageError> {
        let tx = self.conn.unchecked_transaction().map_err(failed)?;
        for note_id in note_ids {
            tx.execute("DELETE FROM note_vectors WHERE note_id = ?1", [note_id])
                .map_err(failed)?;
            tx.execute(
                "DELETE FROM note_vector_state WHERE note_id = ?1",
                [note_id],
            )
            .map_err(failed)?;
        }
        tx.commit().map_err(failed)
    }

    /// Every window built with `vector_key`, at any input version: a stale
    /// version keeps serving until it is re-embedded, as on desktop. Another
    /// model's vectors never serve.
    pub fn scan(&self, vector_key: &str) -> Result<Vec<(String, u32, VectorBytes)>, StorageError> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT v.note_id, v.window, v.embedding
                 FROM note_vectors v JOIN note_vector_state s ON s.note_id = v.note_id
                 WHERE s.vector_key = ?1
                 ORDER BY v.note_id, v.window",
            )
            .map_err(failed)?;
        statement
            .query_map([vector_key], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .and_then(Iterator::collect)
            .map_err(failed)
    }

    /// How many notes have vectors built with `vector_key`, at any input version.
    pub fn counts(&self, vector_key: &str) -> Result<u32, StorageError> {
        self.conn
            .query_row(
                "SELECT count(*) FROM note_vector_state WHERE vector_key = ?1",
                [vector_key],
                |row| row.get(0),
            )
            .map_err(failed)
    }
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
