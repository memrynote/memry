//! Text the index read out of files, and the background jobs that read it, in `index.db`'s
//! `extracted_text` and `file_text_jobs` (index migration 0010). The port of Electron's
//! `apps/desktop/src/main/database/queries/extracted-text.ts`.
//!
//! The rows are per device and derived: nothing here syncs, and an index rebuild drops them
//! and reads every file again. A [`TextSource`] names one file whose text is searchable under
//! a note: the note's own file ([`OWN_FILE`], a filed PDF or image) or a file name in the
//! note's attachments folder. A PDF stores one part per page (1-based), an image or an HTML
//! file one part.
//!
//! This index has no `note_cache`, so Electron's foreign keys to it are left out (as in
//! migration 0008) and the caller prunes the rows of notes that are gone ([`delete_notes`]).
//! For the same reason [`next_pending`] answers the job alone; the caller resolves the note.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension as _, Row, params};

use crate::api::errors::StorageError;
use crate::domain::journal_rules::is_js_whitespace;
use crate::domain::notes::failed;
use crate::storage::repositories::instants::to_iso8601;

/// The `source` of a filed PDF's or image's own text.
pub const OWN_FILE: &str = "";

/// How a part's text was read. `Unreadable` keeps the part's slot so a resumed job does not
/// retry a page that already failed; [`retry`] drops it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtractedTextMethod {
    PdfText,
    Ocr,
    Html,
    Unreadable,
}

impl ExtractedTextMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PdfText => "pdf-text",
            Self::Ocr => "ocr",
            Self::Html => "html",
            Self::Unreadable => "unreadable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileTextJobStatus {
    Pending,
    Done,
    Failed,
}

impl FileTextJobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        [Self::Pending, Self::Done, Self::Failed]
            .into_iter()
            .find(|status| status.as_str() == text)
    }
}

/// How a job ended: [`finish`] never sets a job back to pending.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobOutcome {
    Done,
    Failed(Option<String>),
}

/// One file whose text is searchable under `note_id`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TextSource {
    pub note_id: String,
    pub source: String,
}

/// A `file_text_jobs` row. `signature` is the size and mtime of the bytes the parts came
/// from; `app_version` the build that last worked on it; `ocr_languages` the Tesseract
/// language string (`eng+deu`) its OCR parts were read with, `None` meaning English only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileTextJob {
    pub note_id: String,
    pub source: String,
    pub signature: String,
    pub status: FileTextJobStatus,
    pub page_count: Option<u32>,
    pub error: Option<String>,
    pub app_version: String,
    pub updated_at: String,
    pub ocr_languages: Option<String>,
}

/// Collapse layout whitespace; keep line and paragraph breaks (`normalizeExtractedText`).
///
/// One pass over Electron's three replaces and `trim`: a run of JavaScript whitespace other
/// than `\n` becomes one space, a space beside a line break goes, three or more breaks
/// become two, and the ends are trimmed.
pub fn normalize_extracted_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    let mut breaks = 0usize;
    for c in text.chars() {
        if c == '\n' {
            space = false;
            breaks += 1;
        } else if is_js_whitespace(c) {
            space |= breaks == 0;
        } else {
            if !out.is_empty() {
                if breaks > 0 {
                    out.push_str(if breaks == 1 { "\n" } else { "\n\n" });
                } else if space {
                    out.push(' ');
                }
            }
            space = false;
            breaks = 0;
            out.push(c);
        }
    }
    out
}

const JOB_COLUMNS: &str = "note_id, source, signature, status, page_count, error, app_version, \
                           updated_at, ocr_languages";

fn job_row(row: &Row<'_>) -> rusqlite::Result<FileTextJob> {
    let status: String = row.get(3)?;
    Ok(FileTextJob {
        note_id: row.get(0)?,
        source: row.get(1)?,
        signature: row.get(2)?,
        status: FileTextJobStatus::parse(&status).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                format!("unknown file_text_jobs status {status:?}").into(),
            )
        })?,
        page_count: row.get(4)?,
        error: row.get(5)?,
        app_version: row.get(6)?,
        updated_at: row.get(7)?,
        ocr_languages: row.get(8)?,
    })
}

fn iso(now_ms: i64) -> Result<String, StorageError> {
    to_iso8601(now_ms).ok_or_else(|| StorageError::Failed {
        what: format!("clock out of range: {now_ms}"),
    })
}

