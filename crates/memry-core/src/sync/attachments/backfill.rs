//! The attachment backfill (#3535 S5): queues the vault files a note owns or
//! embeds that the server never got (`attachment-backfill.ts`,
//! `attachment-files.ts` `referencedVaultFiles`). Every upload re-drive runs it
//! before the drain.
//!
//! It only adds: a queue row, a record that follows a renamed file, or a
//! record that counts a pre-record note's files as known. Each note's writes
//! are one transaction, and a file with a queue row keeps its attempts and its
//! retry window, so a pass cut off anywhere converges on the next.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Read};
use std::sync::{Arc, LazyLock};

use regex::Regex;
use rusqlite::Connection;

use super::plan::{ChangePlan, NoteAttachments};
use super::queue::{VaultFiles, absolute};
use super::revival::{NoteRow, live_notes, own_folder_files, records_on_disk};
use super::store::upload_queue::Refusals;
use super::store::{files, upload_queue};
use crate::api::errors::StorageError;
use crate::storage::{Db, nested_tx};

/// A note body is scanned up to this size: a larger file is not a note anyone
/// writes by hand, and its first part still offers its embeds.
const MAX_BODY_BYTES: u64 = 32 * 1024 * 1024;

/// `![alt](url)`, `EMBED_RE` (`attachment-files.ts:30`).
static EMBED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)"#).expect("EMBED_RE")
});
/// `<!-- file:{"url": ...} -->`, `FILE_MARKER_RE` (`attachment-files.ts:32`).
static FILE_MARKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<!--\s*file:(\{.*?\})\s*-->").expect("FILE_MARKER_RE"));
/// A url with a scheme is not a vault path, `HAS_SCHEME`.
static HAS_SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z0-9+.-]*:").expect("HAS_SCHEME"));

/// The vault-relative files a note body embeds (`referencedVaultFiles`):
/// note-relative urls and the root-relative `attachments/<noteId>/` form. A
/// url with a scheme or a leading slash, or one that climbs out of the vault,
/// is dropped. Linear in the body: the regex engine has no backtracking.
pub fn embedded_files(markdown: &str, note_path: &str, note_id: &str) -> Vec<String> {
    let mut urls: Vec<String> = EMBED
        .captures_iter(markdown)
        .map(|found| found[1].to_owned())
        .collect();
    for found in FILE_MARKER.captures_iter(markdown) {
        let marker: Option<serde_json::Value> = serde_json::from_str(&found[1]).ok();
        if let Some(url) = marker.as_ref().and_then(|m| m.get("url")?.as_str()) {
            urls.push(url.to_owned());
        }
    }
    let note_dir = note_path.rsplit_once('/').map_or("", |(dir, _)| dir);
    let own = format!("attachments/{note_id}");
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for raw in urls {
        if HAS_SCHEME.is_match(&raw) || raw.starts_with('/') || raw.starts_with('\\') {
            continue;
        }
        let normalized = percent_decoded(&raw).replace('\\', "/");
        let root_relative = normalized == own || normalized.starts_with(&format!("{own}/"));
        let base = if root_relative { "" } else { note_dir };
        if let Some(path) = resolve(base, &normalized)
            && seen.insert(path.clone())
        {
            out.push(path);
        }
    }
    out
}

/// `decodeURIComponent`, or the raw spelling when it is not percent-encoded.
fn percent_decoded(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = raw
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok());
            let Some(byte) = hex else {
                return raw.to_owned();
            };
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| raw.to_owned())
}

