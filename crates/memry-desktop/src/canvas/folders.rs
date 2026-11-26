//! Canvas folders: the directory half of Electron's `canvas/folder-store.ts` on
//! [`memry_core::domain::canvas::folders`], which owns the records. A folder is a real directory
//! under `<vault>/canvases`.
//!
//! Create makes the directory first. A rename or move refuses a destination that exists on disk
//! and a canvas or folder it would carry past the depth cap, then moves the directory, and moves it back when the record write fails, so disk and records never
//! disagree about where a canvas is; the canvases' `canvas_files` rows follow in the same writer
//! call. Delete deletes the records first, then sends the directory to the OS trash, and never
//! removes it any other way: it can hold anything the user put there.

use std::fs;
use std::path::PathBuf;

use memry_core::api::errors::StorageError;
use memry_core::domain::canvas::folder_paths::{
    CanvasFolderError, canvas_path_key, folder_segments, is_descendant_folder, join_folder,
    parent_folder, rewrite_folder_prefix,
};
use memry_core::domain::canvas::folders::{self, FolderWriteError};
use memry_core::domain::canvas::{self, edges};
use memry_core::domain::canvas_folder::{self, CanvasFolder};
use rusqlite::Connection;
use serde::Serialize;

use super::files;
use super::scene_file::{portable_canvas_folder, resolve_canvas_file};
use super::service::{CanvasService, stored_folder};
use crate::vault::layout::CANVAS_DIR;

/// `CanvasFolder`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CanvasFolderView {
    pub id: String,
    pub path: String,
    pub icon: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<CanvasFolder> for CanvasFolderView {
    fn from(folder: CanvasFolder) -> Self {
        Self {
            id: folder.id,
            path: folder.path,
            icon: folder.icon,
            created_at: folder.created_at,
            updated_at: folder.updated_at,
        }
    }
}

/// Why a folder write did not happen. No message names a path.
#[derive(Debug, thiserror::Error)]
pub enum FolderError {
    #[error(transparent)]
    Refused(#[from] CanvasFolderError),
    /// The directory could not be moved or made (locked, gone, permissions).
    #[error("the canvas folder could not be moved ({0:?})")]
    MoveFailed(std::io::ErrorKind),
    #[error(transparent)]
    Storage(#[from] StorageError),
}

impl From<FolderWriteError> for FolderError {
    fn from(error: FolderWriteError) -> Self {
        match error {
            FolderWriteError::Refused(refused) => Self::Refused(refused),
            FolderWriteError::Storage(storage) => Self::Storage(storage),
        }
    }
}

impl FolderError {
    /// `CanvasFolderErrorCode` and its `errors:canvasFolder.*` key, for a refusal the user can
    /// act on; `None` for a storage failure.
    pub fn refusal(&self) -> Option<(&'static str, &'static str)> {
        match self {
            Self::Refused(refused) => Some((refused.code(), message_key(*refused))),
            Self::MoveFailed(_) => Some((
                "CANVAS_FOLDER_MOVE_FAILED",
                "errors:canvasFolder.moveFailed",
            )),
            Self::Storage(_) => None,
        }
    }
}

fn message_key(refused: CanvasFolderError) -> &'static str {
    match refused {
        CanvasFolderError::Depth => "errors:canvasFolder.depth",
        CanvasFolderError::InvalidName | CanvasFolderError::NoSource => {
            "errors:canvasFolder.invalidName"
        }
        CanvasFolderError::Exists => "errors:canvasFolder.exists",
        CanvasFolderError::Descendant => "errors:canvasFolder.descendant",
    }
}

/// What puts a moved directory back.
enum Undo {
    /// The directory was made because the folder had none on disk.
    RemoveEmpty(PathBuf),
    MoveBack {
        from: PathBuf,
        to: PathBuf,
    },
}

impl Undo {
    fn run(self) {
        let undone = match self {
            Self::RemoveEmpty(made) => fs::remove_dir(made),
            Self::MoveBack { from, to } => to
                .parent()
                .map_or(Ok(()), fs::create_dir_all)
                .and(fs::rename(from, to)),
        };
        if let Err(error) = undone {
            tracing::error!(scope = "CanvasFolders", kind = ?error.kind(), "could not move the canvas folder back after a failed record write");
        }
    }
}

impl CanvasService {
    /// Every live folder (`listCanvasFolders`).
    pub fn list_folders(&self) -> Result<Vec<CanvasFolderView>, FolderError> {
        let found = self.canvases.db().read_blocking(canvas_folder::list)?;
        Ok(found.into_iter().map(CanvasFolderView::from).collect())
    }

