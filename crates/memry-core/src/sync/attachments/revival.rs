//! The revived-note check (#3535 S5, §14.8.2, `note-attachment-revival.ts`).
//!
//! A device whose edit beats a pulled delete brings the note back on every
//! device. When the deleting device has already freed the note's chunks, the
//! note names attachments no peer can download, and only this device still has
//! the files. The upload re-drive checks each attachment of a revived note on
//! the server (no manifest, or a probe hold that names it missing), queues the
//! local file of each gone one, and drops the gone ids from the references.
//!
//! Electron keeps revived notes in memory and loses them on a restart. Here
//! they are rows of `attachment_revived_notes` (data migration 0045), and a
//! row goes only once its check settled, so a check cut off anywhere runs
//! again. The writes follow one order, each step committed before the next:
//! record moves, then the queue rows, then the dropped references, then the
//! settled row. A crash between two steps leaves the earlier ones, which the
//! next check reads; the references never shrink before the file is queued.

use std::collections::BTreeSet;
use std::io;
use std::sync::Arc;

use rusqlite::{Connection, params};

use super::holds::{AttachmentChunks, HoldOutcome};
use super::plan::{ChangePlan, FileRecord, NoteAttachments};
use super::queue::{VaultFiles, absolute};
use super::server::AttachmentServer;
use super::store::{files, upload_queue};
use super::transfer::now_ms;
use crate::api::errors::StorageError;
use crate::domain::notes::{read_attachment_references, remove_attachment_reference};
use crate::storage::{Db, nested_tx};

/// This device's edit beat a pulled delete of `note_id` (the
/// `ApplyObserver::note_revived` entry point). Idempotent.
pub fn mark_revived(conn: &Connection, note_id: &str, now_ms: i64) -> Result<(), StorageError> {
    conn.execute(
        "INSERT OR IGNORE INTO attachment_revived_notes (note_id, revived_at) VALUES (?1, ?2)",
        params![note_id, now_ms],
    )
    .map(drop)
    .map_err(failed)
}

/// Revived notes whose check has not settled.
pub fn revived(conn: &Connection) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare("SELECT note_id FROM attachment_revived_notes ORDER BY revived_at, note_id")
        .map_err(failed)?;
    statement
        .query_map([], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

fn settle(conn: &Connection, note_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM attachment_revived_notes WHERE note_id = ?1",
        params![note_id],
    )
    .map(drop)
    .map_err(failed)
}

/// What one pass over the revived notes did.
#[derive(Debug, Default)]
pub struct RevivalReport {
    pub settled: usize,
    pub queued: usize,
    /// Ids dropped from references because the server proved them gone.
    pub freed: usize,
    /// Notes left for the next pass, with the reason.
    pub pending: Vec<String>,
}

/// Checks every revived note once (`settleRevivedNotes`). A note whose check
/// cannot reach the server, or whose writes fail, stays for the next pass.
pub async fn settle_revived(
    db: &Db,
    server: AttachmentServer<'_>,
    vault: Arc<dyn VaultFiles>,
    device_id: &str,
) -> Result<RevivalReport, StorageError> {
    let mut report = RevivalReport::default();
    for note_id in db.call(|conn| revived(conn)).await? {
        match check(db, server, vault.clone(), device_id, &note_id).await {
            Ok((queued, freed)) => {
                report.settled += 1;
                report.queued += queued;
                report.freed += freed;
            }
            Err(reason) => {
                eprintln!(
                    "memry-core: revived note {note_id}: attachment check deferred: {reason}"
                );
                report.pending.push(format!("{note_id}: {reason}"));
            }
        }
    }
    Ok(report)
}

/// One note: `(files queued, ids dropped)`, or why it stays.
async fn check(
    db: &Db,
    server: AttachmentServer<'_>,
    vault: Arc<dyn VaultFiles>,
    device_id: &str,
    note_id: &str,
) -> Result<(usize, usize), String> {
    let id = note_id.to_owned();
    let note = db
        .call(move |conn| live_notes(conn, Some(&id)))
        .await
        .map_err(|e| e.to_string())?
        .pop();
    let note = match note {
        Some(note) if !note.local_only => note,
        // Gone again, or kept off the server: nothing to check.
        _ => return settle_now(db, note_id).await.map(|()| (0, 0)),
    };
    let mut ids = note.references.clone();
    ids.extend(note.attachment_id.clone());
    let mut gone = BTreeSet::new();
    let mut stored = Vec::new();
    for attachment_id in ids.into_iter().collect::<BTreeSet<_>>() {
        match server.chunk_hashes(&attachment_id).await {
            Ok(None) => {
                gone.insert(attachment_id);
            }
            Ok(Some(chunk_hashes)) => stored.push(AttachmentChunks {
                attachment_id,
                chunk_hashes,
            }),
            Err(error) => return Err(format!("manifest of {attachment_id}: {error}")),
        }
    }
    match server.probe_note(note_id, &stored).await {
        Ok(HoldOutcome::Held { missing }) => gone.extend(missing),
        // A server before holds cannot tell; the manifests are all it has.
        Ok(HoldOutcome::Unsupported) => {}
        Ok(HoldOutcome::Failed { status, .. }) => return Err(format!("probe failed ({status})")),
        Err(error) => return Err(format!("probe holder id: {error}")),
    }
    if gone.is_empty() {
        return settle_now(db, note_id).await.map(|()| (0, 0));
    }
    let own_files = own_folder_files(vault.as_ref(), note_id).map_err(|e| e.to_string())?;
    let device = device_id.to_owned();
    db.call(move |conn| reupload(conn, vault.as_ref(), &note, own_files, gone, &device))
        .await
        .map_err(|e| e.to_string())
}

