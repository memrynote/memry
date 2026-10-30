//! Copies a file into the vault for an import (`copyImportedFile`,
//! `apps/desktop/src/main/vault/import-copy.ts`).
//!
//! With `plain_checklists`, a markdown file's checkbox lines are written with the plain marker
//! (`{check}`, [`mark_added_checklist_lines_plain`]), so the editor keeps them as checkboxes and
//! does not turn them into tasks. A file whose bytes are not UTF-8 would not survive that
//! rewrite, so it is copied as it is, and so is a file the marking leaves unchanged.
//!
//! The source is outside the vault and may be anything, so it is read once, bounded:
//! - Only a regular file is copied. A pipe would block the read for ever, and a link to
//!   `/dev/zero` would fill the disk; both are refused, and so is a Windows device or pipe. On
//!   Unix the source opens without blocking, so a pipe is refused instead of waited on.
//! - Every read stops at the size the file had when it was opened. A file that grows meanwhile,
//!   or one that holds more than its size says (a procfs file, an endless FUSE file), is cut
//!   there.
//! - Only a markdown file up to [`MAX_NOTE_BYTES`] is read into memory to be marked. A larger
//!   one is copied as it is, unmarked, and logged; Electron read it whole and failed. So is one
//!   whose marking would take it past that size, which the app could then not read as a note.
//!   Every other copy streams.
//!
//! The copy never replaces anything at `dest_rel`. A file there, whether found when the copy is
//! placed or created by someone else meanwhile, fails it with [`NoteFileError::AlreadyExists`],
//! and the caller picks the next name (`importFiles`' `<name> (n)<ext>`). Electron's
//! `fs.copyFile` and `fs.writeFile` replaced such a file. A `dest_rel` that leaves the vault,
//! through `..` or a linked folder, is refused before and again right before the copy is placed.
//! The copy keeps the source's mode on Unix, the marked one included.

use std::fs;
use std::io::Read;
use std::path::Path;

use memry_core::markdown::shared::checklist_plain::mark_added_checklist_lines_plain;

use super::file_types::{FileType, extension, file_type_of_extension};
use super::fs_atomic::atomic_create_streamed;
use super::note_file::{MAX_NOTE_BYTES, NoteFileError, still_contained, target};
use crate::shell::file_open::OpenError;

const SCOPE: &str = "import_copy";

/// Copies `source` to `dest_rel` in the vault at `vault` (module doc).
pub fn copy_imported_file(
    vault: &Path,
    source: &Path,
    dest_rel: &str,
    plain_checklists: bool,
) -> Result<(), NoteFileError> {
    let (dest, aimed_at) = target(vault, dest_rel)?;
    let (file, meta) = open_regular(source)?;
    let (size, mode) = (meta.len(), meta.permissions());
    let mut file = file.take(size);
    let place = move |content: &mut dyn Read| {
        let mut between = || {};
        let mut contained = still_contained(vault, dest_rel, &dest, aimed_at, &mut between);
        atomic_create_streamed(&dest, content, mode, &mut contained).map_err(|error| {
            if error.already_exists() {
                NoteFileError::AlreadyExists
            } else {
                error.into()
            }
        })
    };
    let markdown =
        file_type_of_extension(&extension(&source.to_string_lossy())) == Some(FileType::Markdown);
    if !plain_checklists || !markdown {
        return place(&mut file);
    }
    if size > MAX_NOTE_BYTES {
        tracing::warn!(
            scope = SCOPE,
            "an imported markdown file is too large to mark its checklists; copied as it is"
        );
        return place(&mut file);
    }
    let mut bytes = Vec::with_capacity(size as usize);
    file.read_to_end(&mut bytes)?;
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return place(&mut bytes.as_slice());
    };
    let marked = mark_added_checklist_lines_plain(text, "");
    if marked.len() as u64 > MAX_NOTE_BYTES {
        tracing::warn!(
            scope = SCOPE,
            "marking an imported file's checklists would make it too large to read; copied as it is"
        );
        return place(&mut bytes.as_slice());
    }
    place(&mut marked.as_bytes())
}

/// The source, opened once for every read of it, and only when it is a regular file. On Unix
/// it opens without blocking, so a pipe with no writer is seen and refused rather than waited
/// on, and a terminal never becomes the app's; a link is judged by what it points at. On
/// Windows the handle must be a disk file's: a pipe or a device (`NUL`, `CON`) may pass for
/// one in its metadata.
fn open_regular(source: &Path) -> Result<(fs::File, fs::Metadata), NoteFileError> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY);
    }
    let file = options.open(source)?;
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{FILE_TYPE_DISK, GetFileType};
        // SAFETY: the handle is open for the duration of the call.
        if unsafe { GetFileType(HANDLE(file.as_raw_handle())) } != FILE_TYPE_DISK {
            return Err(OpenError::NotRegular.into());
        }
    }
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(OpenError::NotRegular.into());
    }
    Ok((file, meta))
}