pub fn job(conn: &Connection, of: &TextSource) -> Result<Option<FileTextJob>, StorageError> {
    conn.query_row(
        &format!("SELECT {JOB_COLUMNS} FROM file_text_jobs WHERE note_id = ?1 AND source = ?2"),
        params![of.note_id, of.source],
        job_row,
    )
    .optional()
    .map_err(failed)
}

/// Every job in `status`, oldest first.
pub fn jobs_with_status(
    conn: &Connection,
    status: FileTextJobStatus,
) -> Result<Vec<FileTextJob>, StorageError> {
    let mut stmt = conn
        .prepare_cached(&format!(
            "SELECT {JOB_COLUMNS} FROM file_text_jobs WHERE status = ?1
             ORDER BY updated_at, note_id, source"
        ))
        .map_err(failed)?;
    stmt.query_map([status.as_str()], job_row)
        .and_then(|rows| rows.collect())
        .map_err(failed)
}

/// The oldest job still owed work (`nextPendingTextJob`).
pub fn next_pending(conn: &Connection) -> Result<Option<FileTextJob>, StorageError> {
    conn.query_row(
        &format!(
            "SELECT {JOB_COLUMNS} FROM file_text_jobs WHERE status = 'pending'
             ORDER BY updated_at, note_id, source LIMIT 1"
        ),
        [],
        job_row,
    )
    .optional()
    .map_err(failed)
}

/// Attachment jobs of the given notes, or of every note (`listAttachmentJobs`).
pub fn attachment_jobs(
    conn: &Connection,
    note_ids: Option<&[String]>,
) -> Result<Vec<TextSource>, StorageError> {
    let ids = note_ids
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| StorageError::Failed {
            what: err.to_string(),
        })?;
    let mut stmt = conn
        .prepare_cached(
            "SELECT note_id, source FROM file_text_jobs WHERE source <> ''
               AND (?1 IS NULL OR note_id IN (SELECT value FROM json_each(?1)))",
        )
        .map_err(failed)?;
    stmt.query_map([ids], |row| {
        Ok(TextSource {
            note_id: row.get(0)?,
            source: row.get(1)?,
        })
    })
    .and_then(|rows| rows.collect())
    .map_err(failed)
}

/// Start a file over (`startFileTextJob`): drop its text and queue it for the bytes
/// `signature` describes, in one transaction so a crash never leaves text from the old bytes
/// under the new signature. `ocr_languages` stays, as Electron's upsert leaves it.
pub fn reset_file(
    conn: &mut Connection,
    of: &TextSource,
    signature: &str,
    app_version: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let now = iso(now_ms)?;
    let tx = conn.transaction().map_err(failed)?;
    tx.execute(
        "DELETE FROM extracted_text WHERE note_id = ?1 AND source = ?2",
        params![of.note_id, of.source],
    )
    .map_err(failed)?;
    tx.execute(
        "INSERT INTO file_text_jobs
           (note_id, source, signature, status, page_count, error, app_version, updated_at)
         VALUES (?1, ?2, ?3, 'pending', NULL, NULL, ?4, ?5)
         ON CONFLICT (note_id, source) DO UPDATE SET signature = excluded.signature,
           status = 'pending', page_count = NULL, error = NULL,
           app_version = excluded.app_version, updated_at = excluded.updated_at",
        params![of.note_id, of.source, signature, app_version, now],
    )
    .map_err(failed)?;
    tx.commit().map_err(failed)
}

/// Queue a failed job, or a finished one with unreadable parts, again (`retryFileTextJob`):
/// its unreadable parts go and the text it did read stays.
pub fn retry(
    conn: &mut Connection,
    of: &TextSource,
    app_version: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let now = iso(now_ms)?;
    let tx = conn.transaction().map_err(failed)?;
    tx.execute(
        "DELETE FROM extracted_text WHERE note_id = ?1 AND source = ?2 AND method = 'unreadable'",
        params![of.note_id, of.source],
    )
    .map_err(failed)?;
    tx.execute(
        "UPDATE file_text_jobs SET status = 'pending', error = NULL, app_version = ?3,
           updated_at = ?4
         WHERE note_id = ?1 AND source = ?2",
        params![of.note_id, of.source, app_version, now],
    )
    .map_err(failed)?;
    tx.commit().map_err(failed)
}

/// Queue a finished job again with every part it stored (`requeueFileTextJob`); the reader
/// decides which to replace.
pub fn requeue(conn: &Connection, of: &TextSource, now_ms: i64) -> Result<(), StorageError> {
    conn.execute(
        "UPDATE file_text_jobs SET status = 'pending', error = NULL, updated_at = ?3
         WHERE note_id = ?1 AND source = ?2",
        params![of.note_id, of.source, iso(now_ms)?],
    )
    .map(drop)
    .map_err(failed)
}