async fn settle_now(db: &Db, note_id: &str) -> Result<(), String> {
    let id = note_id.to_owned();
    db.call(move |conn| settle(conn, &id))
        .await
        .map_err(|e| e.to_string())
}

fn reupload(
    conn: &Connection,
    vault: &dyn VaultFiles,
    note: &NoteRow,
    own_files: Vec<String>,
    gone: BTreeSet<String>,
    device_id: &str,
) -> Result<(usize, usize), StorageError> {
    let now = now_ms();
    let plan = ChangePlan::for_note(&NoteAttachments {
        note_id: note.id.clone(),
        references: note.references.clone(),
        own_attachment_id: note.attachment_id.clone(),
        file_note_path: note.path.clone().filter(|_| !note.markdown),
        files: own_files,
        records: records_on_disk(conn, vault, &note.id)?,
        gone,
        ..NoteAttachments::default()
    });
    // Moves first, committed on their own: the reupload names the new paths.
    let moves = nested_tx::begin(conn).map_err(failed)?;
    for moved in &plan.move_records {
        files::move_record(&moves, &note.id, &moved.from, &moved.to, now)?;
    }
    moves.commit().map_err(failed)?;

    // A file the uploader refused, unwritten since, would be refused again
    // (#5711, `note-attachment-revival.ts:99-100`).
    let refusals = upload_queue::refusals(conn)?;
    let queue = nested_tx::begin(conn).map_err(failed)?;
    let mut queued = 0;
    for file in &plan.reupload {
        let path = absolute(vault, file);
        if upload_queue::queue_if_absent(&queue, vault, &refusals, &note.id, &path, now)? {
            queued += 1;
        }
    }
    queue.commit().map_err(failed)?;
    // Each drop commits with its note outbox row; a crash before the last one
    // finds the rest still referenced and gone, and queues the same rows again.
    for id in &plan.drop_gone {
        remove_attachment_reference(conn, &note.id, id, device_id, now)?;
    }
    settle(conn, &note.id)?;
    if plan.reupload.is_empty() {
        eprintln!(
            "memry-core: revived note {} names {} freed attachments this device has no copy of",
            note.id,
            plan.drop_gone.len()
        );
    }
    Ok((queued, plan.drop_gone.len()))
}

/// One live note as the backfill sees it.
#[derive(Debug, Clone)]
pub(super) struct NoteRow {
    pub id: String,
    /// The vault path of its file, when the index knows it.
    pub path: Option<String>,
    pub markdown: bool,
    pub attachment_id: Option<String>,
    pub references: Vec<String>,
    pub local_only: bool,
}

/// Every live note, or the one named.
pub(super) fn live_notes(
    conn: &Connection,
    only: Option<&str>,
) -> Result<Vec<NoteRow>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT n.id, f.path, n.file_type, n.attachment_id, COALESCE(f.local_only, 0)
             FROM notes n LEFT JOIN note_files f ON f.note_id = n.id
             WHERE n.deleted_at IS NULL AND (?1 IS NULL OR n.id = ?1)
             ORDER BY n.id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![only], |row| {
            Ok(NoteRow {
                id: row.get(0)?,
                path: row.get(1)?,
                markdown: row.get::<_, String>(2)? == "markdown",
                attachment_id: row.get(3)?,
                references: Vec::new(),
                local_only: row.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    rows.into_iter()
        .map(|mut note| {
            note.references = read_attachment_references(conn, &note.id)?;
            Ok(note)
        })
        .collect()
}

/// The files of the note's own `attachments/<noteId>/` folder.
pub(super) fn own_folder_files(vault: &dyn VaultFiles, note_id: &str) -> io::Result<Vec<String>> {
    let folder = format!("attachments/{note_id}");
    match vault.list_files(&folder) {
        Ok(names) => Ok(names.into_iter().map(|n| format!("{folder}/{n}")).collect()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

/// The note's `attachment_files` rows, each with whether its file is on disk.
pub(super) fn records_on_disk(
    conn: &Connection,
    vault: &dyn VaultFiles,
    owner_id: &str,
) -> Result<Vec<FileRecord>, StorageError> {
    Ok(files::records(conn, owner_id)?
        .into_iter()
        .map(|stored| FileRecord {
            on_disk: !stored.path.is_empty() && vault.open(&stored.path).is_ok(),
            path: stored.path,
            attachment_id: stored.attachment_id,
        })
        .collect())
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
