//! The change plan: for one note, which files go to the server, which
//! attachment references the note keeps, and which ids its delete frees later
//! (chapter 14 §14.7, §14.8, §14.8.2). Pure, so the backfill, the revival
//! check and the release runner share one decision and test it without IO.
//!
//! Ports Electron's `attachment-files.ts` (`unrecordedFiles`,
//! `takeOverRenamedRecord`, `filesOfAttachments`), `attachment-backfill.ts`,
//! `note-attachment-metadata.ts:12-18`, `note-attachment-revival.ts` and
//! `deleted-asset-release.ts`.
//!
//! Two rules carry the data-loss risk:
//!
//! - **References shrink only on proof.** A reference is dropped only when the
//!   caller proved the attachment gone (no manifest, a hold probe that names it
//!   missing). A note that loses a reference no peer can download it again.
//! - **A release never frees what something still names.** The release runner
//!   asks [`attachments_to_free`], which leaves out every id a live item, or an
//!   item still inside its grace period, references.

use std::collections::{BTreeMap, BTreeSet};

/// How long a deleted item keeps its server chunks, so a restore from the OS
/// trash still finds them (`ASSET_RELEASE_GRACE_MS`, `asset-store.ts:95`).
pub const RELEASE_GRACE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// The `path` of the record that marks a note counted while it had no file on
/// disk (`COUNTED_EMPTY`, `attachment-files.ts:27`).
pub const COUNTED_EMPTY: &str = "";

/// One `attachment_files` row of the note: a vault file the server has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRecord {
    /// Vault-relative, `/`-separated.
    pub path: String,
    /// `None` for a file counted as known without an upload.
    pub attachment_id: Option<String>,
    /// The recorded file is on disk now.
    pub on_disk: bool,
}

/// What the plan reads about one note. Paths are vault-relative and
/// `/`-separated; the caller has already dropped every path outside the vault.
#[derive(Debug, Clone, Default)]
pub struct NoteAttachments {
    pub note_id: String,
    /// Kept off the server on purpose: nothing of it is uploaded.
    pub local_only: bool,
    /// This device deleted the note.
    pub deleted: bool,
    /// The note's `attachmentReferences`, in order.
    pub references: Vec<String>,
    /// The note's own `attachmentId`.
    pub own_attachment_id: Option<String>,
    /// The vault path of a non-markdown note, whose file is its attachment.
    pub file_note_path: Option<String>,
    /// Ids an upload for this note just stored on the server.
    pub uploaded: Vec<String>,
    /// Every file the note owns (`attachments/<noteId>/`) or embeds that is
    /// on disk. Every file of the note's own folder must be listed: a recorded
    /// file there that is not listed reads as renamed.
    pub files: Vec<String>,
    /// The note's `attachment_files` rows.
    pub records: Vec<FileRecord>,
    /// Ids the server proved gone: no manifest, or a probe that named them.
    pub gone: BTreeSet<String>,
}

/// An `attachment_files` row that follows its file to a new name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordMove {
    pub from: String,
    pub to: String,
}

/// What follows from one note's state.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChangePlan {
    /// The note's references after the change.
    pub keep: Vec<String>,
    /// References dropped because the server proved them gone.
    pub drop_gone: Vec<String>,
    /// Files to queue unless a queue row exists (the backfill,
    /// `queueUploadIfAbsent`).
    pub offer: Vec<String>,
    /// Files to queue again because their attachment is gone (the revival,
    /// `enqueueUpload`).
    pub reupload: Vec<String>,
    /// Records to write with no attachment id: the files of a note seen with
    /// references and no record, which count as known instead of uploading.
    pub count_known: Vec<String>,
    pub move_records: Vec<RecordMove>,
    /// Ids the delete of this note records for release after the grace period.
    pub schedule_release: Vec<String>,
}

impl ChangePlan {
    pub fn for_note(note: &NoteAttachments) -> Self {
        if note.deleted {
            // `recordDeletedItemAssets` (`deleted-asset-release.ts:80-87`).
            return Self {
                keep: note.references.clone(),
                schedule_release: unique(note.references.iter().chain(&note.own_attachment_id)),
                ..Self::default()
            };
        }

        // Union only (`note-attachment-metadata.ts:12-18`).
        let mut keep = unique(note.references.iter().chain(&note.uploaded));
        if note.local_only {
            return Self {
                keep,
                ..Self::default()
            };
        }

        let gone: BTreeSet<String> = keep
            .iter()
            .chain(&note.own_attachment_id)
            .filter(|id| note.gone.contains(*id))
            .cloned()
            .collect();
        let drop_gone: Vec<String> = keep
            .iter()
            .filter(|id| gone.contains(*id))
            .cloned()
            .collect();
        keep.retain(|id| !gone.contains(id));

        let mut plan = Self {
            keep,
            drop_gone,
            reupload: files_of_gone(note, &gone),
            ..Self::default()
        };
        plan.backfill(note);
        plan
    }

