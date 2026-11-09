//! Making an attachment rename land on this device's disk (#1714): port of
//! `reconcileRenamedAttachments` and `planAttachmentRenames` (`vault/attachment-rename-reconcile.ts`).
//!
//! A rename travels as a body change: the block's `url` names another file of the same
//! `attachments/<noteId>/` folder with the same `<6>-` prefix. The bytes are not uploaded again,
//! so a device that takes the body still holds the file under the old name. Self-heal keeps the
//! embed working, but the file would keep the name the user renamed away from. The write-back
//! pass calls [`reconcile_renames`] after it wrote a note's file: a name that left the body and
//! the one name that arrived with its prefix are that rename, and nothing else makes that pair.
//!
//! It is not a pass that makes the folder match the body. A file renamed outside the app has no
//! body change, so it keeps its name and is served through self-heal. Electron's other half,
//! `reconcileDownloadedAttachmentName`, runs when sync downloads a file (Step 18).
//!
//! Nothing here may lose a file or a reference:
//! - The move is `rename_no_replace`: a file at the new name stays, and so does the old one.
//! - Only a regular file moves, between two stored names the app could have made (a plain name
//!   with the prefix, the same extension, no control or hidden character), inside
//!   `attachments/<noteId>/` with no link on that path, checked again right before each move.
//! - A locked note's files never move: a lock protects them by name (`locks::reconcile`), and
//!   self-heal serves the old name under the new ref.
//! - It never fails the pass. The note's file is written when it runs; a failure is logged.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use memry_core::api::vault::Vault;

use super::references::filenames;
use super::rename::plain_folder;
use super::{
    AttachmentError, MAX_STORED_NAME_BYTES, extension, is_invisible_format, is_note_id,
    is_plain_segment, writable_in,
};
use crate::shell::local_scheme::{STORED_PREFIX_LEN, has_stored_prefix};
use crate::vault::fs_atomic::{rename_no_replace, sync_dir};
use crate::vault::layout::ATTACHMENTS_DIR;

const SCOPE: &str = "attachments";

/// One move a body change asks for, by stored name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedRename {
    pub from: String,
    pub to: String,
}

/// Whether `name` is one the app could have stored: a plain name with the `<6>-` prefix, within
/// [`MAX_STORED_NAME_BYTES`], and no character a stored name never holds.
fn is_stored_name(name: &str) -> bool {
    is_plain_segment(name)
        && has_stored_prefix(name)
        && name.len() <= MAX_STORED_NAME_BYTES
        && !name
            .chars()
            .any(|c| c.is_control() || is_invisible_format(c) || "<>:\"|?*".contains(c))
}

/// `planAttachmentRenames`: for each stored name that left, the one that arrived with its
/// prefix, when exactly one left and one arrived with it. Two files renamed in one change pair
/// up (their prefixes differ); an ambiguous prefix is left alone. A pair whose extension
/// changed is not a rename the app makes and is left alone too.
pub fn plan_renames(previous: &BTreeSet<String>, next: &BTreeSet<String>) -> Vec<PlannedRename> {
    let left: Vec<&String> = previous
        .iter()
        .filter(|name| !next.contains(*name) && is_stored_name(name))
        .collect();
    let arrived: Vec<&String> = next
        .iter()
        .filter(|name| !previous.contains(*name) && is_stored_name(name))
        .collect();
    let prefix = |name: &str| name[..STORED_PREFIX_LEN].to_owned();
    let mut plans = Vec::new();
    for from in &left {
        let p = prefix(from);
        let candidates: Vec<&&String> = arrived.iter().filter(|n| n.starts_with(&p)).collect();
        let sources = left.iter().filter(|n| n.starts_with(&p)).count();
        if let ([to], 1) = (candidates.as_slice(), sources)
            && extension(from).eq_ignore_ascii_case(extension(to))
        {
            plans.push(PlannedRename {
                from: (*from).clone(),
                to: (**to).clone(),
            });
        }
    }
    plans
}

/// `reconcileRenamedAttachments`: applies on this device the renames that writing `next` over
/// `previous` (the note's file before and after a write-back) asks for in the note's
/// attachments folder of the vault at `root`. Answers the moves made. A move whose file is
/// gone (this device made the rename) or whose name is taken is skipped, so it runs again
/// harmlessly.
pub fn reconcile_renames(
    root: &Path,
    vault: &Vault,
    note_id: &str,
    previous: &str,
    next: &str,
) -> Vec<PlannedRename> {
    if !is_note_id(note_id) {
        return Vec::new();
    }
    let plans = plan_renames(&filenames(note_id, previous), &filenames(note_id, next));
    if plans.is_empty() {
        return plans;
    }
    if let Err(error) = writable_in(vault, note_id) {
        tracing::info!(
            scope = SCOPE,
            note_id,
            "synced attachment renames left to self-heal: {error}"
        );
        return Vec::new();
    }
    let folder = root.join(ATTACHMENTS_DIR).join(note_id);
    let mut applied = Vec::new();
    for plan in plans {
        match apply(root, note_id, &folder, &plan) {
            Ok(true) => applied.push(plan),
            Ok(false) => {}
            Err(error) => tracing::warn!(
                scope = SCOPE,
                note_id,
                "a synced attachment rename was not applied: {error}"
            ),
        }
    }
    if !applied.is_empty() {
        sync_dir(&folder);
        tracing::info!(
            scope = SCOPE,
            note_id,
            count = applied.len(),
            "applied synced attachment renames"
        );
    }
    applied
}

/// Moves one file; `Ok(false)` when there is nothing to move or the new name is taken.
fn apply(
    root: &Path,
    note_id: &str,
    folder: &Path,
    plan: &PlannedRename,
) -> Result<bool, AttachmentError> {
    match plain_folder(root, note_id) {
        Err(AttachmentError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(false);
        }
        other => other?,
    }
    let from = folder.join(&plan.from);
    match fs::symlink_metadata(&from) {
        Ok(meta) if meta.is_file() => {}
        // Gone (renamed here already, or never downloaded), or a link or folder: not the file.
        Ok(_) => return Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    }
    plain_folder(root, note_id)?;
    match rename_no_replace(&from, &folder.join(&plan.to)) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error.into()),
    }
}