/// `base/rel` with `.` and `..` folded; `None` when it leaves the vault or
/// names the root.
fn resolve(base: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for part in base.split('/').chain(rel.split('/')) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            name => parts.push(name),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// What one backfill pass did.
#[derive(Debug, Default)]
pub struct BackfillReport {
    pub notes: usize,
    pub queued: usize,
    /// Notes this pass could not finish, with the reason; the next pass
    /// retries them.
    pub errors: Vec<String>,
}

/// One pass over every live note (`backfillUnsyncedAttachmentsWith`).
pub async fn backfill(db: &Db, vault: Arc<dyn VaultFiles>) -> Result<BackfillReport, StorageError> {
    let notes = db.call(|conn| live_notes(conn, None)).await?;
    let refusals = Arc::new(db.call(|conn| upload_queue::refusals(conn)).await?);
    let ids: BTreeSet<String> = notes.iter().map(|note| note.id.clone()).collect();
    let file_notes: BTreeMap<String, (String, bool)> = notes
        .iter()
        .filter(|note| !note.markdown)
        .filter_map(|n| Some((n.path.clone()?, (n.id.clone(), n.attachment_id.is_some()))))
        .collect();
    let mut report = BackfillReport::default();
    for note in notes {
        if note.local_only {
            continue;
        }
        let files = match note_files(vault.as_ref(), &note, &ids, &file_notes) {
            Ok(files) => files,
            Err(error) => {
                report.errors.push(format!("note {}: {error}", note.id));
                continue;
            }
        };
        let (vault, id, refusals) = (vault.clone(), note.id.clone(), refusals.clone());
        let written = db
            .call(move |conn| backfill_note(conn, vault.as_ref(), &refusals, &note, files))
            .await;
        match written {
            Ok(0) => {}
            Ok(queued) => {
                report.notes += 1;
                report.queued += queued;
            }
            Err(error) => report.errors.push(format!("note {id}: {error}")),
        }
    }
    for error in &report.errors {
        eprintln!("memry-core: attachment backfill skipped {error}");
    }
    Ok(report)
}

/// The files to offer for `note`: a file note's own file, its own folder, and
/// what its body embeds outside every note's folder (the folder scan owns
/// those) and outside a file note that has its bytes on their way.
fn note_files(
    vault: &dyn VaultFiles,
    note: &NoteRow,
    note_ids: &BTreeSet<String>,
    file_notes: &BTreeMap<String, (String, bool)>,
) -> io::Result<Vec<String>> {
    let mut found = own_folder_files(vault, &note.id)?;
    let Some(path) = &note.path else {
        return Ok(found);
    };
    if !note.markdown {
        return Ok(found);
    }
    let body = match vault.open(path) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(MAX_BODY_BYTES).read_to_end(&mut bytes)?;
            String::from_utf8_lossy(&bytes).into_owned()
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(found),
        Err(error) => return Err(error),
    };
    for file in embedded_files(&body, path, &note.id) {
        let keep = match file.strip_prefix("attachments/") {
            Some(rest) => {
                let folder = rest.split('/').next().unwrap_or_default();
                folder != note.id && !note_ids.contains(folder)
            }
            None => !file_notes.get(&file).is_some_and(|(_, uploaded)| *uploaded),
        };
        if keep && vault.open(&file).is_ok() {
            found.push(file);
        }
    }
    Ok(found)
}

/// Writes one note's plan: file-note offer, counts, moves, then offers. One
/// transaction. Returns the rows it added.
fn backfill_note(
    conn: &Connection,
    vault: &dyn VaultFiles,
    refusals: &Refusals,
    note: &NoteRow,
    files_found: Vec<String>,
) -> Result<usize, StorageError> {
    let now = super::transfer::now_ms();
    let records = records_on_disk(conn, vault, &note.id)?;
    let transaction = nested_tx::begin(conn).map_err(failed)?;
    let mut queued = 0;
    // `queueUnsentFileNotes`: a file note whose bytes never went up.
    if let (false, None, Some(path)) = (note.markdown, &note.attachment_id, &note.path)
        && vault.open(path).is_ok()
        && upload_queue::queue_if_absent(
            &transaction,
            vault,
            refusals,
            &note.id,
            &absolute(vault, path),
            now,
        )?
    {
        queued += 1;
    }
    let plan = ChangePlan::for_note(&NoteAttachments {
        note_id: note.id.clone(),
        references: note.references.clone(),
        own_attachment_id: note.attachment_id.clone(),
        files: files_found,
        records,
        ..NoteAttachments::default()
    });
    if !plan.count_known.is_empty() {
        files::count_known(&transaction, &note.id, &plan.count_known, now)?;
    }
    for moved in &plan.move_records {
        files::move_record(&transaction, &note.id, &moved.from, &moved.to, now)?;
    }
    for file in &plan.offer {
        let path = absolute(vault, file);
        if upload_queue::queue_if_absent(&transaction, vault, refusals, &note.id, &path, now)? {
            queued += 1;
        }
    }
    transaction.commit().map_err(failed)?;
    Ok(queued)
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
