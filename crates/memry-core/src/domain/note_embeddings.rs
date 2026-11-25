//! The note vectors of `index.db` and the state rows that record them: what Electron's
//! embedding projector writes (`apps/desktop/src/main/projections/projectors/
//! embedding-projector.ts`). Desktop's embedding projector embeds; this module only reads the
//! notes owed a vector and writes what came back.
//!
//! A note's head window goes to `vec_notes`, each later window to `vec_note_chunks`
//! (`<note_id>#<n>`), its `similarity` vector to `vec_note_similar`, and its
//! `note_embedding_state` row records the input version and the number of later windows, all
//! in one transaction, with its `note_embedding_hashes` row: the hash of the file bytes the
//! vectors were built from and the title they were built with. A note whose file hash (else
//! its document's) or title moved since, or that has no hash row, is owed: whatever happened
//! to the events of its edits and renames (a close, a missed fact, a change made while the app
//! was closed). Input version
//! `0` is the dirty sentinel a rebuild sets: every build (older ones too) treats it as owed.
//! Old vectors keep answering until new ones replace them.
//!
//! Live notes are the markdown rows of `note_files` (journal days included), as
//! `note_stats::prune` reads them, plus the filed files (PDFs, images) with text read out of
//! them (`EMBEDDABLE_NOTES`, `embedding-projector.ts:118-123`). A markdown note's input ends
//! with the opening of its attachments' text and a file note's input is that text alone
//! (`withAttachmentText`, `readFileTextOpening`, :126-143), so the recorded hash also names
//! the text read ([`embedded_hash`]): a new read (another OCR language, a replaced attachment)
//! leaves the note owed, as Electron's `note.text-extracted` marks it dirty (:400-425).

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;
use crate::domain::content_hash::{ContentHasher, content_hash};
use crate::domain::embedding_input::{
    MAX_EMBEDDABLE_CONTENT_LENGTH, UNCAPPED_EMBEDDING_INPUT_VERSION,
};
use crate::domain::file_text::extracted_text_for_note;
use crate::storage::nested_tx;
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
    /// A markdown note, whose body the projector reads from disk; else a filed file, whose
    /// input is the text read out of it.
    pub markdown: bool,
    /// What the vectors are built from: the hash of the bytes on disk
    /// (`note_file_hashes.file_hash`, else of the text the note's document holds; a file
    /// note has none), joined with the hash of the text read out of the note's files
    /// ([`embedded_hash`]). `None` when the tier never read the file and no text was read.
    pub content_hash: Option<String>,
}

/// `extractTitleFromPath` for a markdown note; a filed file drops its extension
/// (`vault/indexer.ts:304`).
fn file_title(path: &str, markdown: bool) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    let stem = if markdown {
        name.strip_suffix(".md")
    } else {
        name.rsplit_once('.').map(|(stem, _)| stem)
    };
    stem.filter(|stem| !stem.is_empty())
        .unwrap_or(name)
        .to_owned()
}

const CANDIDATES: &str = "SELECT f.note_id, f.path, n.title, \
     COALESCE(h.file_hash, f.content_hash), f.file_type = 'markdown' FROM note_files f \
     LEFT JOIN notes n ON n.id = f.note_id AND n.deleted_at IS NULL \
     LEFT JOIN note_file_hashes h ON h.note_id = f.note_id";

fn candidate_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EmbeddableNote> {
    let path: String = row.get(1)?;
    let title: Option<String> = row.get(2)?;
    let markdown: bool = row.get(4)?;
    Ok(EmbeddableNote {
        note_id: row.get(0)?,
        title: title.unwrap_or_else(|| file_title(&path, markdown)),
        path,
        markdown,
        content_hash: if markdown { row.get(3)? } else { None },
    })
}

