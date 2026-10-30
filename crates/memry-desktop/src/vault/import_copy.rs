//! Copies a file into the vault for an import (`copyImportedFile`,
//! `apps/desktop/src/main/vault/import-copy.ts`).
//!
//! With `plain_checklists`, a markdown file's checkbox lines are written with the plain marker
//! (`{check}`, [`mark_added_checklist_lines_plain`]), so the editor keeps them as checkboxes and
//! does not turn them into tasks. A file whose bytes are not UTF-8 would not survive that
//! rewrite, so it is copied as it is, and so is a file the marking leaves unchanged.
//!
//! The copy never replaces anything at `dest`: a file there, found when the copy is placed or
//! created by someone else meanwhile, fails it with `AlreadyExists`, and the caller picks the
//! next name (`importFiles`' `<name> (n)<ext>`). Electron's `fs.copyFile` and `fs.writeFile`
//! replaced such a file. A copy is streamed, never read into memory; only a markdown file read
//! for the marking is.

use std::fs;
use std::path::Path;

use memry_core::markdown::shared::checklist_plain::mark_added_checklist_lines_plain;

use super::file_types::{FileType, extension, file_type_of_extension};
use super::fs_atomic::{WriteError, atomic_create, copy_create};

pub fn copy_imported_file(
    source: &Path,
    dest: &Path,
    plain_checklists: bool,
) -> Result<(), WriteError> {
    let markdown =
        file_type_of_extension(&extension(&source.to_string_lossy())) == Some(FileType::Markdown);
    if plain_checklists && markdown {
        let bytes = fs::read(source).map_err(|source| WriteError {
            path: dest.to_path_buf(),
            source,
        })?;
        if let Ok(text) = std::str::from_utf8(&bytes) {
            let marked = mark_added_checklist_lines_plain(text, "");
            if marked != text {
                return atomic_create(dest, marked.as_bytes());
            }
        }
    }
    copy_create(source, dest)
}
