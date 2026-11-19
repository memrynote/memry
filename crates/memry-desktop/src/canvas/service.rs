//! Canvas reads and writes over one open vault: the file half of Electron's `canvas/store.ts`
//! (create, get, update, duplicate, delete) on [`memry_core::domain::canvas`], which owns the
//! record and its sync. The `.excalidraw` document is the truth for ink; the record carries
//! identity, title, placement and sync state.
//!
//! Each write runs in one writer call: it checks the record, writes the document, records the
//! document's bytes in `canvas_files` ([`super::files`]) and writes the record, so a sync apply
//! never lands in between, as Electron's transaction does.
//!
//! Departures from Electron, each so a user's drawing is never lost:
//! - a save over document bytes its reader did not get (each reader carries the sha256 it read)
//!   first files the on-disk drawing as a new canvas, `"<title> (conflict copy)"`, or moves a
//!   document that is no longer a drawing to a file of that name; Electron overwrites both.
//! - the scene saved carries no `memryAssets` sidecar until the asset commands land (30e3).
//! - a canvas whose row names no document is found by the id inside its file, wherever it was
//!   moved, before anything is written; with no document at all its synced scene is served (and
//!   the next save writes a new document) where Electron reports it unreadable.
//! - a scene that is not a JSON object is refused, not written as an empty board.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use memry_core::api::canvas::Canvases;
use memry_core::api::errors::{AuthError, StorageError};
use memry_core::domain::canvas::file_format::{
    FileMeta, read_file_meta, strip_file_meta, with_file_meta,
};
use memry_core::domain::canvas::folder_paths::CanvasFolderError;
use memry_core::domain::canvas::folders::{self, FolderWriteError};
use memry_core::domain::canvas::{
    self, Canvas, CanvasCopy, NewCanvas, SyncHold, canonical_scene, edges,
};
use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::Db;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::files::{self, FileRow};
use super::reconcile::now_ms;
use super::scene_file::{
    CanvasDocument, Expect, ReadError, WriteError, allocate_canvas_path, folder_of_canvas_path,
    list_canvas_files, portable_canvas_folder, read_canvas_file, resolve_canvas_file,
    write_canvas_file,
};
use crate::session::OpenVault;
use crate::templates::present;
use crate::vault::layout::CANVAS_FILE_EXT;

/// Sends a file or folder to the OS trash ([`crate::vault::trash::move_to_trash`]).
pub type Trash = fn(&Path) -> Result<(), String>;

/// Why a canvas write did not happen. No message names a path: paths are title-derived.
#[derive(Debug, thiserror::Error)]
pub enum CanvasError {
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Folder(#[from] CanvasFolderError),
    #[error(transparent)]
    Write(#[from] WriteError),
    #[error(transparent)]
    Read(#[from] ReadError),
    /// The canvas's document changed on disk into something that is not a drawing and could not
    /// be moved aside, so the save is refused rather than replace it.
    #[error("the canvas document changed on disk and could not be kept aside")]
    ChangedUnreadable,
}

/// `CanvasSummary`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CanvasSummaryView {
    pub id: String,
    pub title: Option<String>,
    pub folder: Option<String>,
    pub icon: Option<String>,
    pub owner_note_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// `Canvas`: the summary and the scene without the file's sidecar. `unreadable` when the
/// document links outside the vault; its scene is then empty and never saved over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CanvasView {
    #[serde(flatten)]
    pub summary: CanvasSummaryView,
    pub scene: String,
    /// The sha256 of the document bytes this reader got, `null` when it got none. The reader
    /// sends it back as `expectedSha256`, so its save never replaces bytes it did not see.
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub unreadable: Option<bool>,
}

/// `CanvasCreateSchema`.
#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CanvasCreateInput {
    #[serde(default)]
    #[specta(optional)]
    pub title: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub scene: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub folder: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub icon: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub owner_note_id: Option<String>,
}

/// `CanvasUpdateSchema`. Absent leaves a field; `null` clears it (the root, for `folder`).
/// `entityRefs` is not read: the refs are derived from the scene.
#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CanvasUpdateInput {
    pub id: String,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub title: Option<Option<String>>,
    #[serde(default)]
    #[specta(optional)]
    pub scene: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub folder: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub icon: Option<Option<String>>,
    #[serde(default)]
    #[specta(optional)]
    pub expected_updated_at: Option<i64>,
    /// The `sha256` of the [`CanvasView`] the scene was drawn over; absent or `null` when the
    /// reader got no document. A scene saved over other bytes first keeps them as a copy.
    #[serde(default)]
    #[specta(optional)]
    pub expected_sha256: Option<String>,
}