/// Every live note file, in path order: `data.db`'s half of `EMBEDDABLE_NOTES`. The text read
/// out of files lives in `index.db`; [`with_file_text`] finishes the list.
pub fn candidates(data: &Connection) -> Result<Vec<EmbeddableNote>, StorageError> {
    let mut statement = data
        .prepare(&format!("{CANDIDATES} ORDER BY f.path"))
        .map_err(failed)?;
    statement
        .query_map([], candidate_row)
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// The live note file `note_id` ([`candidates`] for one note).
pub fn candidate(data: &Connection, note_id: &str) -> Result<Option<EmbeddableNote>, StorageError> {
    data.query_row(
        &format!("{CANDIDATES} WHERE f.note_id = ?1"),
        [note_id],
        candidate_row,
    )
    .optional()
    .map_err(failed)
}

/// The hash a note's vectors record: `file_hash` (the bytes of a markdown note) alone when no
/// text was read out of its files, else joined with the hash of that text as
/// [`extracted_text_for_note`] gives it. A note with no extracted text keeps the hash it had
/// before file text was embedded, so an upgrade re-embeds only the notes that have some.
pub fn embedded_hash(file_hash: Option<&str>, extracted: &str) -> Option<String> {
    joined_hash(
        file_hash,
        (!extracted.is_empty()).then(|| content_hash(extracted)),
    )
}

fn joined_hash(file_hash: Option<&str>, text_hash: Option<String>) -> Option<String> {
    match text_hash {
        None => file_hash.map(str::to_owned),
        Some(text_hash) => Some(format!("{}|{text_hash}", file_hash.unwrap_or_default())),
    }
}

/// The first `max_units` UTF-16 units of `text` (`.slice(0, max)`); a cut through a surrogate
/// pair leaves U+FFFD, as `embedding_input` does.
fn opening(text: &str, max_units: usize) -> String {
    if text.len() <= max_units {
        return text.to_owned();
    }
    let units: Vec<u16> = text.encode_utf16().take(max_units).collect();
    String::from_utf16_lossy(&units)
}

/// `withAttachmentText` (:128-133): a markdown note's body, then the opening of the text read
/// out of its attachments, up to the most the embedding input reads.
pub fn with_attachment_text(body: String, extracted: &str) -> String {
    let room = MAX_EMBEDDABLE_CONTENT_LENGTH.saturating_sub(body.encode_utf16().count());
    if room == 0 || extracted.is_empty() {
        return body;
    }
    format!("{body}\n\n{}", opening(extracted, room))
}

/// `readFileTextOpening` (:126): a file note's input, its text up to the most the embedding
/// input reads.
pub fn file_text_opening(extracted: &str) -> String {
    opening(extracted, MAX_EMBEDDABLE_CONTENT_LENGTH)
}

/// One candidate finished against `index.db`: a file note with no text read is dropped.
fn finish(note: EmbeddableNote, text_hash: Option<String>) -> Option<EmbeddableNote> {
    if !note.markdown && text_hash.is_none() {
        return None;
    }
    let content_hash = joined_hash(note.content_hash.as_deref(), text_hash);
    Some(EmbeddableNote {
        content_hash,
        ..note
    })
}

/// `EMBEDDABLE_NOTES`: the markdown notes of `notes`, and its files with text read out of them,
/// each with the hash its vectors must record ([`embedded_hash`]).
pub fn with_file_text(
    index: &Connection,
    notes: Vec<EmbeddableNote>,
) -> Result<Vec<EmbeddableNote>, StorageError> {
    let mut texts = extracted_hashes(index)?;
    Ok(notes
        .into_iter()
        .filter_map(|note| {
            let text_hash = texts.remove(&note.note_id);
            finish(note, text_hash)
        })
        .collect())
}

/// [`with_file_text`] for one note.
pub fn with_note_file_text(
    index: &Connection,
    note: EmbeddableNote,
) -> Result<Option<EmbeddableNote>, StorageError> {
    let extracted = extracted_text_for_note(index, &note.note_id)?;
    let text_hash = (!extracted.is_empty()).then(|| content_hash(&extracted));
    Ok(finish(note, text_hash))
}

#[cfg(test)]
thread_local! {
    /// `extracted_text` rows [`extracted_hashes`] read on this thread.
    pub(crate) static TEXT_ROWS_HASHED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// `content_hash` of each note's [`extracted_text_for_note`], read in one pass, one row's
/// text held at a time.
fn extracted_hashes(index: &Connection) -> Result<HashMap<String, String>, StorageError> {
    let mut statement = index
        .prepare(
            "SELECT note_id, text FROM extracted_text WHERE text <> ''
             ORDER BY note_id, source, part",
        )
        .map_err(failed)?;
    let mut rows = statement.query([]).map_err(failed)?;
    let mut hashes = HashMap::new();
    let mut current: Option<(String, ContentHasher)> = None;
    while let Some(row) = rows.next().map_err(failed)? {
        #[cfg(test)]
        TEXT_ROWS_HASHED.with(|n| n.set(n.get() + 1));
        let (note_id, text): (String, String) =
            (row.get(0).map_err(failed)?, row.get(1).map_err(failed)?);
        match &mut current {
            Some((id, hasher)) if *id == note_id => {
                hasher.update("\n\n");
                hasher.update(&text);
            }
            _ => {
                let mut hasher = ContentHasher::new();
                hasher.update(&text);
                if let Some((id, done)) = current.replace((note_id, hasher)) {
                    hashes.insert(id, done.digest());
                }
            }
        }
    }
    if let Some((id, hasher)) = current {
        hashes.insert(id, hasher.digest());
    }
    Ok(hashes)
}

/// `markDirty`: the note's vectors are owed again whatever its hash says (a rebuild). Keeps
/// them, and its chunk count, until a build replaces them.
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
        "DELETE FROM note_embedding_hashes WHERE note_id = ?1",
    ] {
        index.execute(sql, [note_id]).map_err(failed)?;
    }
    Ok(())
}

