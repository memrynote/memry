//! The note vectors of `index.db` and the state rows that record them: what Electron's
//! embedding projector writes (`apps/desktop/src/main/projections/projectors/
//! embedding-projector.ts`). Desktop's embedding projector embeds; this module only reads the
//! notes owed a vector and writes what came back.
//!
//! A note's head window goes to `vec_notes`, each later window to `vec_note_chunks`
//! (`<note_id>#<n>`), its `similarity` vector to `vec_note_similar`, and its
//! `note_embedding_state` row records the input version and the number of later windows, all
//! in one transaction. Input version `0` is the dirty sentinel: the note changed after its
//! vectors were built, and every build (older ones too) treats it as owed, while the old
//! vectors keep answering until new ones replace them.
//!
//! Live notes are the markdown rows of `note_files` (journal days included), as
//! `note_stats::prune` reads them. Electron also embeds file notes with extracted text; that
//! half comes with the extracted-text tables (Step 25, #3542).

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;
use crate::domain::embedding_input::EMBEDDING_INPUT_VERSION;
use crate::storage::vec::to_blob;

fn failed(err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: format!("note embeddings: {err}"),
    }
}

/// A note the projector can embed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddableNote {
    pub note_id: String,
    pub path: String,
    /// The note's title; a journal day's is its file name without `.md`
    /// (`extractTitleFromPath`), as Electron's index titles it.
    pub title: String,
}

fn file_title(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".md")
        .filter(|stem| !stem.is_empty())
        .unwrap_or(name)
        .to_owned()
}

const EMBEDDABLE: &str = "SELECT f.note_id, f.path, n.title FROM note_files f \
     LEFT JOIN notes n ON n.id = f.note_id AND n.deleted_at IS NULL \
     WHERE f.file_type = 'markdown'";

fn embeddable_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EmbeddableNote> {
    let path: String = row.get(1)?;
    let title: Option<String> = row.get(2)?;
    Ok(EmbeddableNote {
        note_id: row.get(0)?,
        title: title.unwrap_or_else(|| file_title(&path)),
        path,
    })
}

