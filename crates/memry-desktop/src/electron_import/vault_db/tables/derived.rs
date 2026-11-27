//! Stage 36e: the text Electron read out of files and its vectors, copied as they are.
//!
//! The core embeds with Electron's model (EmbeddingGemma 2, `memry-ml`, held to transformers.js
//! by `packages/contracts/test-vectors/embeddings-*.json`) at Electron's width (256) from
//! Electron's input text (`embedding_input`, held by `embedding-input.json`), and stores the
//! vector bytes as `Float32Array` does, so a stored vector stays valid. Its owners re-check
//! each row at run time as Electron's do: the embedding reconcile re-embeds a note at another
//! input version, an image at another signature, and the file text runner re-reads a file whose
//! signature or OCR languages moved and retries failed jobs. A vec0 table of another width
//! cannot be read into the core's: its family is dropped and counted, and the reconcile embeds
//! those notes again, as Electron does at open (`client.ts` `ensureVecNotesTable`).

use memry_core::storage::import::{DerivedTable, ImportEmbeddedNote};
use memry_core::storage::vec::{self, VecTable};
use rusqlite::types::Value;

use super::{SourceDb, TableStats};
use crate::electron_import::vault_db::source::source_error;
use crate::electron_import::vault_db::{ImportError, TableCtx};

/// Rows held in memory at once: a 10 000 note vault has up to 160 000 note windows.
const BATCH: usize = 1024;
/// Report name of the rows of a family with a vec0 table of another width.
const OTHER_WIDTH: &str = "vectorsOfAnotherWidth";

pub fn extracted_text(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    copy(ctx, DerivedTable::ExtractedText)
}

pub fn file_text_jobs(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    copy(ctx, DerivedTable::FileTextJobs)
}

pub fn image_embedding_state(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    copy(ctx, DerivedTable::ImageEmbeddingState)
}

pub fn voice_embedding_state(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    copy(ctx, DerivedTable::VoiceEmbeddingState)
}

pub fn vec_notes(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    copy(ctx, DerivedTable::Vectors(VecTable::Notes))
}

pub fn vec_note_chunks(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    copy(ctx, DerivedTable::Vectors(VecTable::NoteChunks))
}

pub fn vec_note_similar(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    copy(ctx, DerivedTable::Vectors(VecTable::NoteSimilar))
}

pub fn vec_images(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    copy(ctx, DerivedTable::Vectors(VecTable::Images))
}

pub fn vec_voice(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    copy(ctx, DerivedTable::Vectors(VecTable::Voice))
}

/// The state rows, then the hash and title Electron's cache last saw for each current note
/// ([`memry_core::storage::import::ImportWriter::put_note_embedding_hashes`]), so an unchanged
/// note is not embedded again. `TABLE_MAP` puts `note_metadata` and `extracted_text` before it.
pub fn note_embedding_state(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    let stats = copy(ctx, DerivedTable::NoteEmbeddingState)?;
    let error = |e| source_error(SourceDb::Index, e);
    let mut stmt = ctx
        .index
        .prepare(
            "SELECT c.id, c.content_hash, c.title FROM note_cache c
             JOIN note_embedding_state s ON s.note_id = c.id",
        )
        .map_err(error)?;
    let notes = stmt
        .query_map([], |row| {
            Ok(ImportEmbeddedNote {
                note_id: row.get(0)?,
                content_hash: row.get(1)?,
                title: row.get(2)?,
            })
        })
        .map_err(error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error)?;
    ctx.writer.put_note_embedding_hashes(&notes)?;
    Ok(stats)
}

fn copy(ctx: &mut TableCtx<'_>, table: DerivedTable) -> Result<TableStats, ImportError> {
    let error = |e| source_error(SourceDb::Index, e);
    let name = table.name();
    if vec::stale_tables(ctx.index).map_err(error)?.contains(&name) {
        let count: i64 = ctx
            .index
            .query_row(&format!("SELECT count(*) FROM {name}"), [], |row| {
                row.get(0)
            })
            .map_err(error)?;
        return Ok(TableStats {
            dropped: vec![(OTHER_WIDTH, count as u64)],
            ..TableStats::default()
        });
    }
    let columns = table.columns();
    let mut stmt = ctx
        .index
        .prepare(&format!("SELECT {} FROM {name}", columns.join(", ")))
        .map_err(error)?;
    let mut rows = stmt.query([]).map_err(error)?;
    let mut batch = Vec::with_capacity(BATCH);
    let mut written = 0;
    while let Some(row) = rows.next().map_err(error)? {
        let values = (0..columns.len())
            .map(|i| row.get::<_, Value>(i))
            .collect::<Result<Vec<_>, _>>()
            .map_err(error)?;
        batch.push(values);
        if batch.len() == BATCH {
            ctx.writer.put_derived_rows(table, &batch)?;
            written += batch.len() as u64;
            batch.clear();
        }
    }
    ctx.writer.put_derived_rows(table, &batch)?;
    written += batch.len() as u64;
    Ok(TableStats {
        written,
        ..TableStats::default()
    })
}
