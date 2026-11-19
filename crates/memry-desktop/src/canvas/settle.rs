//! Brings a canvas's document and its record's scene back into agreement, losing neither.
//!
//! Electron has one copy of the ink, the file, and pushes whatever it holds. Here the record's
//! payload is what syncs, so an edit made on disk has to reach it, and a scene that reached the
//! record without passing through this device's document (an apply, another build) has to reach
//! the file. `canvas_files` tells the two apart: its sha256 is the document as the app last wrote
//! or read it, when the document and the record held the same scene, and `written_at` is when.
//!
//! - Same scene on both sides: nothing to do but record the document.
//! - The document is as the app left it: the record changed since, and the file takes its scene.
//! - The document changed on disk and the record did not: the record takes the document's scene.
//! - Both changed: the on-disk drawing is filed as `"<title> (conflict copy)"`, then the file
//!   takes the record's scene.
//! - A document that is not a drawing is left alone on both sides.
//!
//! Wherever the document is, the record's folder follows it: the path is the truth for
//! placement, as in Electron's reconcile.

use memry_core::domain::canvas::file_format::{strip_file_meta, with_file_meta};
use memry_core::domain::canvas::folder_paths::canvas_path_key;
use memry_core::domain::canvas::{self, Canvas, CanvasEdit, canonical_scene};
use rusqlite::Connection;

use super::files::{self, FileRow};
use super::scene_file::{Expect, folder_of_canvas_path, write_canvas_file};
use super::service::{CanvasError, CanvasService, Found, Written, meta};

/// What [`CanvasService::settle_in`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Settled {
    InSync,
    /// The document took the record's scene.
    FileWritten,
    /// The record took the document's scene.
    Absorbed,
    /// Both had changed: the on-disk drawing became this canvas, then the file took the
    /// record's scene.
    ConflictCopy(Box<Written>),
    /// No document; nothing is written for it.
    Missing,
    /// The document links outside the vault: never read, never written.
    Outside,
    /// The document's text is not a drawing: kept as it is, and not taken into the record.
    NotADrawing,
}

impl Settled {
    /// Whether the canvas's scene changed, so its edges are stale.
    pub fn scene_changed(&self) -> bool {
        matches!(
            self,
            Self::FileWritten | Self::Absorbed | Self::ConflictCopy(_)
        )
    }
}

impl CanvasService {
    /// Settles live `canvas` against its document `found` ([`CanvasService::locate`]), inside the
    /// caller's writer call.
    pub(super) fn settle_in(
        &self,
        conn: &Connection,
        canvas: &Canvas,
        found: Found,
        now_ms: i64,
    ) -> Result<Settled, CanvasError> {
        let (path, document, seen) = match found {
            Found::File {
                path,
                document,
                seen,
            } => (path, document, seen),
            Found::Outside => return Ok(Settled::Outside),
            Found::None => return Ok(Settled::Missing),
        };
        let id = canvas.id.as_str();
        let on_disk = canonical_scene(&strip_file_meta(&document.text)).ok();
        let unchanged = seen.as_deref() == Some(document.sha256.as_str());
        let folder = folder_of_canvas_path(&path);
        let moved =
            folder.as_deref().map(canvas_path_key) != canvas.folder.as_deref().map(canvas_path_key);
        let refile = moved.then_some(folder.as_deref());
        let record = |conn: &Connection, sha256: String| {
            files::put(
                conn,
                id,
                &FileRow {
                    path: path.clone(),
                    sha256,
                },
                now_ms,
            )
        };

        let settled = if on_disk.as_deref() == Some(canvas.scene.as_str()) {
            if !unchanged {
                record(conn, document.sha256.clone())?;
            }
            Settled::InSync
        } else if unchanged {
            let sha256 = self.write_record_scene(canvas, &path, &document.sha256)?;
            record(conn, sha256)?;
            Settled::FileWritten
        } else if let Some(scene) = on_disk {
            let record_changed = seen.is_some()
                && files::written_at(conn, id)?.is_some_and(|at| canvas.updated_at > at);
            if record_changed {
                let copy = self.conflict_copy(conn, canvas, &document, now_ms)?;
                let sha256 = self.write_record_scene(canvas, &path, &document.sha256)?;
                record(conn, sha256)?;
                Settled::ConflictCopy(Box::new(copy))
            } else {
                let edit = CanvasEdit {
                    scene: Some(&scene),
                    folder: refile,
                    ..CanvasEdit::default()
                };
                canvas::update(conn, id, &edit, self.canvases.device_id(), now_ms)?;
                record(conn, document.sha256.clone())?;
                return Ok(Settled::Absorbed);
            }
        } else {
            tracing::warn!(
                scope = "CanvasReconcile",
                "a canvas document is not a drawing; leaving it and its record as they are"
            );
            return Ok(Settled::NotADrawing);
        };
        if moved {
            let edit = CanvasEdit {
                folder: refile,
                ..CanvasEdit::default()
            };
            canvas::update(conn, id, &edit, self.canvases.device_id(), now_ms)?;
        }
        Ok(settled)
    }

    /// Writes the record's scene over the document as read (`sha256`), returning the new sha.
    fn write_record_scene(
        &self,
        canvas: &Canvas,
        path: &str,
        sha256: &str,
    ) -> Result<String, CanvasError> {
        let text = with_file_meta(
            &canvas.scene,
            &meta(&canvas.id, canvas.created_at, canvas.updated_at),
        );
        Ok(write_canvas_file(
            &self.vault,
            path,
            &text,
            Expect::Unchanged(sha256),
        )?)
    }
}
