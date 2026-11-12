//! The vector tables of `index.db`: Electron's `sqlite-vec` vec0 tables, with the
//! same names, columns and cosine metric (`apps/desktop/src/main/database/client.ts`
//! `ensureVecNotesTable` and `ensureVecImagesTable`, `voice-vectors.ts`).
//!
//! The tables are created when the index opens ([`ensure_vec_tables`]), never by a
//! migration, so a later index migration cannot drop hours of embeddings. vec0
//! cannot change a column's width, so a table built for another model (installs
//! from before EmbeddingGemma 2 carry `float[384]` or `float[768]`) is dropped and
//! recreated empty, with the state rows that say its vectors exist; the embedding
//! reconcile refills it. Safe: vectors are derived from the notes and never synced.
//!
//! A vector is a little-endian `f32` blob, as `Float32Array` writes it.

use std::sync::OnceLock;

use rusqlite::{Connection, OptionalExtension, params};

use crate::api::errors::StorageError;

/// Width of every vector: the first 256 of EmbeddingGemma 2's 768, renormalised.
pub const EMBEDDING_DIMENSION: usize = 256;
/// sqlite-vec refuses a nearest query with a larger `k` (`SQLITE_VEC_VEC0_K_MAX`).
const MAX_K: usize = 4096;

/// A vec0 table of the index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VecTable {
    /// Each note's first document window, keyed by note id.
    Notes,
    /// A note's later windows, keyed `<note_id>#<n>`.
    NoteChunks,
    /// One `similarity`-task vector per note, keyed by note id.
    NoteSimilar,
    /// Images, keyed `<note_id>/<source>`.
    Images,
    /// Voice memo windows, keyed by chunk id.
    Voice,
}

impl VecTable {
    pub const ALL: [Self; 5] = [
        Self::Notes,
        Self::NoteChunks,
        Self::NoteSimilar,
        Self::Images,
        Self::Voice,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Notes => "vec_notes",
            Self::NoteChunks => "vec_note_chunks",
            Self::NoteSimilar => "vec_note_similar",
            Self::Images => "vec_images",
            Self::Voice => "vec_voice",
        }
    }

    pub fn id_column(self) -> &'static str {
        match self {
            Self::Notes | Self::NoteSimilar => "note_id",
            Self::NoteChunks | Self::Voice => "chunk_id",
            Self::Images => "image_key",
        }
    }
}

/// Tables that are dropped together, and the state table whose rows record what
/// they hold. The three note tables are one family: Electron drops all three when
/// `vec_notes` has another width, and the reconcile re-embeds a note with no
/// `vec_notes` row, so no note state is cleared.
const FAMILIES: [(&[VecTable], Option<&str>); 3] = [
    (
        &[VecTable::Notes, VecTable::NoteChunks, VecTable::NoteSimilar],
        None,
    ),
    (&[VecTable::Images], Some("image_embedding_state")),
    (&[VecTable::Voice], Some("voice_embedding_state")),
];

fn failed(err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: format!("vector table: {err}"),
    }
}

/// Makes vec0 available on every SQLite connection this process opens from now on.
/// Idempotent; call it before the index opens. An error means vec0 is missing,
/// which is the build's fault and not the index file's, so the caller must not
/// treat it as a defect of the file.
pub fn register() -> Result<(), StorageError> {
    static REGISTER: OnceLock<Result<(), String>> = OnceLock::new();
    REGISTER
        .get_or_init(|| {
            // SAFETY: `sqlite3_vec_init` is sqlite-vec's extension entry point. It is
            // compiled from C against sqlite-vec's own vendored `sqlite3.h` with
            // `SQLITE_CORE`, so it calls SQLite's functions directly and only the
            // symbols resolve to the engine rusqlite bundles. The crate declares it
            // without arguments; its C signature is the `(db, pzErrMsg, pApi)` of
            // `RawAutoExtension`, so the transmute only restores the real type. It
            // opens no database and touches no auto-extension, as the contract asks.
            let init = unsafe {
                std::mem::transmute::<*const (), rusqlite::auto_extension::RawAutoExtension>(
                    sqlite_vec::sqlite3_vec_init as *const (),
                )
            };
            // SAFETY: as above; registration only appends to SQLite's list.
            unsafe { rusqlite::auto_extension::register_auto_extension(init) }
                .map_err(|err| err.to_string())
        })
        .clone()
        .map_err(|err| StorageError::Failed {
            what: format!("could not register sqlite-vec: {err}"),
        })
}