/// Forget a file that is gone: its job and its text (`deleteTextSource`).
pub fn delete_source(conn: &mut Connection, of: &TextSource) -> Result<(), StorageError> {
    let tx = conn.transaction().map_err(failed)?;
    for table in ["extracted_text", "file_text_jobs"] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE note_id = ?1 AND source = ?2"),
            params![of.note_id, of.source],
        )
        .map_err(failed)?;
    }
    tx.commit().map_err(failed)
}

/// Forget every job and part of these notes: what Electron's cascade from `note_cache` did.
pub fn delete_notes(conn: &mut Connection, note_ids: &[String]) -> Result<(), StorageError> {
    let ids = serde_json::to_string(note_ids).map_err(|err| StorageError::Failed {
        what: err.to_string(),
    })?;
    let tx = conn.transaction().map_err(failed)?;
    for table in ["extracted_text", "file_text_jobs"] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE note_id IN (SELECT value FROM json_each(?1))"),
            [&ids],
        )
        .map_err(failed)?;
    }
    tx.commit().map_err(failed)
}

pub fn set_page_count(
    conn: &Connection,
    of: &TextSource,
    page_count: u32,
) -> Result<(), StorageError> {
    conn.execute(
        "UPDATE file_text_jobs SET page_count = ?3 WHERE note_id = ?1 AND source = ?2",
        params![of.note_id, of.source, page_count],
    )
    .map(drop)
    .map_err(failed)
}

/// End a job (`finishFileTextJob`), recording the OCR languages its parts were read with.
pub fn finish(
    conn: &Connection,
    of: &TextSource,
    outcome: &JobOutcome,
    ocr_languages: Option<&str>,
    now_ms: i64,
) -> Result<(), StorageError> {
    let (status, error) = match outcome {
        JobOutcome::Done => (FileTextJobStatus::Done, None),
        JobOutcome::Failed(error) => (FileTextJobStatus::Failed, error.as_deref()),
    };
    conn.execute(
        "UPDATE file_text_jobs SET status = ?3, error = ?4, ocr_languages = ?5, updated_at = ?6
         WHERE note_id = ?1 AND source = ?2",
        params![
            of.note_id,
            of.source,
            status.as_str(),
            error,
            ocr_languages,
            iso(now_ms)?
        ],
    )
    .map(drop)
    .map_err(failed)
}

/// Store one part's text, replacing what that part held (`saveExtractedPart`).
pub fn save_part(
    conn: &Connection,
    of: &TextSource,
    part: u32,
    method: ExtractedTextMethod,
    text: &str,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO extracted_text (note_id, source, part, method, text)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (note_id, source, part) DO UPDATE
           SET method = excluded.method, text = excluded.text",
        params![of.note_id, of.source, part, method.as_str(), text],
    )
    .map(drop)
    .map_err(failed)
}

/// The parts a job already stored, or the ones read as `method`, so a resumed job reads only
/// the rest (`storedExtractedParts`; `hasPartsReadAs` is a non-empty answer).
pub fn parts_for(
    conn: &Connection,
    of: &TextSource,
    method: Option<ExtractedTextMethod>,
) -> Result<BTreeSet<u32>, StorageError> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT part FROM extracted_text WHERE note_id = ?1 AND source = ?2
               AND (?3 IS NULL OR method = ?3)",
        )
        .map_err(failed)?;
    stmt.query_map(
        params![
            of.note_id,
            of.source,
            method.map(ExtractedTextMethod::as_str)
        ],
        |row| row.get(0),
    )
    .and_then(|rows| rows.collect())
    .map_err(failed)
}

/// Everything read for a note so far, own file first, as one searchable string
/// (`getExtractedText`): its non-empty parts in (source, part) order, joined by blank lines.
pub fn extracted_text_for_note(conn: &Connection, note_id: &str) -> Result<String, StorageError> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT text FROM extracted_text WHERE note_id = ?1 AND text <> ''
             ORDER BY source, part",
        )
        .map_err(failed)?;
    let parts = stmt
        .query_map([note_id], |row| row.get::<_, String>(0))
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(failed)?;
    Ok(parts.join("\n\n"))
}

#[cfg(test)]
#[path = "file_text_tests.rs"]
mod tests;