/// A canvas written: `too_large` when it is saved here and held back from sync.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Written {
    pub canvas: CanvasView,
    pub too_large: bool,
}

/// The outcome of [`CanvasService::update`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Update {
    Saved {
        summary: CanvasSummaryView,
        too_large: bool,
        /// The sha256 of the document now on disk, the saver's next `expected_sha256`.
        sha256: Option<String>,
        /// The drawing found edited on disk, filed as a new canvas before the save.
        conflict_copy: Option<Box<Written>>,
    },
    NotFound,
    /// `expected_updated_at` no longer matches; nothing was written.
    Conflict,
}

/// Where a canvas's document is.
pub(super) enum Found {
    File {
        path: String,
        document: CanvasDocument,
    },
    /// A link out of the vault: never read, never written.
    Outside,
    None,
}

/// The canvas surface of one open vault.
pub struct CanvasService {
    pub(super) vault: PathBuf,
    pub(super) canvases: Arc<Canvases>,
    pub(super) index: Db,
    pub(super) trash: Trash,
}

impl CanvasService {
    pub fn new(vault: PathBuf, canvases: Arc<Canvases>, index: Db, trash: Trash) -> Self {
        Self {
            vault,
            canvases,
            index,
            trash,
        }
    }

    /// The canvases of `open`, written under the device identity in `store`.
    pub fn open(open: &OpenVault, store: Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        memry_core::api::auth::ensure_device_identity(store.clone())?;
        Ok(Self::new(
            open.path.clone(),
            open.vault.canvases(store)?,
            open.search.index_handle(),
            crate::vault::trash::move_to_trash,
        ))
    }