    /// `createCanvasFolder`: the directory under `parent`, then its record and a record for each
    /// ancestor that has none. A live folder of that path is returned as it is.
    pub fn create_folder(
        &self,
        parent: Option<&str>,
        name: &str,
        now_ms: i64,
    ) -> Result<CanvasFolderView, FolderError> {
        self.write::<_, FolderError>(|conn| {
            let parent = stored_folder(conn, parent)?;
            let requested = join_folder(parent.as_deref(), name)?;
            let canonical =
                portable_canvas_folder(Some(&requested))?.ok_or(CanvasFolderError::InvalidName)?;
            let stored =
                canvas_folder::get(conn, &canonical)?.map_or(canonical.clone(), |f| f.path);
            fs::create_dir_all(self.folder_dir(&stored)?)
                .map_err(|error| FolderError::MoveFailed(error.kind()))?;
            let folder = folders::create(
                conn,
                self.canvases.vault_id(),
                &canonical,
                self.canvases.device_id(),
                now_ms,
            )?;
            Ok(folder.into())
        })
    }

    /// `renameCanvasFolder`: a new name under the same parent. `None` when no live folder has
    /// that path.
    pub fn rename_folder(
        &self,
        path: &str,
        name: &str,
        now_ms: i64,
    ) -> Result<Option<CanvasFolderView>, FolderError> {
        self.write::<_, FolderError>(|conn| {
            let Some(folder) = live_folder(conn, path)? else {
                return Ok(None);
            };
            let to = join_folder(parent_folder(Some(&folder.path)).as_deref(), name)?;
            self.relocate(conn, folder, &to, now_ms)
        })
    }

    /// `moveCanvasFolder`: the same name under `parent` (`None` the root).
    pub fn move_folder(
        &self,
        path: &str,
        parent: Option<&str>,
        now_ms: i64,
    ) -> Result<Option<CanvasFolderView>, FolderError> {
        self.write::<_, FolderError>(|conn| {
            let Some(folder) = live_folder(conn, path)? else {
                return Ok(None);
            };
            let leaf = folder_segments(Some(&folder.path))
                .last()
                .map(|leaf| (*leaf).to_owned())
                .unwrap_or_default();
            let parent = stored_folder(conn, parent)?;
            let to = join_folder(parent.as_deref(), &leaf)?;
            self.relocate(conn, folder, &to, now_ms)
        })
    }

    /// `relocateFolder`: refuses before the disk is touched, moves the directory, then the
    /// records and the canvases' file rows; a failed record write moves the directory back.
    fn relocate(
        &self,
        conn: &Connection,
        folder: CanvasFolder,
        to: &str,
        now_ms: i64,
    ) -> Result<Option<CanvasFolderView>, FolderError> {
        let Some(to) = portable_canvas_folder(Some(to))? else {
            return Ok(None);
        };
        if folder.path == to {
            return Ok(Some(folder.into()));
        }
        if canvas_path_key(&folder.path) != canvas_path_key(&to) {
            if is_descendant_folder(Some(&to), Some(&folder.path)) {
                return Err(CanvasFolderError::Descendant.into());
            }
            if canvas_folder::get(conn, &to)?.is_some()
                || fs::symlink_metadata(self.folder_dir(&to)?).is_ok()
            {
                return Err(CanvasFolderError::Exists.into());
            }
        }
        // Depth breaches of anything carried are refused before the disk (`folder-store.ts:430`).
        let canvases = canvas::list(conn, self.canvases.vault_id())?;
        let folders = canvas_folder::list(conn)?;
        let carried = canvases
            .iter()
            .map(|canvas| canvas.folder.as_deref())
            .chain(folders.iter().map(|folder| Some(folder.path.as_str())));
        for placed in carried {
            rewrite_folder_prefix(placed, &folder.path, &to)?;
        }
        let undo = self.move_dir(&folder.path, &to)?;
        let relocated = folders::relocate(
            conn,
            self.canvases.vault_id(),
            &folder,
            &to,
            self.canvases.device_id(),
            now_ms,
        )
        .inspect_err(|_| undo.run())?;
        for (id, folder) in &relocated.canvases {
            files::refile(conn, id, folder.as_deref())?;
        }
        Ok(Some(relocated.folder.into()))
    }

