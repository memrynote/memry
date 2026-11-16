//! The image vectors of `index.db` and the state rows that record them: Electron's
//! `apps/desktop/src/main/database/queries/image-embeddings.ts`. Desktop's image embedding
//! projector embeds; this module lists the images owed a vector and writes what came back.
//!
//! An image is keyed like the text extraction job that found it: a filed image or PDF is the
//! note's own file (`source` empty), an attachment is a file name in the note's attachments
//! folder, and a PDF page adds `#<page>` (`#3`, `scan.pdf#3`). Its vector lives in
//! `vec_images` under `<note_id>/<source>` and its `image_embedding_state` row records the
//! signature of the bytes and text it was built from and the input version, written in one
//! transaction. The jobs live in `index.db` and the notes' files in `data.db`, so the listing
//! is [`jobs`] joined with [`note_files`] by the caller ([`sources`]).

use std::collections::HashMap;

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::domain::embedding_input::IMAGE_EMBEDDING_INPUT_VERSION;
use crate::domain::file_text::OWN_FILE;
use crate::storage::vec::{VecTable, nearest, to_blob};

/// `MAX_EMBEDDED_PDF_PAGES`: pages of one PDF that get a vector.
pub const MAX_EMBEDDED_PDF_PAGES: u32 = 8;

fn failed(err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: format!("image embeddings: {err}"),
    }
}

/// What the vision encoder reads in a file, from its name. The shell owns the file types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFile {
    /// A raster image the encoder decodes (not SVG).
    Image,
    Pdf,
}

pub type Classify = fn(&str) -> Option<ImageFile>;

/// An image, or one page of a PDF, the vision encoder can read (`ImageSource`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageSource {
    pub note_id: String,
    pub source: String,
    /// The job's signature (size and mtime of the bytes) and the length of the text read from
    /// the image or page, in UTF-16 units: a new read is a new input.
    pub signature: String,
    /// Vault-relative path of the file.
    pub path: String,
    /// 1-based page of the PDF at `path`; `None` for an image file.
    pub page: Option<u32>,
    /// Text read from the image or page; empty when none was read.
    pub text: String,
    /// False while the file's text job is still pending: its event hands the file over.
    pub settled: bool,
}

/// An `image_embedding_state` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageEmbeddingState {
    pub note_id: String,
    pub source: String,
    pub signature: String,
    pub input_version: u32,
}

/// `imageKey`: the `vec_images` key of an image.
pub fn image_key(note_id: &str, source: &str) -> String {
    format!("{note_id}/{source}")
}

/// A `file_text_jobs` row as the listing reads it, with the text read from its first pages by
/// part.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageJob {
    pub note_id: String,
    pub source: String,
    pub signature: String,
    pub pending: bool,
    pub page_count: Option<u32>,
    pub texts: HashMap<u32, String>,
}

fn in_notes(column: &str, note_ids: Option<&[String]>) -> String {
    match note_ids {
        Some(_) => format!("{column} IN (SELECT value FROM json_each(?1))"),
        None => "?1 IS NULL".to_owned(),
    }
}

fn ids_json(note_ids: Option<&[String]>) -> Option<String> {
    note_ids.map(|ids| serde_json::Value::from(ids.to_vec()).to_string())
}

