//! Stage 36e: the derived rows of an Electron `index.db` the core keeps as they are, the text
//! read out of files and the vectors with their state rows. Same names, columns and meaning as
//! Electron's (index migrations 0008 and 0010, `storage/vec.rs`): one model (EmbeddingGemma 2,
//! 256 wide), one input builder (`domain/embedding_input.rs`, pinned by
//! `packages/contracts/test-vectors/embedding-input.json`), one extractor signature. Each owner
//! re-checks its rows at run time (input version, file signature, OCR languages, gone notes) as
//! Electron's does, so the import copies them unchanged.

use rusqlite::types::Value;
use rusqlite::{OptionalExtension, params, params_from_iter};

use super::{ImportWriter, failed};
use crate::api::errors::StorageError;
use crate::domain::embedding_input::UNCAPPED_EMBEDDING_INPUT_VERSION;
use crate::domain::file_text::extracted_text_for_note;
use crate::domain::note_embeddings::embedded_hash;
use crate::storage::nested_tx;
use crate::storage::vec::VecTable;

/// An Electron index table the import copies row for row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DerivedTable {
    ExtractedText,
    FileTextJobs,
    NoteEmbeddingState,
    ImageEmbeddingState,
    VoiceEmbeddingState,
    Vectors(VecTable),
}

impl DerivedTable {
    pub fn name(self) -> &'static str {
        match self {
            Self::ExtractedText => "extracted_text",
            Self::FileTextJobs => "file_text_jobs",
            Self::NoteEmbeddingState => "note_embedding_state",
            Self::ImageEmbeddingState => "image_embedding_state",
            Self::VoiceEmbeddingState => "voice_embedding_state",
            Self::Vectors(table) => table.name(),
        }
    }

    /// The columns both indexes share, in the order rows are passed.
    pub fn columns(self) -> &'static [&'static str] {
        match self {
            Self::ExtractedText => &["note_id", "source", "part", "method", "text"],
            Self::FileTextJobs => &[
                "note_id",
                "source",
                "signature",
                "status",
                "page_count",
                "error",
                "app_version",
                "updated_at",
                "ocr_languages",
            ],
            Self::NoteEmbeddingState => &["note_id", "input_version", "chunk_count"],
            Self::ImageEmbeddingState => &["note_id", "source", "signature", "input_version"],
            Self::VoiceEmbeddingState => &["item_id", "source", "input_version", "chunks"],
            Self::Vectors(VecTable::Notes | VecTable::NoteSimilar) => &["note_id", "embedding"],
            Self::Vectors(VecTable::NoteChunks | VecTable::Voice) => &["chunk_id", "embedding"],
            Self::Vectors(VecTable::Images) => &["image_key", "embedding"],
        }
    }
}

/// A note whose Electron vectors `note_embedding_state` calls current: what Electron's index
/// held for it when it last ran (`note_cache.content_hash` and `title`). The hash is `None` for
/// a filed file (`persistFileNote` caches none) and for a markdown note tier 0 has not read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportEmbeddedNote {
    pub note_id: String,
    pub content_hash: Option<String>,
    pub title: String,
}

impl ImportWriter {
    /// Inserts `rows` into `table`, values in [`DerivedTable::columns`] order, unchanged.
    pub fn put_derived_rows(
        &mut self,
        table: DerivedTable,
        rows: &[Vec<Value>],
    ) -> Result<(), StorageError> {
        let columns = table.columns();
        let marks = vec!["?"; columns.len()].join(", ");
        let tx = nested_tx::begin(&self.index).map_err(failed)?;
        {
            let mut insert = tx
                .prepare(&format!(
                    "INSERT INTO {} ({}) VALUES ({marks})",
                    table.name(),
                    columns.join(", ")
                ))
                .map_err(failed)?;
            for row in rows {
                insert.execute(params_from_iter(row)).map_err(failed)?;
            }
        }
        tx.commit().map_err(failed)
    }

    /// Records, for each note of `notes` with a staged file and a staged
    /// `note_embedding_state` row at [`UNCAPPED_EMBEDDING_INPUT_VERSION`] (the version
    /// [`crate::domain::note_embeddings::owed`] treats as built), a `note_embedding_hashes` row
    /// (index migration 0011): Electron's cached hash (none for a filed file) joined with the
    /// staged text read out of its files, as
    /// [`crate::domain::note_embeddings::with_file_text`] joins the hash it has now, and the
    /// cached title. A note whose file or title moved since Electron's cache last saw it is
    /// still owed a vector; a markdown note with no cached hash gets no row and stays owed.
    /// Without a row every imported note would be embedded again.
    ///
    /// The row records the hash Electron's cache last saw, not proof of what the vectors were
    /// built from. Electron updates `note_cache` on its foreground lane and marks embeddings
    /// dirty on an in-memory background lane, so a lost event, a quit at the drain deadline, a
    /// crash or a tier 0 rename can leave an old vector at the current input version beside a
    /// newer cached hash. The core then treats that vector as current, as Electron does; only
    /// a full re-embed would close the gap. Run after `extracted_text`, `note_files` and
    /// `note_embedding_state` are staged. Returns the rows written.
    pub fn put_note_embedding_hashes(
        &mut self,
        notes: &[ImportEmbeddedNote],
    ) -> Result<u64, StorageError> {
        let tx = nested_tx::begin(&self.index).map_err(failed)?;
        let mut written = 0;
        for note in notes {
            let markdown: Option<bool> = self
                .data
                .query_row(
                    "SELECT file_type = 'markdown' FROM note_files WHERE note_id = ?1",
                    [&note.note_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(failed)?;
            let current: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM note_embedding_state
                       WHERE note_id = ?1 AND input_version = ?2)",
                    params![note.note_id, UNCAPPED_EMBEDDING_INPUT_VERSION],
                    |row| row.get(0),
                )
                .map_err(failed)?;
            let Some(markdown) = markdown.filter(|_| current) else {
                continue;
            };
            let file_hash = match (markdown, note.content_hash.as_deref()) {
                (false, _) => None,
                (true, Some(hash)) => Some(hash),
                (true, None) => continue,
            };
            let extracted = extracted_text_for_note(&tx, &note.note_id)?;
            let hash = embedded_hash(file_hash, &extracted);
            tx.execute(
                "INSERT INTO note_embedding_hashes (note_id, content_hash, title) VALUES (?1, ?2, ?3)",
                params![note.note_id, hash, note.title],
            )
            .map_err(failed)?;
            written += 1;
        }
        tx.commit().map_err(failed)?;
        Ok(written)
    }
}
