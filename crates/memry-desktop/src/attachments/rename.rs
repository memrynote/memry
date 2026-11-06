//! Renaming an attachment from its block menu (#1714): port of `vault/attachment-rename.ts`.
//!
//! A stored name is `<6 of 0-9a-z>-<name><.ext>` in `attachments/<noteId>/`. A rename keeps the
//! prefix, which self-heal and the rename reconcile of other devices key on, and the extension,
//! which the block's mime type follows; only the middle changes. The disk moves first and the
//! renderer writes the block's `url` and `name` after: a crash in between leaves the body on the
//! old name, which self-heal finds again by the prefix.
//!
//! Only a regular file of the note's own folder is renamed, and never through a link: neither
//! `attachments/` nor `attachments/<noteId>/` may be one, even to a folder of the vault, checked
//! again right before the rename. The name kept is the one on disk, not the url's spelling. A
//! stale url renames only a file that self-heal found by the url's prefix. The rename never
//! replaces a file, so a name taken meanwhile walks on to the next suffix.

use std::fs::{self, File};
use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use super::{AttachmentError, extension, fit_name, relative_ref, resolve, writable_note};
use crate::session::OpenVault;
use crate::shell::file_open::file_identity;
use crate::shell::local_scheme::{STORED_PREFIX_LEN, attachment_parts, has_stored_prefix};
use crate::vault::fs_atomic::{RETRY_DELAYS_MS, rename_no_replace, sync_dir, with_transient_retry};
use crate::vault::layout::ATTACHMENTS_DIR;
use crate::vault::paths::is_js_space;

/// The longest name a rename takes, in UTF-16 units (`AttachmentRenameSchema`'s `max(200)`).
pub const MAX_NAME_CHARS: usize = 200;

/// `-2` to `-99` after the name itself (`MAX_COLLISION_ATTEMPTS`).
const MAX_COLLISION_ATTEMPTS: usize = 100;

/// `AttachmentRenameResult` of `@memry/rpc/notes`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenamedAttachment {
    /// The new name on disk, `k3f9x2-invoice.pdf`.
    pub stored_filename: String,
    /// The block's new `url`, relative to the note's file.
    pub url: String,
    /// The block's new `name`: what was typed, with the extension when it was left off.
    pub name: String,
}

/// `renameAttachment`: renames the file the block's `url` names (self-healed like every block
/// action) to `new_name`, and answers the block's new `url` and `name`.
pub fn rename(
    open: &OpenVault,
    note_id: &str,
    url: &str,
    new_name: &str,
) -> Result<RenamedAttachment, AttachmentError> {
    rename_with(open, note_id, url, new_name, &mut |_| {})
}

/// Test hook: [`rename`] with `before_recheck` run with each target right before the last check
/// of the note's folder, so a test can swap a link in there or put a file at the target.
#[cfg(feature = "test-hooks")]
#[doc(hidden)]
pub fn rename_checked(
    open: &OpenVault,
    note_id: &str,
    url: &str,
    new_name: &str,
    before_recheck: &mut dyn FnMut(&Path),
) -> Result<RenamedAttachment, AttachmentError> {
    rename_with(open, note_id, url, new_name, before_recheck)
}