/// `storeNoteEmbeddings`: the note's windows (the head first) and its `similarity` vector,
/// replacing what it had, with its state row at the current input version, the hash of the
/// bytes they were built from and the title they were built with.
pub fn store(
    index: &Connection,
    note_id: &str,
    content_hash: Option<&str>,
    title: &str,
    windows: &[Vec<f32>],
    similar: &[f32],
) -> Result<(), StorageError> {
    let Some((head, later)) = windows.split_first() else {
        return delete(index, note_id);
    };
    let transaction = nested_tx::begin(index).map_err(failed)?;
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
            params![
                note_id,
                UNCAPPED_EMBEDDING_INPUT_VERSION,
                later.len() as i64
            ],
        )
        .map_err(failed)?;
    transaction
        .execute(
            "INSERT OR REPLACE INTO note_embedding_hashes (note_id, content_hash, title)
             VALUES (?1, ?2, ?3)",
            params![note_id, content_hash, title],
        )
        .map_err(failed)?;
    transaction.commit().map_err(failed)
}

/// `deleteNoteEmbedding`: every vector and the state row of the note.
pub fn delete(index: &Connection, note_id: &str) -> Result<(), StorageError> {
    let transaction = nested_tx::begin(index).map_err(failed)?;
    delete_rows(&transaction, note_id)?;
    transaction.commit().map_err(failed)
}

/// `getEmbeddingCount`: how many notes have a head vector (`vec_notes` rows).
pub fn count(index: &Connection) -> Result<u64, StorageError> {
    index
        .query_row("SELECT COUNT(*) FROM vec_notes", [], |row| {
            row.get::<_, i64>(0)
        })
        .map(i64::unsigned_abs)
        .map_err(failed)
}

/// `rebuild` of a vault with no note: every note vector and state row.
pub fn clear(index: &Connection) -> Result<(), StorageError> {
    index
        .execute_batch(
            "DELETE FROM vec_notes; DELETE FROM vec_note_chunks; \
             DELETE FROM vec_note_similar; DELETE FROM note_embedding_state; \
             DELETE FROM note_embedding_hashes;",
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

/// The reconcile's prune: the vectors and state rows of notes that are not embeddable, the
/// markdown notes of `notes` and its files with text read out of them (`EMBEDDABLE_NOTES`,
/// :118-123). Reads only which notes have text, never the text: it runs holding the index
/// writer. Returns how many notes lost theirs.
pub fn prune(index: &Connection, notes: Vec<EmbeddableNote>) -> Result<usize, StorageError> {
    let with_text = ids(
        index,
        "SELECT DISTINCT note_id FROM extracted_text WHERE text <> ''",
    )?;
    let live: HashSet<String> = notes
        .into_iter()
        .filter(|note| note.markdown || with_text.contains(&note.note_id))
        .map(|note| note.note_id)
        .collect();
    let mut known = ids(index, "SELECT note_id FROM vec_notes")?;
    known.extend(ids(index, "SELECT note_id FROM vec_note_similar")?);
    known.extend(ids(index, "SELECT note_id FROM note_embedding_state")?);
    known.extend(ids(index, "SELECT note_id FROM note_embedding_hashes")?);
    let gone: Vec<&String> = known.iter().filter(|id| !live.contains(*id)).collect();
    let transaction = nested_tx::begin(index).map_err(failed)?;
    for note_id in &gone {
        delete_rows(&transaction, note_id)?;
    }
    transaction.commit().map_err(failed)?;
    Ok(gone.len())
}

/// The notes of `notes` owed a vector: those with none first (semantic search cannot find
/// them), then those built from another input version, marked dirty, or from another
/// content hash or title than the note has now (none recorded included).
pub fn owed(
    index: &Connection,
    notes: Vec<EmbeddableNote>,
) -> Result<Vec<EmbeddableNote>, StorageError> {
    let embedded = ids(index, "SELECT note_id FROM vec_notes")?;
    let mut statement = index
        .prepare(
            "SELECT s.note_id, h.note_id IS NOT NULL, h.content_hash, h.title
             FROM note_embedding_state s
             LEFT JOIN note_embedding_hashes h ON h.note_id = s.note_id
             WHERE s.input_version = ?1",
        )
        .map_err(failed)?;
    type Built = (Option<String>, Option<String>);
    let built: HashMap<String, Option<Built>> = statement
        .query_map([UNCAPPED_EMBEDDING_INPUT_VERSION], |row| {
            let hashed: bool = row.get(1)?;
            let recorded = || Ok::<_, rusqlite::Error>((row.get(2)?, row.get(3)?));
            Ok((row.get(0)?, hashed.then(recorded).transpose()?))
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    let current = |note: &EmbeddableNote| {
        built
            .get(&note.note_id)
            .and_then(Option::as_ref)
            .is_some_and(|(hash, title)| {
                *hash == note.content_hash && title.as_deref() == Some(note.title.as_str())
            })
    };
    let (missing, stale): (Vec<_>, Vec<_>) = notes
        .into_iter()
        .filter(|note| !embedded.contains(&note.note_id) || !current(note))
        .partition(|note| !embedded.contains(&note.note_id));
    Ok(missing.into_iter().chain(stale).collect())
}

#[cfg(test)]
#[path = "note_embeddings_tests.rs"]
mod tests;