/// Creates the vec0 tables the index lacks, after dropping any family with a table
/// of another width. Runs in one transaction. Returns the tables that were
/// dropped, for the caller's log. The raw SQLite error is returned so the caller
/// can tell a defect of the file (a missing shadow table) from a lock or an I/O
/// error.
pub fn ensure_vec_tables(conn: &mut Connection) -> Result<Vec<&'static str>, rusqlite::Error> {
    let tx = conn.transaction()?;
    let mut dropped = Vec::new();
    for (tables, state) in FAMILIES {
        let mut stale = false;
        let mut present = Vec::new();
        for table in tables {
            let sql: Option<Option<String>> = tx
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table.name()],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(sql) = sql {
                present.push(table.name());
                stale |= declared_width(sql.as_deref().unwrap_or("")) != Some(EMBEDDING_DIMENSION);
            }
        }
        if stale {
            for table in tables {
                tx.execute_batch(&format!("DROP TABLE IF EXISTS {}", table.name()))?;
            }
            dropped.extend(present);
            if let Some(state) = state {
                tx.execute_batch(&format!("DELETE FROM {state}"))?;
            }
        }
    }
    for table in VecTable::ALL {
        tx.execute_batch(&format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS {} USING vec0(
               {} TEXT PRIMARY KEY,
               embedding float[{EMBEDDING_DIMENSION}] distance_metric=cosine
             )",
            table.name(),
            table.id_column()
        ))?;
    }
    tx.commit()?;
    Ok(dropped)
}

/// The `n` of the first `float[n]` in a table's `CREATE` statement.
fn declared_width(sql: &str) -> Option<usize> {
    let rest = &sql[sql.find("float[")? + "float[".len()..];
    rest[..rest.find(']')?].parse().ok()
}

/// A vector as vec0 stores it.
pub fn to_blob(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// A stored blob as a vector; `None` when its length is not a whole number of
/// `f32`s.
pub fn from_blob(blob: &[u8]) -> Option<Vec<f32>> {
    let (floats, rest) = blob.as_chunks::<4>();
    rest.is_empty()
        .then(|| floats.iter().map(|b| f32::from_le_bytes(*b)).collect())
}

/// The stored vector of `id` in `table`, `None` when it has none.
pub fn vector(
    conn: &Connection,
    table: VecTable,
    id: &str,
) -> Result<Option<Vec<f32>>, StorageError> {
    let blob: Option<Vec<u8>> = conn
        .query_row(
            &format!(
                "SELECT embedding FROM {} WHERE {} = ?1",
                table.name(),
                table.id_column()
            ),
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(blob.as_deref().and_then(from_blob))
}

/// The `k` stored vectors of `table` nearest `vector`, closest first, with their
/// cosine distance (`1 - cosine`). Electron's query (`search/semantic.ts`,
/// `similarity/index.ts`); `k` above sqlite-vec's ceiling asks for the ceiling.
pub fn nearest(
    conn: &Connection,
    table: VecTable,
    vector: &[f32],
    k: usize,
) -> Result<Vec<(String, f64)>, StorageError> {
    let mut statement = conn
        .prepare_cached(&format!(
            "SELECT {} AS id, distance FROM {}
             WHERE embedding MATCH ?1 AND k = ?2
             ORDER BY distance",
            table.id_column(),
            table.name()
        ))
        .map_err(failed)?;
    let k = k.min(MAX_K) as i64;
    statement
        .query_map(params![to_blob(vector), k], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

#[cfg(test)]
#[path = "vec_tests.rs"]
mod tests;
