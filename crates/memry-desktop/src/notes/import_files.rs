//! Files copied into the vault from outside it (`notes:import-files`, `importFiles` of
//! `vault/notes-crud.ts`; Step 32h1, #3549): a drop on the sidebar, or the files the import
//! dialog picked. Which files may be read is [`ImportGrants::admit`]'s to decide; this copies
//! the ones it admitted.
//!
//! - The folder is the one named, vault-relative, else the vault's default note folder
//!   (`getDefaultNoteDir`). One outside the vault, or a locked one (`assertFolderWritable`),
//!   refuses the call before anything is copied. Electron joined the name to the vault path
//!   unchecked.
//! - Each file keeps its name, or takes the first free `<name> (n)<ext>` (Node's
//!   `path.extname`). A name is taken by any entry there, a dangling link included, and by a
//!   file that appears there while the copy is placed: the copy never replaces one
//!   ([`copy_imported_file`]). Electron's `fs.access` let a dangling link through, and its
//!   copy replaced such a file. After [`MAX_CANDIDATES`] taken names the file fails.
//! - With `plain_checklists` a markdown file's checkbox lines are marked plain
//!   ([`copy_imported_file`]).
//! - A file that cannot be copied fails alone: its message joins the result's errors and the
//!   activity log takes it as a failed drop copy (`recordDropCopyFailure`).
//!
//! Nothing here touches a note row: the watcher finds each file as it finds any file added to
//! the vault, and indexes it.
//!
//! [`ImportGrants::admit`]: crate::import::source_paths::ImportGrants::admit

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::error::NotesError;
use super::folders::vault_folder;
use super::moves::disk_spelling;
use super::service::NotesService;
use crate::import::source_paths::ImportSource;
use crate::locks::Locks;
use crate::session::OpenVault;
use crate::vault::activity::{ActivityInput, ActivityKind, ActivitySource};
use crate::vault::config::read_vault_config;
use crate::vault::file_types::{FileType, extension, file_type_of_extension};
use crate::vault::import_copy::copy_imported_file;
use crate::vault::note_file::NoteFileError;

/// The taken names tried for one file before it fails.
pub const MAX_CANDIDATES: usize = 10_000;

/// `PlainChecklistsOptionSchema`.
#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlainChecklistsOption {
    #[serde(default)]
    pub plain_checklists: Option<bool>,
}

/// `ImportFilesSchema`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportFilesInput {
    pub source_paths: Vec<String>,
    #[serde(default)]
    pub target_folder: Option<String>,
    #[serde(default)]
    pub options: Option<PlainChecklistsOption>,
}

/// `ImportedFileInfo`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFileInfo {
    /// Absolute, as Electron's `path.join(targetDir, destFilename)`.
    pub dest_path: String,
    /// The name the file had where it came from.
    pub filename: String,
    pub file_type: FileType,
}

/// `ImportFilesResult`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportFilesResult {
    pub success: bool,
    pub imported: u32,
    pub failed: u32,
    pub errors: Vec<String>,
    pub imported_files: Vec<ImportedFileInfo>,
}

impl NotesService {
    /// Copies `sources` into `target_folder` (module doc).
    pub fn import_files(
        &self,
        open: &OpenVault,
        sources: Vec<ImportSource>,
        target_folder: Option<&str>,
        plain_checklists: bool,
    ) -> Result<ImportFilesResult, NotesError> {
        let root = open.path.as_path();
        let folder = match target_folder.filter(|folder| !folder.is_empty()) {
            Some(folder) => vault_folder(root, folder)?,
            None => vault_folder(root, &read_vault_config(root).default_note_folder)?,
        };
        Locks::of(open).refuse_folder(&disk_spelling(root, &folder))?;
        let activity = self.tier.activity();
        let mut result = ImportFilesResult {
            success: true,
            imported: 0,
            failed: 0,
            errors: Vec::new(),
            imported_files: Vec::new(),
        };
        for source in sources {
            match copy_one(root, &folder, &source, plain_checklists) {
                Ok(rel) => {
                    result.imported += 1;
                    result.imported_files.push(ImportedFileInfo {
                        dest_path: on_disk(root, &rel).to_string_lossy().into_owned(),
                        file_type: file_type_of_extension(&extension(&rel))
                            .unwrap_or(FileType::Markdown),
                        filename: source.name,
                    });
                }
                Err(message) => {
                    result.failed += 1;
                    result.success = false;
                    tracing::warn!(scope = "import", "a file could not be imported: {message}");
                    result
                        .errors
                        .push(format!("Failed to import {}: {message}", source.name));
                    activity.record(
                        root,
                        ActivityInput::new(ActivityKind::Failed, ActivitySource::Drop)
                            .path(source.name)
                            .reason("copy-failed")
                            .message(message),
                    );
                }
            }
        }
        Ok(result)
    }
}

/// Copies one file to the first free name in `folder`; its vault-relative path, or the message
/// of why it failed.
fn copy_one(
    root: &Path,
    folder: &str,
    source: &ImportSource,
    plain_checklists: bool,
) -> Result<String, String> {
    let real = source.resolved.as_ref()?;
    if source.name.is_empty() {
        return Err("the path names no file".to_owned());
    }
    let (stem, ext) = split_extension(&source.name);
    for counter in 0..MAX_CANDIDATES {
        let name = match counter {
            0 => source.name.clone(),
            n => format!("{stem} ({n}){ext}"),
        };
        let rel = match folder {
            "" => name,
            folder => format!("{folder}/{name}"),
        };
        if on_disk(root, &rel).symlink_metadata().is_ok() {
            continue;
        }
        match copy_imported_file(root, real, &rel, plain_checklists) {
            Ok(()) => return Ok(rel),
            Err(NoteFileError::AlreadyExists) => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err(format!("{MAX_CANDIDATES} names were taken"))
}

/// Node's `path.basename(name, path.extname(name))` and `path.extname(name)`: the extension is
/// from the last dot, unless that dot starts the name or the name is `..`.
fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(dot) if dot > 0 && name != ".." => name.split_at(dot),
        _ => (name, ""),
    }
}

fn on_disk(root: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

#[cfg(test)]
mod tests {
    use super::split_extension;

    /// Each pair is what Node's `path.basename(s, path.extname(s))` and `path.extname(s)` give.
    #[test]
    fn the_extension_splits_as_nodes_path_does() {
        for (name, stem, ext) in [
            ("a.b.c", "a.b", ".c"),
            ("a.", "a", "."),
            ("a..", "a.", "."),
            (".b", ".b", ""),
            (".a.b", ".a", ".b"),
            ("..a", ".", ".a"),
            ("..", "..", ""),
            ("...", "..", "."),
            ("plain", "plain", ""),
        ] {
            assert_eq!(split_extension(name), (stem, ext), "{name}");
        }
    }
}