fn rename_with(
    open: &OpenVault,
    note_id: &str,
    url: &str,
    new_name: &str,
    before_recheck: &mut dyn FnMut(&Path),
) -> Result<RenamedAttachment, AttachmentError> {
    let note_path = writable_note(open, note_id)?;
    let requested = new_name.trim_matches(is_js_space);
    if requested.is_empty() || new_name.encode_utf16().count() > MAX_NAME_CHARS {
        return Err(AttachmentError::BadName);
    }
    let note_path = note_path.ok_or_else(|| AttachmentError::NoteNotFound(note_id.to_owned()))?;
    let resolved = resolve(&open.path, note_id, &note_path, url)?;
    let Some(target) = resolved.path.as_deref() else {
        return Err(AttachmentError::FileNotFound);
    };
    // Only this note's files: another note's, or one out of the folder, has references this note
    // cannot rewrite.
    let file = match attachment_parts(&resolved.rel) {
        Some((owner, file)) if owner == note_id => file,
        _ => return Err(AttachmentError::NotOwned),
    };
    if resolved.rel != resolved.named && !kept_prefix(&resolved.named, file) {
        return Err(AttachmentError::FileNotFound);
    }
    plain_folder(&open.path, note_id)?;
    let folder = open.path.join(ATTACHMENTS_DIR).join(note_id);
    let current = entry_name(&folder, target, file)?;
    let from = folder.join(&current);
    let candidate = renamed_filename(&current, requested);
    // The name it has already: the file holding it is this one, so no suffix.
    let stored = if candidate == current {
        candidate
    } else {
        move_to_free_name(&open.path, note_id, &from, &candidate, before_recheck)?
    };
    Ok(RenamedAttachment {
        url: relative_ref(&note_path, &format!("{ATTACHMENTS_DIR}/{note_id}/{stored}")),
        name: display_name(&stored, requested),
        stored_filename: stored,
    })
}

/// Whether self-heal found the file `healed` by the prefix of the file the url `named`. Found by the name's
/// end only, it may be another block's file whose own download is pending; renaming it would
/// take that block's bytes, so a write refuses it.
fn kept_prefix(named: &str, healed: &str) -> bool {
    let wanted = attachment_parts(named).map_or("", |(_, file)| file);
    has_stored_prefix(wanted) && healed.starts_with(&wanted[..STORED_PREFIX_LEN])
}

/// `Ok` when `attachments/` and `attachments/<note_id>/` are folders of the vault itself, not
/// links (a junction on Windows) to anywhere, the vault included.
fn plain_folder(vault: &Path, note_id: &str) -> Result<(), AttachmentError> {
    let root = vault.join(ATTACHMENTS_DIR);
    for dir in [root.join(note_id), root] {
        let kind = fs::symlink_metadata(&dir)?.file_type();
        if kind.is_symlink() || !kind.is_dir() {
            return Err(AttachmentError::NotAFolder);
        }
    }
    Ok(())
}

/// The name the file at `target` has in `folder`. The url's `named` may spell it otherwise: in
/// another case on a volume that ignores case, or with a trailing dot Windows drops. The name
/// on disk carries the prefix and extension the rename keeps. A link is never the file.
fn entry_name(folder: &Path, target: &Path, named: &str) -> Result<String, AttachmentError> {
    let mut files = Vec::new();
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name == named {
            files = vec![name];
            break;
        }
        files.push(name);
    }
    let found = match files.as_slice() {
        [only] if only == named => Some(only.clone()),
        _ => {
            let wanted = file_identity(&File::open(target)?)?.0;
            files.into_iter().find(|name| {
                File::open(folder.join(name))
                    .and_then(|file| file_identity(&file))
                    .is_ok_and(|(id, _)| id == wanted)
            })
        }
    };
    found
        .filter(|name| is_plain_segment(name))
        .ok_or(AttachmentError::FileNotFound)
}

/// `isPlainSegment`, and no trailing dot or space, which Windows drops.
fn is_plain_segment(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\'])
        && !matches!(name, "." | "..")
        && !name.ends_with(['.', ' '])
}

/// `buildRenamedFilename`: the current prefix and extension around the typed name, an extension
/// typed along with it (in any case) dropped.
fn renamed_filename(current: &str, requested: &str) -> String {
    let ext = extension(current);
    let lead = if has_stored_prefix(current) {
        &current[..STORED_PREFIX_LEN]
    } else {
        ""
    };
    let stem = strip_ext(requested, ext).unwrap_or(requested);
    fit_name(lead, stem, ext)
}

