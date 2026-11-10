//! The read-only actions of a note's attachments: the listing of its folder
//! (`listNoteAttachments`, `vault/attachments.ts:603`) and where a block's `url` points
//! (`resolveAttachment`, `vault/attachment-actions.ts`), which the block menu, the attachments
//! dialog, the PDF link and the missing-file card use to reveal or open the file.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;

use super::{AttachmentError, AttachmentKind, is_note_id, kind_of, mime_type, resolve};
use crate::session::OpenVault;
use crate::shell::file_open::{Resolution, resolve_under_root};
use crate::vault::embeds::memry_file_url;
use crate::vault::layout::ATTACHMENTS_DIR;

/// One file of a note's attachments folder: `AttachmentInfo` of `vault/attachments.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    /// The stored name, `k3f9x2-report.pdf`.
    pub filename: String,
    /// The absolute `memry-file:` URL of the file on this device, which the other actions take
    /// as a block `url`. Nothing writes it into a note.
    pub path: String,
    pub size: i64,
    pub mime_type: &'static str,
    #[serde(rename = "type")]
    pub kind: AttachmentKind,
}

/// `listNoteAttachments`: the regular files of `attachments/<note_id>/`, dot files aside, in no
/// order. A note without the folder has none. Electron answered an unreadable folder with an
/// empty list; this fails, so the dialog says the list did not load. A folder that resolves out
/// of the vault is refused.
pub fn list(open: &OpenVault, note_id: &str) -> Result<Vec<AttachmentInfo>, AttachmentError> {
    if !is_note_id(note_id) {
        return Err(AttachmentError::InvalidNote);
    }
    let rel = format!("{ATTACHMENTS_DIR}/{note_id}");
    let folder = match resolve_under_root(&open.path, &rel)? {
        Resolution::Missing => return Ok(Vec::new()),
        Resolution::Outside => return Err(AttachmentError::OutsideVault),
        Resolution::Inside(folder) => folder,
    };
    let mut files = Vec::new();
    for entry in fs::read_dir(&folder)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let Ok(filename) = entry.file_name().into_string() else {
            continue;
        };
        // OS droppings (`.DS_Store` and friends) are not attachments.
        if filename.starts_with('.') {
            continue;
        }
        let size = i64::try_from(entry.metadata()?.len()).unwrap_or(i64::MAX);
        files.push(AttachmentInfo {
            path: memry_file_url(&folder.join(&filename), cfg!(windows)),
            size,
            mime_type: mime_type(&filename),
            kind: kind_of(&filename),
            filename,
        });
    }
    Ok(files)
}

/// `AttachmentResolveResult`: where a block's `url` points on this device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentLocation {
    /// The file's path, or the one it would have, inside this vault.
    pub absolute_path: String,
    /// The name on disk, `k3f9x2-report.pdf`; the healed file's when self-heal found it.
    pub stored_filename: String,
    /// False while the file is not on this device (not synced yet, or gone).
    pub exists: bool,
}

/// `resolveAttachment`: [`resolve`] for a note of the open vault. A note the vault has no row
/// for is not found, as in Electron.
pub fn locate(
    open: &OpenVault,
    note_id: &str,
    url: &str,
) -> Result<AttachmentLocation, AttachmentError> {
    let note_path = open
        .vault
        .note_files()
        .by_id(note_id)?
        .map(|row| row.path)
        .ok_or_else(|| AttachmentError::NoteNotFound(note_id.to_owned()))?;
    let resolved = resolve(&open.path, note_id, &note_path, url)?;
    let stored_filename = resolved
        .rel
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_owned();
    let exists = resolved.path.is_some();
    let path = resolved
        .path
        .unwrap_or_else(|| open.path.join(&resolved.rel));
    Ok(AttachmentLocation {
        absolute_path: path.to_string_lossy().into_owned(),
        stored_filename,
        exists,
    })
}

/// The file a block's `url` names, for the OS to reveal or open: `FileNotFound` while it is not
/// on this device, as `revealAttachmentInFinder` and `openAttachmentExternal` answer.
pub fn existing(open: &OpenVault, note_id: &str, url: &str) -> Result<PathBuf, AttachmentError> {
    let location = locate(open, note_id, url)?;
    if !location.exists {
        return Err(AttachmentError::FileNotFound);
    }
    Ok(PathBuf::from(location.absolute_path))
}
