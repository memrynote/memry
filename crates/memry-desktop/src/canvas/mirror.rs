//! The canvas records a sync pull applied, followed on disk (Electron's
//! `sync/item-handlers/canvas-handler.ts:155-410` and `canvas-folder-handler.ts:135-170`).
//!
//! Each applied canvas is brought to its record's state, whatever the outcome said, so a replay
//! of the same page does nothing more:
//! - live with no document on this device: a new document in the record's folder, named for its
//!   title (`allocateCanvasPath`). A canvas whose document this device had and lost keeps having
//!   none, as in settle: the watcher turns that loss into a delete.
//! - live, its record's folder no longer the one this device last filed the document in: the
//!   document moves there, keeping its file name (a remote move).
//! - live: [`CanvasService::settle_in`] then brings the scene across, so a disk edit made since
//!   the last agreement becomes a conflict copy and is never overwritten.
//! - deleted: the document goes to the OS trash and its row is released, so the next open's
//!   reconcile has nothing to adopt back. A document edited since the agreement (or one this
//!   device never wrote) is first filed as `"<title> (conflict copy)"`.
//! - a deleted folder: its emptied directories go (`removeEmptyCanvasFolderDirs`), after the
//!   page's canvases left them.
//!
//! The watcher hears only removals under `canvases/`. A move or trash made here finds its row
//! re-pointed or released by the time the rename window ends, so it is not a delete again.

use std::collections::HashSet;
use std::sync::Arc;

use memry_core::domain::canvas::file_format::{strip_file_meta, with_file_meta};
use memry_core::domain::canvas::folder_paths::canvas_path_key;
use memry_core::domain::canvas::{self, Canvas, edges};
use memry_core::domain::canvas_folder;
use memry_core::sync::driver::{AppliedOutcome, AppliedRecord, ApplyObserver};
use rusqlite::{Connection, OptionalExtension};

use super::dirs::remove_empty_canvas_folder_dirs;
use super::files::{self, FileRow};
use super::reconcile::now_ms;
use super::scene_file::{
    Expect, allocate_canvas_path, folder_of_canvas_path, rename_canvas_file, write_canvas_file,
};
use super::service::{
    CanvasError, CanvasService, CanvasSummaryView, Found, file_stem, meta, summary,
};
use super::settle::Settled;

const SCOPE: &str = "CanvasMirror";

/// What a followed record tells the renderer, with Electron's payloads (`canvas-handler.ts:224`,
/// `:336`, `:387`, `:572`): `canvas:created`, `canvas:updated` or `canvas:deleted`. Sent after the
/// document follows, so an open editor that reloads reads the remote scene before its next save.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanvasSynced {
    Created(CanvasSummaryView),
    Updated(CanvasSummaryView),
    Deleted(String),
}

/// Hands each [`CanvasSynced`] to the renderer.
pub type CanvasSyncedHook = Arc<dyn Fn(CanvasSynced) + Send + Sync>;

/// The applied-record observer of one open vault's sync.
pub struct CanvasMirror {
    pub service: CanvasService,
    pub synced: CanvasSyncedHook,
}

impl ApplyObserver for CanvasMirror {
    fn name(&self) -> &str {
        SCOPE
    }

    fn records_applied(&self, batch: &[AppliedRecord]) {
        for told in self.service.mirror_applied(batch, now_ms()) {
            (self.synced)(told);
        }
    }
}

/// What following one canvas did to its document, after the writer call.
enum Followed {
    /// The canvas as followed, the scene to index, and a conflict copy a settle made.
    Live(CanvasSummaryView, Option<String>, Settled),
    /// The canvas is deleted: its document, if any, to trash, and the conflict copy kept of it.
    Deleted(Option<String>, Option<Settled>),
}

impl CanvasService {
    /// Follows every canvas and folder record of an applied page on disk, returning what the
    /// renderer is told. A failure is logged per record and the rest still run.
    pub fn mirror_applied(&self, batch: &[AppliedRecord], now_ms: i64) -> Vec<CanvasSynced> {
        let applied = || {
            batch
                .iter()
                .filter(|r| r.outcome != AppliedOutcome::Skipped)
        };
        let mut told = Vec::new();
        for record in applied().filter(|r| r.item_type == canvas::ITEM_TYPE) {
            match self.follow_canvas(&record.item_id, record.outcome, now_ms) {
                Ok(events) => told.extend(events),
                Err(error) => {
                    tracing::error!(scope = SCOPE, %error, "a synced canvas did not reach its document")
                }
            }
        }
        for record in applied().filter(|r| {
            r.item_type == canvas_folder::ITEM_TYPE && r.outcome == AppliedOutcome::Deleted
        }) {
            match self.write(|conn| deleted_folder_path(conn, &record.item_id)) {
                Ok(Some(path)) => {
                    remove_empty_canvas_folder_dirs(&self.vault, &path);
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::error!(scope = SCOPE, %error, "a deleted canvas folder's directory was kept")
                }
            }
        }
        told
    }