/// The text extraction jobs of `note_ids` (or every note), with the text read from their first
/// [`MAX_EMBEDDED_PDF_PAGES`] parts. `index.db`'s half of `listImageSources`.
pub fn jobs(
    index: &Connection,
    note_ids: Option<&[String]>,
) -> Result<Vec<ImageJob>, StorageError> {
    let filter = ids_json(note_ids);
    let mut statement = index
        .prepare(&format!(
            "SELECT note_id, source, signature, status, page_count FROM file_text_jobs
             WHERE {} ORDER BY note_id, source",
            in_notes("note_id", note_ids)
        ))
        .map_err(failed)?;
    let mut jobs: Vec<ImageJob> = statement
        .query_map([&filter], |row| {
            let status: String = row.get(3)?;
            Ok(ImageJob {
                note_id: row.get(0)?,
                source: row.get(1)?,
                signature: row.get(2)?,
                pending: status == "pending",
                page_count: row.get(4)?,
                texts: HashMap::new(),
            })
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    let mut statement = index
        .prepare(&format!(
            "SELECT note_id, source, part, text FROM extracted_text
             WHERE part <= {MAX_EMBEDDED_PDF_PAGES} AND text <> '' AND {}",
            in_notes("note_id", note_ids)
        ))
        .map_err(failed)?;
    let mut texts: HashMap<(String, String), HashMap<u32, String>> = HashMap::new();
    let mut rows = statement.query([&filter]).map_err(failed)?;
    while let Some(row) = rows.next().map_err(failed)? {
        let key = (row.get(0).map_err(failed)?, row.get(1).map_err(failed)?);
        texts
            .entry(key)
            .or_default()
            .insert(row.get(2).map_err(failed)?, row.get(3).map_err(failed)?);
    }
    for job in &mut jobs {
        if let Some(found) = texts.remove(&(job.note_id.clone(), job.source.clone())) {
            job.texts = found;
        }
    }
    Ok(jobs)
}

/// The live note files among `note_ids` (or all): `note_id -> (path, file_type)`. `data.db`'s
/// half of `listImageSources` (its `note_cache` join).
pub fn note_files(
    data: &Connection,
    note_ids: &[String],
) -> Result<HashMap<String, (String, String)>, StorageError> {
    let mut statement = data
        .prepare(
            "SELECT note_id, path, file_type FROM note_files
             WHERE note_id IN (SELECT value FROM json_each(?1))",
        )
        .map_err(failed)?;
    statement
        .query_map([ids_json(Some(note_ids))], |row| {
            Ok((row.get(0)?, (row.get(1)?, row.get(2)?)))
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// `listImageSources`: each job's image, or each of its PDF's first pages, that `classify`
/// says the encoder reads. A job whose note has no live file is left out. A filed file is
/// classified by its stored type (an image also by its name, which leaves SVG out), an
/// attachment by its name.
pub fn sources(
    jobs: Vec<ImageJob>,
    files: &HashMap<String, (String, String)>,
    classify: Classify,
) -> Vec<ImageSource> {
    let mut sources = Vec::new();
    for job in jobs {
        let Some((note_path, note_type)) = files.get(&job.note_id) else {
            continue;
        };
        let (path, kind) = if job.source == OWN_FILE {
            let kind = match note_type.as_str() {
                "image" => classify(note_path).filter(|kind| *kind == ImageFile::Image),
                "pdf" => Some(ImageFile::Pdf),
                _ => None,
            };
            (note_path.clone(), kind)
        } else {
            (
                format!("attachments/{}/{}", job.note_id, job.source),
                classify(&job.source),
            )
        };
        let text = |page: u32| job.texts.get(&page).cloned().unwrap_or_default();
        let source = |source: String, page: Option<u32>, text: String| ImageSource {
            note_id: job.note_id.clone(),
            signature: format!("{}|{}", job.signature, text.encode_utf16().count()),
            source,
            path: path.clone(),
            page,
            text,
            settled: !job.pending,
        };
        match kind {
            Some(ImageFile::Image) => sources.push(source(job.source.clone(), None, text(1))),
            Some(ImageFile::Pdf) => {
                let pages = job.page_count.unwrap_or(0).min(MAX_EMBEDDED_PDF_PAGES);
                for page in 1..=pages {
                    sources.push(source(
                        format!("{}#{page}", job.source),
                        Some(page),
                        text(page),
                    ));
                }
            }
            None => {}
        }
    }
    sources
}

/// `listImageEmbeddingState` of `note_ids`, or of every note.
pub fn state(
    index: &Connection,
    note_ids: Option<&[String]>,
) -> Result<Vec<ImageEmbeddingState>, StorageError> {
    let mut statement = index
        .prepare(&format!(
            "SELECT note_id, source, signature, input_version FROM image_embedding_state
             WHERE {}",
            in_notes("note_id", note_ids)
        ))
        .map_err(failed)?;
    statement
        .query_map([ids_json(note_ids)], |row| {
            Ok(ImageEmbeddingState {
                note_id: row.get(0)?,
                source: row.get(1)?,
                signature: row.get(2)?,
                input_version: row.get(3)?,
            })
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// `storeImageEmbedding`: the image's vector and its state row at the current input version,
/// in one transaction.
pub fn store(index: &Connection, image: &ImageSource, vector: &[f32]) -> Result<(), StorageError> {
    let key = image_key(&image.note_id, &image.source);
    let transaction = index.unchecked_transaction().map_err(failed)?;
    transaction
        .execute("DELETE FROM vec_images WHERE image_key = ?1", [&key])
        .map_err(failed)?;
    transaction
        .execute(
            "INSERT INTO vec_images (image_key, embedding) VALUES (?1, ?2)",
            params![key, to_blob(vector)],
        )
        .map_err(failed)?;
    transaction
        .execute(
            "INSERT OR REPLACE INTO image_embedding_state (note_id, source, signature, input_version)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                image.note_id,
                image.source,
                image.signature,
                IMAGE_EMBEDDING_INPUT_VERSION
            ],
        )
        .map_err(failed)?;
    transaction.commit().map_err(failed)
}

/// `deleteImageEmbedding`: the vector and state row of each `(note_id, source)`.
pub fn delete(index: &Connection, images: &[(String, String)]) -> Result<(), StorageError> {
    let transaction = index.unchecked_transaction().map_err(failed)?;
    for (note_id, source) in images {
        transaction
            .execute(
                "DELETE FROM vec_images WHERE image_key = ?1",
                [image_key(note_id, source)],
            )
            .map_err(failed)?;
        transaction
            .execute(
                "DELETE FROM image_embedding_state WHERE note_id = ?1 AND source = ?2",
                [note_id, source],
            )
            .map_err(failed)?;
    }
    transaction.commit().map_err(failed)
}

/// `pruneOrphanImageEmbeddings`: vectors no state row accounts for (a quit between two writes)
/// and state rows whose vector is gone.
pub fn prune_orphans(index: &Connection) -> Result<(), StorageError> {
    index
        .execute_batch(
            "DELETE FROM vec_images WHERE image_key NOT IN
               (SELECT note_id || '/' || source FROM image_embedding_state);
             DELETE FROM image_embedding_state WHERE note_id || '/' || source NOT IN
               (SELECT image_key FROM vec_images);",
        )
        .map_err(failed)
}

/// The image projector's `rebuild`: every image vector and state row.
pub fn clear(index: &Connection) -> Result<(), StorageError> {
    index
        .execute_batch("DELETE FROM vec_images; DELETE FROM image_embedding_state;")
        .map_err(failed)
}

/// `nearestImageVectors`: the `k` image vectors nearest `query`, as the note that owns each
/// (everything before the key's first `/`; a note id has none) with its cosine.
pub fn nearest_notes(
    index: &Connection,
    query: &[f32],
    k: usize,
) -> Result<Vec<(String, f64)>, StorageError> {
    Ok(nearest(index, VecTable::Images, query, k)?
        .into_iter()
        .map(|(key, distance)| {
            let note = key.split_once('/').map_or(key.as_str(), |(note, _)| note);
            (note.to_owned(), 1.0 - distance)
        })
        .collect())
}

#[cfg(test)]
#[path = "image_embeddings_tests.rs"]
mod tests;