/// `name` without a trailing `.<ext>` in any ASCII case, when it has one.
fn strip_ext<'a>(name: &'a str, ext: &str) -> Option<&'a str> {
    if ext.is_empty() {
        return None;
    }
    let cut = name.len().checked_sub(ext.len() + 1)?;
    let tail = name.get(cut..)?;
    (tail.starts_with('.') && tail[1..].eq_ignore_ascii_case(ext)).then(|| &name[..cut])
}

/// `displayNameFor`: what was typed, with the stored extension when it was left off.
fn display_name(stored: &str, requested: &str) -> String {
    let ext = extension(stored);
    if ext.is_empty() || strip_ext(requested, ext).is_some() {
        requested.to_owned()
    } else {
        format!("{requested}.{ext}")
    }
}

/// Renames `from` to `candidate`, or to `<name>-2<.ext>`... when a file holds that name, and
/// answers the name taken. The folders are checked again for a link right before each rename, and the rename never replaces a file (`resolveCollision` looked first and could).
fn move_to_free_name(
    vault: &Path,
    note_id: &str,
    from: &Path,
    candidate: &str,
    before_recheck: &mut dyn FnMut(&Path),
) -> Result<String, AttachmentError> {
    let folder = from.parent().unwrap_or(vault);
    let ext = extension(candidate);
    let base = strip_ext(candidate, ext).unwrap_or(candidate);
    let dot_ext = if ext.is_empty() {
        String::new()
    } else {
        format!(".{ext}")
    };
    let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
    let names = std::iter::once(candidate.to_owned())
        .chain((2..MAX_COLLISION_ATTEMPTS).map(|n| format!("{base}-{n}{dot_ext}")));
    for name in names {
        let to = folder.join(&name);
        let moved = with_transient_retry(&delays, || {
            before_recheck(&to);
            plain_folder(vault, note_id).map_err(|error| match error {
                AttachmentError::Io(error) => error,
                other => std::io::Error::other(other.to_string()),
            })?;
            rename_no_replace(from, &to)
        });
        match moved {
            Ok(()) => {
                sync_dir(folder);
                tracing::info!(scope = "attachments", "attachment renamed");
                return Ok(name);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(AttachmentError::NoFreeName)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `attachment-rename.test.ts`'s `buildRenamedFilename` cases.
    #[test]
    fn keeps_the_prefix_and_the_extension_and_shapes_the_name() {
        for (current, requested, expected) in [
            (
                "k3f9x2-scan_0031.pdf",
                "Invoice March",
                "k3f9x2-Invoice-March.pdf",
            ),
            ("k3f9x2-scan.pdf", "invoice.pdf", "k3f9x2-invoice.pdf"),
            ("k3f9x2-scan.pdf", "invoice.PDF", "k3f9x2-invoice.pdf"),
            (
                "k3f9x2-a.png",
                "holiday (2) {draft}",
                "k3f9x2-holiday-2-draft.png",
            ),
            ("k3f9x2-a.png", "...", "k3f9x2-untitled.png"),
            ("k3f9x2-a.png", "( )", "k3f9x2-file.png"),
            ("report.pdf", "invoice", "invoice.pdf"),
            ("k3f9x2-a.png", "../../etc/passwd", "k3f9x2-etcpasswd.png"),
            ("k3f9x2-noext", "new name", "k3f9x2-new-name"),
        ] {
            assert_eq!(
                renamed_filename(current, requested),
                expected,
                "{requested:?}"
            );
        }
    }

    #[test]
    fn the_display_name_keeps_what_was_typed_and_the_extension() {
        assert_eq!(display_name("k3f9x2-Invoice.pdf", "Invoice"), "Invoice.pdf");
        assert_eq!(
            display_name("k3f9x2-invoice.pdf", "invoice.PDF"),
            "invoice.PDF"
        );
        assert_eq!(display_name("k3f9x2-noext", "a b"), "a b");
        assert_eq!(display_name("k3f9x2-x.pdf", "é"), "é.pdf");
    }
}