    /// Follows canvas `id` on disk, returning what the renderer is told.
    fn follow_canvas(
        &self,
        id: &str,
        outcome: AppliedOutcome,
        now_ms: i64,
    ) -> Result<Vec<CanvasSynced>, CanvasError> {
        let followed = self.write::<_, CanvasError>(|conn| match canvas::get(conn, id)? {
            Some(canvas) => self.follow_live(conn, &canvas, now_ms),
            None => self.follow_deleted(conn, id, now_ms),
        })?;
        match followed {
            Followed::Live(canvas, scene, settled) => {
                if let Some(scene) = scene {
                    self.rewrite_edges(id, &scene)?;
                }
                self.index_settled_copy(&settled)?;
                let canvas = match outcome {
                    AppliedOutcome::Created => CanvasSynced::Created(canvas),
                    _ => CanvasSynced::Updated(canvas),
                };
                Ok(copy_created(Some(&settled))
                    .into_iter()
                    .chain([canvas])
                    .collect())
            }
            Followed::Deleted(path, copy) => {
                self.index.call_blocking(|index| edges::clear(index, id))?;
                if let Some(copy) = &copy {
                    self.index_settled_copy(copy)?;
                }
                if let Some(path) = path {
                    self.remove_document(&path);
                }
                self.release_removed(&[id.to_owned()])?;
                let deleted = CanvasSynced::Deleted(id.to_owned());
                Ok(copy_created(copy.as_ref())
                    .into_iter()
                    .chain([deleted])
                    .collect())
            }
        }
    }

    fn follow_live(
        &self,
        conn: &Connection,
        canvas: &Canvas,
        now_ms: i64,
    ) -> Result<Followed, CanvasError> {
        let id = canvas.id.as_str();
        let created = match files::get(conn, id)? {
            Some(row) => {
                self.follow_move(conn, canvas, &row, now_ms)?;
                false
            }
            None if matches!(self.locate(conn, id)?, Found::None) => {
                self.write_new_document(conn, canvas, now_ms)?;
                true
            }
            None => false,
        };
        let found = self.locate(conn, id)?;
        let settled = self.settle_in(conn, canvas, found, now_ms)?;
        let scene = match created || settled.scene_changed() {
            true => canvas::get(conn, id)?.map(|canvas| canvas.scene),
            false => None,
        };
        Ok(Followed::Live(summary(canvas.clone()), scene, settled))
    }

    /// A document for a canvas this device has none of, at a path named for its title.
    fn write_new_document(
        &self,
        conn: &Connection,
        canvas: &Canvas,
        now_ms: i64,
    ) -> Result<(), CanvasError> {
        let path = allocate_canvas_path(
            &self.vault,
            canvas.title.as_deref(),
            &HashSet::new(),
            None,
            canvas.folder.as_deref(),
        )?;
        let text = with_file_meta(
            &canvas.scene,
            &meta(&canvas.id, canvas.created_at, canvas.updated_at),
        );
        let sha256 = write_canvas_file(&self.vault, &path, &text, Expect::New)?;
        let row = FileRow {
            path,
            sha256,
            record_sha256: Some(files::scene_sha256(&canvas.scene)),
        };
        Ok(files::put(conn, &canvas.id, &row, now_ms)?)
    }

    /// Moves the document into the record's folder when the record left the folder this device
    /// last filed it in. A document moved outside the app while the record stayed is the
    /// settle's to follow, not undone here.
    fn follow_move(
        &self,
        conn: &Connection,
        canvas: &Canvas,
        row: &FileRow,
        now_ms: i64,
    ) -> Result<(), CanvasError> {
        let key = |folder: Option<String>| folder.as_deref().map(canvas_path_key);
        if key(folder_of_canvas_path(&row.path)) == key(canvas.folder.clone()) {
            return Ok(());
        }
        let Found::File { path, .. } = self.locate(conn, &canvas.id)? else {
            return Ok(());
        };
        let target = allocate_canvas_path(
            &self.vault,
            Some(&file_stem(&path)),
            &HashSet::new(),
            Some(&path),
            canvas.folder.as_deref(),
        )?;
        let moved = rename_canvas_file(&self.vault, &path, &target);
        if moved == path {
            return Ok(());
        }
        let row = FileRow {
            path: moved,
            ..row.clone()
        };
        Ok(files::put(conn, &canvas.id, &row, now_ms)?)
    }

    /// The document of a deleted canvas, to trash once the writer call ends. One edited since
    /// the last agreement, or never written here, is first kept as a conflict copy; one that
    /// is not a drawing fails the copy and stays where it is.
    fn follow_deleted(
        &self,
        conn: &Connection,
        id: &str,
        now_ms: i64,
    ) -> Result<Followed, CanvasError> {
        let Found::File { path, document } = self.locate(conn, id)? else {
            return Ok(Followed::Deleted(None, None));
        };
        let agreed = files::get(conn, id)?.is_some_and(|row| row.sha256 == document.sha256);
        let mut kept = None;
        if !agreed {
            let named = Canvas {
                id: id.to_owned(),
                title: Some(file_stem(&path)),
                folder: folder_of_canvas_path(&path),
                icon: None,
                owner_note_id: None,
                created_at: now_ms,
                updated_at: now_ms,
                scene: strip_file_meta(&document.text),
            };
            let copy = self.conflict_copy(conn, &named, &document, now_ms)?;
            tracing::warn!(
                scope = SCOPE,
                "a canvas deleted on another device was edited here; kept as a conflict copy"
            );
            kept = Some(Settled::ConflictCopy(Box::new(copy)));
        }
        Ok(Followed::Deleted(Some(path), kept))
    }
}

/// `canvas:created` for the conflict copy a settle kept (`canvas-handler.ts:572`).
fn copy_created(settled: Option<&Settled>) -> Option<CanvasSynced> {
    match settled {
        Some(Settled::ConflictCopy(copy)) => {
            Some(CanvasSynced::Created(copy.canvas.summary.clone()))
        }
        _ => None,
    }
}

/// The stored path of the deleted folder record `id`.
fn deleted_folder_path(conn: &Connection, id: &str) -> Result<Option<String>, CanvasError> {
    conn.query_row(
        "SELECT path FROM canvas_folders WHERE id = ?1 AND deleted_at IS NOT NULL",
        [id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| {
        CanvasError::Storage(memry_core::api::errors::StorageError::Failed {
            what: format!("canvas_folders: {error}"),
        })
    })
}
