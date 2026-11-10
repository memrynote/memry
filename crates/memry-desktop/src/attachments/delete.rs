//! Deleting an attachment (#2077): port of `deleteAttachment` (`vault/attachments.ts:523`).
//!
//! Since "insert existing attachment", a second note can embed `attachments/<owner>/<file>` by
//! its own ref, so the file is no longer the owner's alone. It goes only when the reference scan
//! read every body and none but the owner's names it ([`find_references`]); otherwise it stays
//! and the answer says who holds it. A file that goes is moved to the OS trash, not unlinked as
//! in Electron, so a delete can be taken back.
//!
//! The owner's own refs never keep the file, as in Electron (`exclude`).
//!
//! A locked note refuses ([`writable_note`]). Only a regular file of the owner's own folder is
//! deleted, and never through a link: neither `attachments/` nor `attachments/<owner>/` may be
//! one, checked again right before the move.

use std::fs;
use std::io;
use std::path::Path;

use serde::Serialize;

use super::references::find_references;
use super::rename::plain_folder;
use super::{AttachmentError, is_note_id, is_plain_segment, writable_note};
use crate::session::OpenVault;
use crate::vault::consumer::rows::RowOwner;
use crate::vault::layout::ATTACHMENTS_DIR;

/// `DeleteAttachmentOutcome`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeletedAttachment {
    /// False when the file was kept because another note names it, or the scan could not tell.
    pub deleted: bool,
    /// The notes that still name the file; empty whenever `deleted` is true.
    pub referenced_by: Vec<String>,
}

const GONE: DeletedAttachment = DeletedAttachment {
    deleted: true,
    referenced_by: Vec::new(),
};

/// `deleteAttachment`: moves `attachments/<note_id>/<filename>` to the trash through `trash`,
/// unless another note names it or the scan could not read every note of the vault (`rows`, the
/// tier's). A file already gone is deleted.
pub fn delete(
    open: &OpenVault,
    rows: &RowOwner,
    note_id: &str,
    filename: &str,
    trash: &dyn Fn(&Path) -> Result<(), String>,
) -> Result<DeletedAttachment, AttachmentError> {
    delete_with(open, rows, note_id, filename, &mut |_| {}, trash)
}

/// Test hook: [`delete`] with `before_recheck` run with the file right before the last check of
/// the note's folder, so a test can swap a link in there.
#[cfg(feature = "test-hooks")]
#[doc(hidden)]
pub fn delete_checked(
    open: &OpenVault,
    rows: &RowOwner,
    note_id: &str,
    filename: &str,
    before_recheck: &mut dyn FnMut(&Path),
    trash: &dyn Fn(&Path) -> Result<(), String>,
) -> Result<DeletedAttachment, AttachmentError> {
    delete_with(open, rows, note_id, filename, before_recheck, trash)
}

fn delete_with(
    open: &OpenVault,
    rows: &RowOwner,
    note_id: &str,
    filename: &str,
    before_recheck: &mut dyn FnMut(&Path),
    trash: &dyn Fn(&Path) -> Result<(), String>,
) -> Result<DeletedAttachment, AttachmentError> {
    writable_note(open, note_id)?;
    if !is_note_id(note_id) {
        return Err(AttachmentError::InvalidNote);
    }
    if !is_plain_segment(filename) {
        return Err(AttachmentError::BadReference);
    }
    match plain_folder(&open.path, note_id) {
        Err(AttachmentError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(GONE);
        }
        other => other?,
    }
    let path = open.path.join(ATTACHMENTS_DIR).join(note_id).join(filename);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(GONE),
        Err(error) => return Err(error.into()),
        // A link, even to a sibling, or a folder is not the file.
        Ok(meta) if !meta.is_file() => return Err(AttachmentError::FileNotFound),
        Ok(_) => {}
    }
    let scan = find_references(open, rows, note_id, filename, Some(note_id));
    if !scan.unreferenced() {
        tracing::info!(
            scope = "attachments",
            note_id,
            references = scan.referenced_by.len(),
            incomplete = ?scan.incomplete,
            "attachment kept: another note names it, or the scan could not tell"
        );
        return Ok(DeletedAttachment {
            deleted: false,
            referenced_by: scan.referenced_by,
        });
    }
    before_recheck(&path);
    plain_folder(&open.path, note_id)?;
    trash(&path).map_err(|error| AttachmentError::Io(io::Error::other(error)))?;
    Ok(GONE)
}
