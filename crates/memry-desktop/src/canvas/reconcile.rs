//! Vault-open reconcile of the canvases on disk against their records (Electron's
//! `canvas/reconcile.ts`), run in the background of every open: the open never waits for it.
//!
//! - A document under `canvases/` that no row knows is adopted: re-pointed when it carries the id
//!   of a live canvas whose document is gone (moved or renamed outside the app), else a new
//!   canvas, under its own id unless another canvas (a deleted one included) holds it.
//! - Every live canvas is settled against its document ([`super::settle`]), which carries an
//!   edit made on disk into the record and a record change the file missed into the file, and
//!   rebuilds its edges.
//! - A directory with no live folder record is adopted, an empty one included, unless its record
//!   is deleted and no live canvas's document is in it: then the emptied directory is removed.
//!   A live folder record whose directory is gone gets the directory back.
//!
//! Additive, as Electron's: nothing here deletes a record, and the only thing removed from disk
//! is the empty directory of a folder already deleted. A deleted document becomes a canvas
//! delete through the vault watcher, never here.
//!
//! Departures from Electron: the record's scene is kept in agreement with the document (Electron
//! has no second copy); a document that is not a drawing is not adopted; there is no migration of
//! pre-file encrypted snapshots, which Electron's import owns; asset rows are not recorded (the
//! canvas assets stage owns them).

use std::collections::HashSet;
use std::fs;
use std::sync::Arc;

use memry_core::api::errors::StorageError;
use memry_core::domain::canvas::file_format::{read_file_meta, strip_file_meta, with_file_meta};
use memry_core::domain::canvas::folder_paths::{
    MAX_CANVAS_FOLDER_DEPTH, canvas_path_key, folder_segments, is_descendant_folder,
};
use memry_core::domain::canvas::{self, NewCanvas, canonical_scene, folders};
use memry_core::domain::canvas_folder;
use memry_core::seams::secure_store::SecureStore;
use rusqlite::Connection;

use super::dirs::{
    canonicalize_canvas_folder_dirs, list_canvas_folder_dirs, remove_canvas_folder_dir_if_empty,
};
use super::files::{self, FileRow};
use super::scene_file::{
    Expect, folder_of_canvas_path, list_canvas_files, portable_canvas_folder, read_canvas_file,
    write_canvas_file,
};
use super::service::{CanvasError, CanvasService, Found, file_stem, meta};
use super::settle::Settled;
use crate::session::Session;
use crate::vault::layout::CANVAS_DIR;

/// What one reconcile did. Counts only: names and paths are user content.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Reconciled {
    pub adopted: usize,
    /// Documents moved outside the app whose canvas now points at them.
    pub repointed: usize,
    /// Canvases whose record took the document's scene, or the other way round.
    pub settled: usize,
    pub conflict_copies: usize,
    /// Live canvases with no document.
    pub missing_files: usize,
    pub folders_adopted: usize,
    pub folders_restored: usize,
    pub folders_pruned: usize,
}