    /// Runs `f` on the writer; its own error type rides out of the storage call.
    pub(super) fn write<T, E: From<StorageError>>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, E>,
    ) -> Result<T, E> {
        self.canvases
            .db()
            .call_blocking(|conn| Ok(f(conn)))
            .unwrap_or_else(|error| Err(error.into()))
    }

    /// Every live canvas, most recently changed first (`listCanvases`).
    pub fn list(&self) -> Result<Vec<CanvasSummaryView>, CanvasError> {
        let vault_id = self.canvases.vault_id().to_owned();
        let canvases = self
            .canvases
            .db()
            .read_blocking(move |conn| canvas::list(conn, &vault_id))?;
        Ok(canvases.into_iter().map(summary).collect())
    }

    /// One live canvas with the scene of its document and the sha256 of the bytes read
    /// (`getCanvas`), settled with its record first. The read itself stamps nothing: the reader
    /// sends that sha256 back with its save.
    pub fn get(&self, id: &str) -> Result<Option<CanvasView>, CanvasError> {
        let now_ms = now_ms();
        let view = self.write::<_, CanvasError>(|conn| {
            let Some(canvas) = canvas::get(conn, id)? else {
                return Ok(None);
            };
            // An edit made on disk reaches the record before the document is served as read.
            let found = self.locate(conn, id)?;
            let settled = self.settle_in(conn, &canvas, found, now_ms)?;
            let canvas = match settled.scene_changed() {
                true => canvas::get(conn, id)?.unwrap_or(canvas),
                false => canvas,
            };
            let (scene, sha256, unreadable) = match self.locate(conn, id)? {
                Found::File { document, .. } => {
                    (strip_file_meta(&document.text), Some(document.sha256), None)
                }
                Found::Outside => {
                    tracing::warn!(
                        scope = "CanvasStore",
                        "refusing a canvas document that links outside the vault"
                    );
                    (String::new(), None, Some(true))
                }
                Found::None => (canvas.scene.clone(), None, None),
            };
            let view = CanvasView {
                summary: summary(canvas),
                scene,
                sha256,
                unreadable,
            };
            Ok(Some((view, settled.scene_changed())))
        })?;
        let Some((view, changed)) = view else {
            return Ok(None);
        };
        if changed {
            self.rewrite_edges(id, &view.scene)?;
        }
        Ok(Some(view))
    }

    /// `createCanvas`: the document at a path named for the title, then the record.
    pub fn create(&self, input: &CanvasCreateInput, now_ms: i64) -> Result<Written, CanvasError> {
        let written = self.write::<_, CanvasError>(|conn| {
            let folder = stored_folder(conn, input.folder.as_deref())?;
            self.create_in(
                conn,
                &NewCanvas {
                    title: input.title.as_deref(),
                    scene: input.scene.as_deref(),
                    folder: folder.as_deref(),
                    icon: input.icon.as_deref(),
                    owner_note_id: input.owner_note_id.as_deref(),
                    ..NewCanvas::default()
                },
                now_ms,
            )
        })?;
        self.rewrite_edges(&written.canvas.summary.id, &written.canvas.scene)?;
        Ok(written)
    }

    /// Writes a new canvas's document and record. `canvas.folder` is a stored folder; the one
    /// recorded is read back off the allocated path (`CON` lands in `CON canvas`).
    pub(super) fn create_in(
        &self,
        conn: &Connection,
        canvas: &NewCanvas<'_>,
        now_ms: i64,
    ) -> Result<Written, CanvasError> {
        let scene = canonical_scene(canvas.scene.unwrap_or(""))?;
        let id = canvas::new_id();
        let path = allocate_canvas_path(
            &self.vault,
            canvas.title,
            &HashSet::new(),
            None,
            canvas.folder,
        )?;
        let folder = folder_of_canvas_path(&path);
        let text = with_file_meta(&scene, &meta(&id, now_ms, now_ms));
        let sha256 = write_canvas_file(&self.vault, &path, &text, Expect::New)?;
        let record = NewCanvas {
            id: Some(&id),
            scene: Some(&scene),
            folder: folder.as_deref(),
            ..*canvas
        };
        let saved = canvas::create(
            conn,
            &record,
            self.canvases.vault_id(),
            self.canvases.device_id(),
            now_ms,
        )
        .inspect_err(|_| self.discard(&path, &sha256))?;
        files::put(
            conn,
            &id,
            &FileRow {
                path,
                sha256: sha256.clone(),
            },
            now_ms,
        )?;
        Ok(written(
            saved.canvas,
            strip_file_meta(&text),
            sha256,
            saved.sync,
        ))
    }

    /// Removes a document this call just wrote, when its record could not be written.
    fn discard(&self, path: &str, sha256: &str) {
        let unchanged = read_canvas_file(&self.vault, path)
            .is_ok_and(|document| document.is_some_and(|document| document.sha256 == sha256));
        if let (true, Ok(absolute)) = (unchanged, resolve_canvas_file(&self.vault, path))
            && let Err(error) = std::fs::remove_file(absolute)
        {
            tracing::warn!(scope = "CanvasStore", kind = ?error.kind(), "could not remove the document of a canvas that was not created");
        }
    }

    /// `duplicateCanvas`: a copy of the document's scene beside it, titled after the file name
    /// it gets (`Plan 2`). `None` when the canvas is gone or its document links outside.
    pub fn duplicate(&self, id: &str, now_ms: i64) -> Result<Option<Written>, CanvasError> {
        let copy = self.write::<_, CanvasError>(|conn| {
            let Some(source) = canvas::get(conn, id)? else {
                return Ok(None);
            };
            let scene = match self.locate(conn, id)? {
                Found::File { document, .. } => strip_file_meta(&document.text),
                Found::None => source.scene.clone(),
                Found::Outside => {
                    tracing::warn!(
                        scope = "CanvasStore",
                        "refusing to duplicate a canvas with no readable document"
                    );
                    return Ok(None);
                }
            };
            let scene = canonical_scene(&scene)?;
            let path = allocate_canvas_path(
                &self.vault,
                source.title.as_deref(),
                &HashSet::new(),
                None,
                source.folder.as_deref(),
            )?;
            let title = source.title.as_ref().map(|_| file_stem(&path));
            let copy_id = canvas::new_id();
            let text = with_file_meta(&scene, &meta(&copy_id, now_ms, now_ms));
            let sha256 = write_canvas_file(&self.vault, &path, &text, Expect::New)?;
            let copy = CanvasCopy {
                title: title.as_deref(),
                id: Some(&copy_id),
                scene: Some(&scene),
            };
            let saved = canvas::duplicate(
                conn,
                id,
                &copy,
                self.canvases.vault_id(),
                self.canvases.device_id(),
                now_ms,
            )
            .inspect_err(|_| self.discard(&path, &sha256))?;
            let Some(saved) = saved else {
                self.discard(&path, &sha256);
                return Ok(None);
            };
            files::put(
                conn,
                &copy_id,
                &FileRow {
                    path,
                    sha256: sha256.clone(),
                },
                now_ms,
            )?;
            Ok(Some(written(
                saved.canvas,
                strip_file_meta(&text),
                sha256,
                saved.sync,
            )))
        })?;
        if let Some(copy) = &copy {
            self.rewrite_edges(&copy.canvas.summary.id, &copy.canvas.scene)?;
        }
        Ok(copy)
    }

    /// `deleteCanvas`: the record first, then the document to the OS trash (unlinked when the
    /// trash refuses it). `false` when there was no live canvas.
    pub fn delete(&self, id: &str, now_ms: i64) -> Result<bool, CanvasError> {
        let path = self.write::<_, CanvasError>(|conn| {
            let path = match self.locate(conn, id)? {
                Found::File { path, .. } => Some(path),
                Found::Outside | Found::None => None,
            };
            let deleted = canvas::delete(conn, id, self.canvases.device_id(), now_ms)?;
            Ok(deleted.then_some(path))
        })?;
        let Some(path) = path else {
            return Ok(false);
        };
        self.index.call_blocking(|index| edges::clear(index, id))?;
        if let Some(path) = path {
            self.remove_document(&path);
        }
        self.release_removed(&[id.to_owned()])?;
        Ok(true)
    }

    fn remove_document(&self, path: &str) {
        let Ok(absolute) = resolve_canvas_file(&self.vault, path) else {
            return;
        };
        if let Err(error) = (self.trash)(&absolute) {
            // Trash can be unavailable (network volumes, some Linux setups). The record is
            // deleted already, so the document must not keep haunting the folder.
            tracing::warn!(scope = "CanvasStore", %error, "could not trash a canvas document; unlinking it");
            if let Err(error) = std::fs::remove_file(&absolute) {
                tracing::warn!(scope = "CanvasStore", kind = ?error.kind(), "could not unlink a deleted canvas's document");
            }
        }
    }

    /// Drops the `canvas_files` row of each deleted canvas whose document is gone. One whose
    /// removal failed keeps its row, so the document is not adopted back as a new canvas.
    pub(super) fn release_removed(&self, ids: &[String]) -> Result<(), StorageError> {
        self.write::<_, StorageError>(|conn| {
            for id in ids {
                let Some(row) = files::get(conn, id)? else {
                    continue;
                };
                let gone = resolve_canvas_file(&self.vault, &row.path)
                    .map(|absolute| std::fs::symlink_metadata(absolute).is_err())
                    .unwrap_or(true);
                if gone {
                    files::remove(conn, id)?;
                }
            }
            Ok(())
        })
    }

    /// The absolute path of a live canvas's document, for reveal and open-external; `None` when
    /// it has none.
    pub fn document_path(&self, id: &str) -> Result<Option<PathBuf>, CanvasError> {
        self.write::<_, CanvasError>(|conn| {
            if canvas::get(conn, id)?.is_none() {
                return Ok(None);
            }
            Ok(match self.locate(conn, id)? {
                Found::File { path, .. } => resolve_canvas_file(&self.vault, &path).ok(),
                Found::Outside | Found::None => None,
            })
        })
    }

    /// The canvas's document: the row's path, else the document carrying its id anywhere under
    /// `canvases/` (moved outside the app, or written by another build).
    pub(super) fn locate(&self, conn: &Connection, id: &str) -> Result<Found, CanvasError> {
        let row = files::get(conn, id)?;
        if let Some(row) = &row {
            match read_canvas_file(&self.vault, &row.path) {
                Ok(Some(document)) if !holds_other(&document, id) => {
                    return Ok(Found::File {
                        path: row.path.clone(),
                        document,
                    });
                }
                Ok(_) => {}
                Err(ReadError::Outside) => return Ok(Found::Outside),
                Err(error) => return Err(error.into()),
            }
        }
        for path in list_canvas_files(&self.vault) {
            if row.as_ref().is_some_and(|row| row.path == path) {
                continue;
            }
            let Ok(Some(document)) = read_canvas_file(&self.vault, &path) else {
                continue;
            };
            if read_file_meta(&document.text, 0).is_some_and(|meta| meta.id == id) {
                return Ok(Found::File { path, document });
            }
        }
        Ok(Found::None)
    }

    pub(super) fn rewrite_edges(&self, id: &str, scene: &str) -> Result<(), CanvasError> {
        Ok(self
            .index
            .call_blocking(|index| edges::rewrite(index, id, scene))?)
    }
}

