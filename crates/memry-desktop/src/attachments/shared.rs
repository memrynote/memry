//! An attachment one note stores, embedded by another (#2077): port of
//! `vault/attachment-references.ts`.
//!
//! The bytes live at `attachments/<ownerNoteId>/<filename>` for life, so that pair is the
//! attachment's identity across the vault. A second note embeds the same file by writing that
//! path relative to its own folder; nothing is copied, and every reader of attachment refs
//! (resolve, self-heal, the cross-device remap, sync) reads a shared one unchanged.
//!
//! The picker lists what the `attachments/` folder holds, not a table: the folder is what exists
//! on this device. A folder or a file that is a link is not listed and not referenced, so a
//! picked entry never points out of the vault.

use std::fs;
use std::path::Path;
use std::time::SystemTime;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;

use super::{
    AttachmentError, AttachmentKind, display_name_for_stored, inside_vault, is_allowed_extension,
    is_note_id, is_plain_segment, kind_of, mime_type, relative_ref,
};
use crate::session::OpenVault;
use crate::shell::file_open::{Resolution, resolve_under_root};
use crate::vault::layout::ATTACHMENTS_DIR;

const SCOPE: &str = "attachments";

/// One stored attachment anywhere in the vault: `VaultAttachmentEntry` of `@memry/rpc/notes`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultAttachmentEntry {
    pub owner_note_id: String,
    /// `None` when the owning note is gone from the vault; its bytes are still here.
    pub owner_note_title: Option<String>,
    /// The stored name, `k3f9x2-report.pdf`.
    pub filename: String,
    /// The stored name without its prefix.
    pub display_name: String,
    pub size: i64,
    pub mime_type: &'static str,
    #[serde(rename = "type")]
    pub kind: AttachmentKind,
    /// The file's modification time, ISO-8601 in UTC with milliseconds.
    pub modified_at: String,
}

/// The block props that embed an attachment another note stores: `InsertExistingAttachmentResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InsertedAttachment {
    /// The block's `url`, relative to the receiving note's file.
    pub url: String,
    pub name: String,
    pub filename: String,
    pub owner_note_id: String,
    pub size: i64,
    pub mime_type: &'static str,
    #[serde(rename = "type")]
    pub kind: AttachmentKind,
}

/// `listVaultAttachments`: every attachment of an allowed type, newest first. A folder whose
/// note is gone is listed without a title. An unreadable folder is skipped and logged.
pub fn list_vault(open: &OpenVault) -> Result<Vec<VaultAttachmentEntry>, AttachmentError> {
    let root = open.path.join(ATTACHMENTS_DIR);
    if fs::symlink_metadata(&root).is_err() {
        return Ok(Vec::new());
    }
    if inside_vault(&open.path, ATTACHMENTS_DIR).is_err() {
        tracing::warn!(
            scope = SCOPE,
            "the attachments folder is not a folder of the vault"
        );
        return Ok(Vec::new());
    }
    let mut listed: Vec<(SystemTime, VaultAttachmentEntry)> = Vec::new();
    for owner in fs::read_dir(&root)? {
        let owner = owner?;
        let Ok(owner_id) = owner.file_name().into_string() else {
            continue;
        };
        if owner_id.starts_with('.') || !owner.file_type()?.is_dir() {
            continue;
        }
        let title = open
            .vault
            .note_files()
            .listed_by_id(&owner_id)?
            .map(|note| note.title);
        let files = match fs::read_dir(owner.path()) {
            Ok(files) => files,
            Err(error) => {
                tracing::warn!(
                    scope = SCOPE,
                    "an attachment folder was not read: {:?}",
                    error.kind()
                );
                continue;
            }
        };
        for file in files.flatten() {
            let Ok(filename) = file.file_name().into_string() else {
                continue;
            };
            // A link is not one of the folder's files, and the picker offers only what a block
            // can show.
            let Ok(meta) = file.metadata() else { continue };
            if filename.starts_with('.')
                || !meta.file_type().is_file()
                || !is_allowed_extension(super::extension(&filename))
            {
                continue;
            }
            let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            listed.push((
                modified,
                VaultAttachmentEntry {
                    owner_note_id: owner_id.clone(),
                    owner_note_title: title.clone(),
                    display_name: display_name_for_stored(&filename).to_owned(),
                    size: i64::try_from(meta.len()).unwrap_or(i64::MAX),
                    mime_type: mime_type(&filename),
                    kind: kind_of(&filename),
                    modified_at: iso_millis(modified),
                    filename,
                },
            ));
        }
    }
    listed.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(listed.into_iter().map(|(_, entry)| entry).collect())
}

/// `Date.prototype.toISOString`.
fn iso_millis(time: SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `buildExistingAttachmentReference`: the block props for `note_id` to embed `filename` of
/// `owner_note_id`'s folder, the same note included. Nothing is written. The owner id and the
/// name must each be one plain name, and the file a regular file of the vault.
pub fn insert_existing(
    open: &OpenVault,
    note_id: &str,
    owner_note_id: &str,
    filename: &str,
) -> Result<InsertedAttachment, AttachmentError> {
    if !is_note_id(owner_note_id) || !is_plain_segment(filename) {
        return Err(AttachmentError::BadReference);
    }
    let target = format!("{ATTACHMENTS_DIR}/{owner_note_id}/{filename}");
    let size = match resolve_under_root(&open.path, &target)? {
        Resolution::Inside(_) => regular_file_size(&open.path.join(&target))?,
        Resolution::Missing => return Err(AttachmentError::FileNotFound),
        Resolution::Outside => return Err(AttachmentError::OutsideVault),
    };
    let note_path = open
        .vault
        .note_files()
        .by_id(note_id)?
        .map(|row| row.path)
        .ok_or_else(|| AttachmentError::NoteNotFound(note_id.to_owned()))?;
    Ok(InsertedAttachment {
        url: relative_ref(&note_path, &target),
        name: display_name_for_stored(filename).to_owned(),
        filename: filename.to_owned(),
        owner_note_id: owner_note_id.to_owned(),
        size,
        mime_type: mime_type(filename),
        kind: kind_of(filename),
    })
}

/// The size of the file at `path`, which must not be a link.
fn regular_file_size(path: &Path) -> Result<i64, AttachmentError> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.file_type().is_file() {
        return Err(AttachmentError::FileNotFound);
    }
    Ok(i64::try_from(meta.len()).unwrap_or(i64::MAX))
}