/// Runs [`CanvasService::reconcile`] in the background of every open.
pub fn register(session: &Session, store: Arc<dyn SecureStore>) {
    session.on_background(
        "canvas-reconcile",
        Arc::new(move |view, cancel| {
            if cancel.is_cancelled() {
                return Ok(());
            }
            let service = CanvasService::open(view, store.clone())
                .map_err(|error| format!("canvas reconcile did not run: {error}"))?;
            let done = service
                .reconcile(now_ms(), &|| cancel.is_cancelled())
                .map_err(|error| format!("canvas reconcile failed: {error}"))?;
            if done != Reconciled::default() {
                tracing::info!(scope = "CanvasReconcile", ?done, "canvas files reconciled");
            }
            Ok(())
        }),
    );
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

impl CanvasService {
    /// Reconciles the vault's canvas documents and directories with their records. Each document
    /// is its own writer call, so the app's writes are never held up for long; `cancelled` is
    /// checked between them.
    pub fn reconcile(
        &self,
        now_ms: i64,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Reconciled, CanvasError> {
        let mut done = Reconciled::default();
        if let Err(error) = fs::create_dir_all(self.vault.join(CANVAS_DIR)) {
            tracing::warn!(scope = "CanvasReconcile", kind = ?error.kind(), "no canvases folder");
            return Ok(done);
        }
        // Before any path is read: an adopted canvas or folder stores its on-disk spelling.
        canonicalize_canvas_folder_dirs(&self.vault);
        self.write(|conn| release_removed_paths(conn, &self.vault))?;

        let mut known: HashSet<String> = self
            .write(files::all)?
            .into_iter()
            .map(|(_, path, _)| canvas_path_key(&path))
            .collect();
        for path in list_canvas_files(&self.vault) {
            if cancelled() {
                return Ok(done);
            }
            if !known.insert(canvas_path_key(&path)) {
                continue;
            }
            match self.write(|conn| self.adopt_in(conn, &path, now_ms)) {
                Ok(Some(Adopted::New)) => done.adopted += 1,
                Ok(Some(Adopted::Repointed)) => done.repointed += 1,
                Ok(None) => {}
                // One document must not stop the rest. No path: it is title-derived.
                Err(error) => {
                    tracing::warn!(scope = "CanvasReconcile", %error, "a canvas document was not adopted")
                }
            }
        }

        let vault_id = self.canvases.vault_id().to_owned();
        let live = self
            .canvases
            .db()
            .read_blocking(move |conn| canvas::list(conn, &vault_id))?;
        for canvas in live {
            if cancelled() {
                return Ok(done);
            }
            match self.settle_one(&canvas.id, now_ms) {
                Ok(Settled::Missing) => done.missing_files += 1,
                Ok(Settled::ConflictCopy(_)) => done.conflict_copies += 1,
                Ok(settled) if settled.scene_changed() => done.settled += 1,
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(scope = "CanvasReconcile", %error, "a canvas was not settled with its document")
                }
            }
        }
        if cancelled() {
            return Ok(done);
        }
        self.reconcile_folders(now_ms, &mut done)?;
        Ok(done)
    }

    /// Settles one live canvas and rebuilds its edges from the scene it ends with.
    fn settle_one(&self, id: &str, now_ms: i64) -> Result<Settled, CanvasError> {
        let settled = self.write::<_, CanvasError>(|conn| {
            let Some(canvas) = canvas::get(conn, id)? else {
                return Ok(None);
            };
            let found = self.locate(conn, id)?;
            let disk_scene = match &found {
                Found::File { document, .. } => {
                    canonical_scene(&strip_file_meta(&document.text)).ok()
                }
                _ => None,
            };
            let settled = self.settle_in(conn, &canvas, found, now_ms)?;
            let scene = match &settled {
                Settled::Absorbed => disk_scene,
                Settled::InSync | Settled::FileWritten | Settled::ConflictCopy(_) => {
                    Some(canvas.scene)
                }
                Settled::Missing | Settled::Outside | Settled::NotADrawing => None,
            };
            Ok(Some((settled, scene)))
        })?;
        let Some((settled, scene)) = settled else {
            return Ok(Settled::Missing);
        };
        if let Some(scene) = scene {
            self.rewrite_edges(id, &scene)?;
        }
        if let Settled::ConflictCopy(copy) = &settled {
            self.rewrite_edges(&copy.canvas.summary.id, &copy.canvas.scene)?;
        }
        Ok(settled)
    }

    /// Adopts the document at `path`, which no row names.
    fn adopt_in(
        &self,
        conn: &Connection,
        path: &str,
        now_ms: i64,
    ) -> Result<Option<Adopted>, CanvasError> {
        let document = match read_canvas_file(&self.vault, path) {
            Ok(Some(document)) => document,
            Ok(None) => return Ok(None),
            Err(error) => {
                tracing::warn!(scope = "CanvasReconcile", %error, "skipping a canvas document");
                return Ok(None);
            }
        };
        let sidecar = read_file_meta(&document.text, now_ms);
        if let Some(sidecar) = &sidecar
            && let Some(canvas) = canvas::get(conn, &sidecar.id)?
            && !self.has_own_document(conn, &sidecar.id)?
        {
            // The same canvas, moved or renamed outside the app: re-pointed, never duplicated.
            let found = Found::File {
                path: path.to_owned(),
                document,
            };
            self.settle_in(conn, &canvas, found, now_ms)?;
            return Ok(Some(Adopted::Repointed));
        }

        let scene = strip_file_meta(&document.text);
        if canonical_scene(&scene).is_err() {
            tracing::warn!(
                scope = "CanvasReconcile",
                "skipping a canvas document that is not a drawing"
            );
            return Ok(None);
        }
        // A copy of a document (two files, one id) or a deleted canvas's document put back takes
        // a new id: the id in its file is taken.
        let id = match &sidecar {
            Some(sidecar) if !id_taken(conn, &sidecar.id)? => sidecar.id.clone(),
            _ => canvas::new_id(),
        };
        let title = file_stem(path);
        let folder = folder_of_canvas_path(path);
        let saved = canvas::create(
            conn,
            &NewCanvas {
                id: Some(&id),
                title: Some(&title),
                scene: Some(&scene),
                folder: folder.as_deref(),
                ..NewCanvas::default()
            },
            self.canvases.vault_id(),
            self.canvases.device_id(),
            now_ms,
        )?;
        // The file has to know which canvas it is when it is copied next.
        let sha256 = if sidecar.as_ref().is_some_and(|sidecar| sidecar.id == id) {
            document.sha256
        } else {
            let text = with_file_meta(
                &scene,
                &meta(&id, saved.canvas.created_at, saved.canvas.updated_at),
            );
            write_canvas_file(
                &self.vault,
                path,
                &text,
                Expect::Unchanged(&document.sha256),
            )?
        };
        let row = FileRow {
            path: path.to_owned(),
            sha256,
        };
        files::put(conn, &id, &row, now_ms)?;
        Ok(Some(Adopted::New))
    }

    /// Whether the canvas's row names a document that is still there and still its own.
    fn has_own_document(&self, conn: &Connection, id: &str) -> Result<bool, StorageError> {
        let Some(row) = files::get(conn, id)? else {
            return Ok(false);
        };
        Ok(match read_canvas_file(&self.vault, &row.path) {
            Ok(Some(document)) => {
                read_file_meta(&document.text, 0).is_none_or(|sidecar| sidecar.id == id)
            }
            Ok(None) => false,
            // Unreadable or outside: it may still be there, so it still owns the id.
            Err(_) => true,
        })
    }

    fn reconcile_folders(&self, now_ms: i64, done: &mut Reconciled) -> Result<(), CanvasError> {
        let dirs = list_canvas_folder_dirs(&self.vault);
        let on_disk: HashSet<String> = list_canvas_files(&self.vault)
            .iter()
            .map(|path| canvas_path_key(path))
            .collect();
        let (emptied, live_before) = self.write::<_, CanvasError>(|conn| {
            let live_before = canvas_folder::list(conn)?;
            let mut live: HashSet<String> =
                live_before.iter().map(|folder| folder.id.clone()).collect();
            let deleted = deleted_folder_ids(conn)?;
            // Documents a live canvas owns that are on disk, as the folders holding them.
            let held: Vec<Option<String>> = files::all(conn)?
                .into_iter()
                .filter(|(_, path, is_live)| *is_live && on_disk.contains(&canvas_path_key(path)))
                .map(|(_, path, _)| folder_of_canvas_path(&canvas_path_key(&path)))
                .collect();
            let mut emptied = Vec::new();
            for folder in &dirs {
                if portable_canvas_folder(Some(folder))
                    .ok()
                    .flatten()
                    .as_deref()
                    != Some(folder)
                {
                    continue;
                }
                let id = canvas_folder::sync_id(folder);
                if live.contains(&id) {
                    continue;
                }
                // The revival rule: a deleted folder comes back only for a live canvas's
                // document still in it; an emptied one is litter the delete left behind.
                let key = canvas_path_key(folder);
                let holds = held
                    .iter()
                    .any(|at| is_descendant_folder(at.as_deref(), Some(&key)));
                if deleted.contains(&id) && !holds {
                    emptied.push(folder.clone());
                    continue;
                }
                let vault_id = self.canvases.vault_id();
                folders::create(conn, vault_id, folder, self.canvases.device_id(), now_ms)?;
                live.insert(id);
                done.folders_adopted += 1;
            }
            Ok((emptied, live_before))
        })?;

        let mut deepest_first = emptied;
        deepest_first.sort_by_key(|folder| std::cmp::Reverse(folder_segments(Some(folder)).len()));
        done.folders_pruned = deepest_first
            .iter()
            .filter(|folder| remove_canvas_folder_dir_if_empty(&self.vault, folder))
            .count();

        for folder in live_before {
            let depth = folder_segments(Some(&folder.path)).len();
            let canonical = portable_canvas_folder(Some(&folder.path)).ok().flatten()
                == Some(folder.path.clone());
            let dir = self.vault.join(CANVAS_DIR).join(&folder.path);
            if depth == 0 || depth > MAX_CANVAS_FOLDER_DEPTH || !canonical || dir.exists() {
                continue;
            }
            match fs::create_dir_all(&dir) {
                Ok(()) => done.folders_restored += 1,
                Err(error) => {
                    tracing::warn!(scope = "CanvasReconcile", kind = ?error.kind(), "could not restore a canvas folder's directory")
                }
            }
        }
        Ok(())
    }
}

enum Adopted {
    New,
    Repointed,
}

/// Drops the row of a deleted canvas whose document is gone, so a document put back at its path
/// is adopted as a new canvas (`releaseRemovedCanvasPaths`). A deleted canvas whose document is
/// still there keeps its row: its removal failed, and adopting it would undo the delete.
fn release_removed_paths(conn: &Connection, vault: &std::path::Path) -> Result<(), CanvasError> {
    for (id, path, live) in files::all(conn)? {
        if !live && matches!(read_canvas_file(vault, &path), Ok(None)) {
            files::remove(conn, &id)?;
        }
    }
    Ok(())
}

/// Whether any canvas, a deleted one included, has this id.
fn id_taken(conn: &Connection, id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM canvases WHERE id = ?1)
             OR EXISTS (SELECT 1 FROM sync_items WHERE item_type = 'canvas' AND item_id = ?1)",
        [id],
        |row| row.get(0),
    )
    .map_err(|error| StorageError::Failed {
        what: format!("canvas ids: {error}"),
    })
}

fn deleted_folder_ids(conn: &Connection) -> Result<HashSet<String>, StorageError> {
    let failed = |error: rusqlite::Error| StorageError::Failed {
        what: format!("canvas folders: {error}"),
    };
    let mut statement = conn
        .prepare("SELECT id FROM canvas_folders WHERE deleted_at IS NOT NULL")
        .map_err(failed)?;
    statement
        .query_map([], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}