/// A document whose sidecar names another canvas is not this one's.
fn holds_other(document: &CanvasDocument, id: &str) -> bool {
    read_file_meta(&document.text, 0).is_some_and(|meta| meta.id != id)
}

/// The stored spelling of the folder a caller named (`storedFolderPath`): its on-disk form,
/// matched to a live record's case. Refused past the depth cap.
pub(super) fn stored_folder(
    conn: &Connection,
    folder: Option<&str>,
) -> Result<Option<String>, FolderWriteError> {
    let canonical = portable_canvas_folder(folder)?;
    Ok(folders::stored_path(conn, canonical.as_deref())?)
}

impl From<FolderWriteError> for CanvasError {
    fn from(error: FolderWriteError) -> Self {
        match error {
            FolderWriteError::Refused(refused) => Self::Folder(refused),
            FolderWriteError::Storage(storage) => Self::Storage(storage),
        }
    }
}

pub(super) fn meta(id: &str, created_at: i64, updated_at: i64) -> FileMeta {
    FileMeta {
        id: id.to_owned(),
        created_at,
        updated_at,
    }
}

/// The file name of a stored path without its extension: the title a moved or copied canvas
/// takes.
pub(super) fn file_stem(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or_default();
    name.strip_suffix(CANVAS_FILE_EXT)
        .unwrap_or(name)
        .to_owned()
}

pub(super) fn summary(canvas: Canvas) -> CanvasSummaryView {
    CanvasSummaryView {
        id: canvas.id,
        title: canvas.title,
        folder: canvas.folder,
        icon: canvas.icon,
        owner_note_id: canvas.owner_note_id,
        created_at: canvas.created_at,
        updated_at: canvas.updated_at,
    }
}

pub(super) fn written(canvas: Canvas, scene: String, sha256: String, sync: SyncHold) -> Written {
    Written {
        canvas: CanvasView {
            summary: summary(canvas),
            scene,
            sha256: Some(sha256),
            unreadable: None,
        },
        too_large: sync != SyncHold::Queued,
    }
}