    /// Moves the folder's directory, or makes the destination when it has none on disk.
    fn move_dir(&self, from: &str, to: &str) -> Result<Undo, FolderError> {
        let (from, to) = (self.folder_dir(from)?, self.folder_dir(to)?);
        let failed = |error: std::io::Error| FolderError::MoveFailed(error.kind());
        if fs::symlink_metadata(&from).is_err() {
            tracing::warn!(
                scope = "CanvasFolders",
                "canvas folder has no directory on disk; creating the destination instead"
            );
            fs::create_dir_all(&to).map_err(failed)?;
            return Ok(Undo::RemoveEmpty(to));
        }
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(failed)?;
        }
        fs::rename(&from, &to).map_err(failed)?;
        Ok(Undo::MoveBack { from: to, to: from })
    }

    /// `setCanvasFolderIcon`: records only. `None` when no live folder has that path.
    pub fn set_folder_icon(
        &self,
        path: &str,
        icon: Option<&str>,
        now_ms: i64,
    ) -> Result<Option<CanvasFolderView>, FolderError> {
        self.write::<_, FolderError>(|conn| {
            let Some(canonical) = portable_canvas_folder(Some(path))? else {
                return Ok(None);
            };
            let folder = folders::set_icon(
                conn,
                self.canvases.vault_id(),
                &canonical,
                icon,
                self.canvases.device_id(),
                now_ms,
            )?;
            Ok(folder.map(CanvasFolderView::from))
        })
    }

    /// `deleteCanvasFolder`: deletes the folder, everything under it and every canvas inside,
    /// then sends the directory to the OS trash. Returns the deleted canvases' ids.
    pub fn delete_folder(&self, path: &str, now_ms: i64) -> Result<Vec<String>, FolderError> {
        let deleted = self.write::<_, FolderError>(|conn| {
            let Some(canonical) = stored_folder(conn, Some(path))? else {
                return Ok(None);
            };
            let ids = folders::delete(
                conn,
                self.canvases.vault_id(),
                &canonical,
                self.canvases.device_id(),
                now_ms,
            )?;
            Ok(Some((canonical, ids)))
        })?;
        let Some((canonical, ids)) = deleted else {
            return Ok(Vec::new());
        };
        self.index
            .call_blocking(|index| ids.iter().try_for_each(|id| edges::clear(index, id)))?;
        let dir = self.folder_dir(&canonical)?;
        if fs::symlink_metadata(&dir).is_ok()
            && let Err(error) = (self.trash)(&dir)
        {
            // No recursive fallback: an unrecoverable delete of whatever the user keeps there is
            // worse than a directory left behind. The records stay deleted on every device.
            tracing::warn!(scope = "CanvasFolders", %error, "could not trash a canvas folder; leaving the directory in place");
        }
        self.release_removed(&ids)?;
        Ok(ids)
    }

    fn folder_dir(&self, folder: &str) -> Result<PathBuf, FolderError> {
        resolve_canvas_file(&self.vault, &format!("{CANVAS_DIR}/{folder}"))
            .map_err(|_| FolderError::Refused(CanvasFolderError::InvalidName))
    }
}

/// The live folder a caller named, in its on-disk spelling.
fn live_folder(conn: &Connection, path: &str) -> Result<Option<CanvasFolder>, FolderError> {
    let Some(canonical) = portable_canvas_folder(Some(path))? else {
        return Ok(None);
    };
    Ok(canvas_folder::get(conn, &canonical)?)
}