    /// `unrecordedFiles` (`attachment-files.ts:288-304`).
    fn backfill(&mut self, note: &NoteAttachments) {
        let mut files = unique(&note.files);
        if note.records.is_empty() && !note.references.is_empty() {
            // A note from before the records: its files are the server's
            // already, under ids nothing on this device can match.
            if files.is_empty() {
                files.push(COUNTED_EMPTY.to_owned());
            }
            self.count_known = files;
            return;
        }

        let mut recorded: BTreeMap<String, bool> = note
            .records
            .iter()
            .map(|record| (record.path.clone(), record.on_disk))
            .collect();
        for file in files {
            if recorded.contains_key(&file) {
                continue;
            }
            match renamed_record(&note.note_id, &file, &recorded) {
                Some(from) => {
                    recorded.remove(&from);
                    recorded.insert(file.clone(), true);
                    self.move_records.push(RecordMove { from, to: file });
                }
                None => self.offer.push(file),
            }
        }
    }
}

/// A file renamed inside the note's own folder keeps its stored prefix; a
/// recorded file with that prefix that is gone from disk is this file under
/// its old name (`takeOverRenamedRecord`, `attachment-files.ts:250-281`).
fn renamed_record(note_id: &str, file: &str, recorded: &BTreeMap<String, bool>) -> Option<String> {
    let folder = format!("attachments/{note_id}/");
    let name = file.strip_prefix(&folder)?;
    let prefix = stored_prefix(name)?;
    let wanted = format!("{folder}{prefix}");
    recorded
        .range(wanted.clone()..)
        .take_while(|(path, _)| path.starts_with(&wanted))
        .find(|(_, on_disk)| !**on_disk)
        .map(|(path, _)| path.clone())
}

/// `STORED_PREFIX_RE` (`attachment-heal.ts:26`): six of `[0-9a-z]`, then `-`.
fn stored_prefix(name: &str) -> Option<&str> {
    let bytes = name.as_bytes();
    let stored = bytes.len() >= 7
        && bytes[..6]
            .iter()
            .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase())
        && bytes[6] == b'-';
    stored.then(|| &name[..7])
}

/// The files on disk that hold the gone attachments (`filesOfAttachments`,
/// `attachment-files.ts:330-352`, and the file note's own file,
/// `note-attachment-revival.ts:94-96`). An id no record names can be any of
/// the note's files not recorded under another attachment.
fn files_of_gone(note: &NoteAttachments, gone: &BTreeSet<String>) -> Vec<String> {
    if gone.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<&String> = Vec::new();
    let named: BTreeSet<&str> = note
        .records
        .iter()
        .filter_map(|record| record.attachment_id.as_deref())
        .collect();
    for record in &note.records {
        let in_gone = record
            .attachment_id
            .as_ref()
            .is_some_and(|id| gone.contains(id));
        if in_gone && record.on_disk {
            out.push(&record.path);
        }
    }
    if gone.iter().any(|id| !named.contains(id.as_str())) {
        let other: BTreeSet<&str> = note
            .records
            .iter()
            .filter(|record| {
                record
                    .attachment_id
                    .as_ref()
                    .is_some_and(|id| !gone.contains(id))
            })
            .map(|record| record.path.as_str())
            .collect();
        out.extend(
            note.files
                .iter()
                .filter(|file| !other.contains(file.as_str())),
        );
    }
    if let (Some(path), Some(own)) = (&note.file_note_path, &note.own_attachment_id)
        && gone.contains(own)
    {
        out.push(path);
    }
    unique(out)
}

/// A recorded delete is due once the grace period has passed
/// (`releaseExpiredDeletedAssets`, `deleted-asset-release.ts:317-322`).
pub fn release_is_due(deleted_at_ms: i64, now_ms: i64) -> bool {
    deleted_at_ms <= now_ms.saturating_sub(RELEASE_GRACE_MS)
}

/// The recorded ids of a due delete whose chunks are freed now. Nothing when
/// the owner is live again (a revived note, `releaseNote`), and never an id in
/// `still_referenced`: a live note's references or own file, the images of a
/// live canvas or of one inside its grace period, and the ids of a note this
/// device deleted inside the grace period (`stillReferenced`,
/// `deleted-asset-release.ts:126-196`).
pub fn attachments_to_free(
    recorded: &[String],
    owner_live: bool,
    still_referenced: &BTreeSet<String>,
) -> Vec<String> {
    if owner_live {
        return Vec::new();
    }
    unique(recorded.iter().filter(|id| !still_referenced.contains(*id)))
}

/// The values in first-seen order, each once. References are peer data, so
/// this stays `O(n log n)` however many a note carries.
fn unique<'a>(values: impl IntoIterator<Item = &'a String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.as_str()))
        .cloned()
        .collect()
}