/// Every live markdown note, in path order (`EMBEDDABLE_NOTES`, markdown half).
pub fn embeddable(data: &Connection) -> Result<Vec<EmbeddableNote>, StorageError> {
    let mut statement = data
        .prepare(&format!("{EMBEDDABLE} ORDER BY f.path"))
        .map_err(failed)?;
    statement
        .query_map([], embeddable_row)
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// The live markdown note `note_id`, `None` when it has no markdown file.
pub fn embeddable_note(
    data: &Connection,
    note_id: &str,
) -> Result<Option<EmbeddableNote>, StorageError> {
    data.query_row(
        &format!("{EMBEDDABLE} AND f.note_id = ?1"),
        [note_id],
        embeddable_row,
    )
    .optional()
    .map_err(failed)
}

/// `markDirty`: the note's vectors no longer match it. Keeps them, and its chunk count, until a
/// build replaces them.
pub fn mark_dirty(index: &Connection, note_id: &str) -> Result<(), StorageError> {
    index
        .execute(
            "INSERT INTO note_embedding_state (note_id, input_version, chunk_count)
             VALUES (?1, 0, 0)
             ON CONFLICT(note_id) DO UPDATE SET input_version = 0",
            [note_id],
        )
        .map(drop)
        .map_err(failed)
}

/// `deleteNoteChunks`: the `vec_note_chunks` rows the state row says the note owns.
fn delete_chunks(index: &Connection, note_id: &str) -> Result<(), StorageError> {
    let chunks: i64 = index
        .query_row(
            "SELECT chunk_count FROM note_embedding_state WHERE note_id = ?1",
            [note_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?
        .unwrap_or(0);
    for n in 1..=chunks {
        index
            .execute(
                "DELETE FROM vec_note_chunks WHERE chunk_id = ?1",
                [format!("{note_id}#{n}")],
            )
            .map_err(failed)?;
    }
    Ok(())
}

fn delete_rows(index: &Connection, note_id: &str) -> Result<(), StorageError> {
    delete_chunks(index, note_id)?;
    for sql in [
        "DELETE FROM vec_notes WHERE note_id = ?1",
        "DELETE FROM vec_note_similar WHERE note_id = ?1",
        "DELETE FROM note_embedding_state WHERE note_id = ?1",
    ] {
        index.execute(sql, [note_id]).map_err(failed)?;
    }
    Ok(())
}

/// `storeNoteEmbeddings`: the note's windows (the head first) and its `similarity` vector,
/// replacing what it had, with its state row at the current input version.
pub fn store(
    index: &Connection,
    note_id: &str,
    windows: &[Vec<f32>],
    similar: &[f32],
) -> Result<(), StorageError> {
    let Some((head, later)) = windows.split_first() else {
        return delete(index, note_id);
    };
    let transaction = index.unchecked_transaction().map_err(failed)?;
    delete_chunks(&transaction, note_id)?;
    for (sql, vector) in [
        ("DELETE FROM vec_notes WHERE note_id = ?1", None),
        (
            "INSERT INTO vec_notes (note_id, embedding) VALUES (?1, ?2)",
            Some(head.as_slice()),
        ),
        ("DELETE FROM vec_note_similar WHERE note_id = ?1", None),
        (
            "INSERT INTO vec_note_similar (note_id, embedding) VALUES (?1, ?2)",
            Some(similar),
        ),
    ] {
        match vector {
            Some(vector) => transaction.execute(sql, params![note_id, to_blob(vector)]),
            None => transaction.execute(sql, [note_id]),
        }
        .map_err(failed)?;
    }
    for (n, vector) in later.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO vec_note_chunks (chunk_id, embedding) VALUES (?1, ?2)",
                params![format!("{note_id}#{}", n + 1), to_blob(vector)],
            )
            .map_err(failed)?;
    }
    transaction
        .execute(
            "INSERT OR REPLACE INTO note_embedding_state (note_id, input_version, chunk_count)
             VALUES (?1, ?2, ?3)",
            params![note_id, EMBEDDING_INPUT_VERSION, later.len() as i64],
        )
        .map_err(failed)?;
    transaction.commit().map_err(failed)
}

/// `deleteNoteEmbedding`: every vector and the state row of the note.
pub fn delete(index: &Connection, note_id: &str) -> Result<(), StorageError> {
    let transaction = index.unchecked_transaction().map_err(failed)?;
    delete_rows(&transaction, note_id)?;
    transaction.commit().map_err(failed)
}

/// `rebuild` of a vault with no note: every note vector and state row.
pub fn clear(index: &Connection) -> Result<(), StorageError> {
    index
        .execute_batch(
            "DELETE FROM vec_notes; DELETE FROM vec_note_chunks; \
             DELETE FROM vec_note_similar; DELETE FROM note_embedding_state;",
        )
        .map_err(failed)
}

fn ids(conn: &Connection, sql: &str) -> Result<HashSet<String>, StorageError> {
    let mut statement = conn.prepare(sql).map_err(failed)?;
    statement
        .query_map([], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// The reconcile's prune: the vectors and state rows of notes that are not `live`. Returns how
/// many notes lost theirs.
pub fn prune(index: &Connection, live: &HashSet<String>) -> Result<usize, StorageError> {
    let mut known = ids(index, "SELECT note_id FROM vec_notes")?;
    known.extend(ids(index, "SELECT note_id FROM vec_note_similar")?);
    known.extend(ids(index, "SELECT note_id FROM note_embedding_state")?);
    let gone: Vec<&String> = known.iter().filter(|id| !live.contains(*id)).collect();
    let transaction = index.unchecked_transaction().map_err(failed)?;
    for note_id in &gone {
        delete_rows(&transaction, note_id)?;
    }
    transaction.commit().map_err(failed)?;
    Ok(gone.len())
}

/// The notes of `notes` owed a vector: those with none first (semantic search cannot find
/// them), then those built from another input version or marked dirty.
pub fn owed(
    index: &Connection,
    notes: Vec<EmbeddableNote>,
) -> Result<Vec<EmbeddableNote>, StorageError> {
    let embedded = ids(index, "SELECT note_id FROM vec_notes")?;
    let mut statement = index
        .prepare("SELECT note_id FROM note_embedding_state WHERE input_version = ?1")
        .map_err(failed)?;
    let current: HashSet<String> = statement
        .query_map([EMBEDDING_INPUT_VERSION], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    let (missing, stale): (Vec<_>, Vec<_>) = notes
        .into_iter()
        .filter(|note| !embedded.contains(&note.note_id) || !current.contains(&note.note_id))
        .partition(|note| !embedded.contains(&note.note_id));
    Ok(missing.into_iter().chain(stale).collect())
}

#[cfg(test)]
#[path = "note_embeddings_tests.rs"]
mod tests;
