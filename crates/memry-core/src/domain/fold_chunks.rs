//! `index.db`'s `note_fold_chunks`: the note fold cache (Electron's `note-fold/fold-cache.ts`).
//!
//! A row holds what was written for one fold chunk, keyed by the chunk's content hash, the
//! note language and the writer (`model_id`, `local` for the Brief picked from the note's own
//! sentences). The payload is JSON the caller validates on read; a row that does not validate
//! is deleted and written again. Derived: a missing row costs a recomputation, never data.

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;

/// The primary key of a row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkKey {
    pub chunk_hash: String,
    pub language: String,
    pub model_id: String,
}

/// The row's payload, `None` on a miss.
pub fn read(index: &Connection, key: &ChunkKey) -> Result<Option<String>, StorageError> {
    index
        .query_row(
            "SELECT payload FROM note_fold_chunks
             WHERE chunk_hash = ?1 AND language = ?2 AND model_id = ?3",
            params![key.chunk_hash, key.language, key.model_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)
}

/// Writes or replaces the row, stamped `now_ms`.
pub fn write(
    index: &Connection,
    key: &ChunkKey,
    payload: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    index
        .execute(
            "INSERT INTO note_fold_chunks (chunk_hash, language, model_id, payload, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (chunk_hash, language, model_id)
             DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at",
            params![key.chunk_hash, key.language, key.model_id, payload, now_ms],
        )
        .map(drop)
        .map_err(failed)
}

pub fn delete(index: &Connection, key: &ChunkKey) -> Result<(), StorageError> {
    index
        .execute(
            "DELETE FROM note_fold_chunks
             WHERE chunk_hash = ?1 AND language = ?2 AND model_id = ?3",
            params![key.chunk_hash, key.language, key.model_id],
        )
        .map(drop)
        .map_err(failed)
}

/// Drops the rows written before `cutoff_ms` and returns how many; a chunk still wanted is
/// written again the next time its note folds.
pub fn prune_older_than(index: &Connection, cutoff_ms: i64) -> Result<usize, StorageError> {
    index
        .execute(
            "DELETE FROM note_fold_chunks WHERE created_at < ?1",
            params![cutoff_ms],
        )
        .map_err(failed)
}
