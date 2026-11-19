//! Brings a canvas's document and its record's scene back into agreement, losing neither.
//!
//! Electron has one copy of the ink, the file, and pushes whatever it holds. Here the record's
//! payload is what syncs, so an edit made on disk has to reach it, and a scene that reached the
//! record without passing through this device's document (an apply, another build) has to reach
//! the file. The canvas's row ([`files::FileRow`]) tells the two apart: the sha256 of the
//! document's bytes and of the record's scene when the two last agreed. Only a settle that leaves
//! them agreeing, and a write that makes both sides the same scene, moves that point; a read or a
//! title, icon or placement change never does. A move keeps the bytes, so the point holds for the
//! document wherever it is found.
//!
//! - Same scene on both sides: nothing to do but record the agreement.
//! - The document is as it was at the agreement: the record changed since, and the file takes
//!   its scene.
//! - The document changed and the record did not: the record takes the document's scene.
//! - Both changed, or the record's side is unknown (no row, or a row from an earlier build): the
//!   on-disk drawing is filed as `"<title> (conflict copy)"`, then the file takes the record's
//!   scene.
//! - A document that is not a drawing is left alone on both sides, and records nothing.
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
        let (path, document) = match found {
            Found::File { path, document } => (path, document),
            Found::Outside => return Ok(Settled::Outside),
            Found::None => return Ok(Settled::Missing),
        };
        let id = canvas.id.as_str();
        // Wherever the document is found: a move outside the app keeps its bytes.
        let agreed = files::get(conn, id)?;
        let record_sha256 = files::scene_sha256(&canvas.scene);
        let file_changed = agreed
            .as_ref()
            .is_none_or(|row| row.sha256 != document.sha256);
        let record_changed = agreed.as_ref().and_then(|row| row.record_sha256.as_deref())
            != Some(record_sha256.as_str());
        let on_disk = canonical_scene(&strip_file_meta(&document.text)).ok();
        let folder = folder_of_canvas_path(&path);
        let moved =
            folder.as_deref().map(canvas_path_key) != canvas.folder.as_deref().map(canvas_path_key);
        let refile = moved.then_some(folder.as_deref());
        let agree = |sha256: String, record_sha256: String| FileRow {
            path: path.clone(),
            sha256,
            record_sha256: Some(record_sha256),
        };

        let settled = if on_disk.as_deref() == Some(canvas.scene.as_str()) {
            let row = agree(document.sha256.clone(), record_sha256);
            if agreed.as_ref() != Some(&row) {
                files::put(conn, id, &row, now_ms)?;
            }
            Settled::InSync
        } else if !file_changed {
            let sha256 = self.write_record_scene(canvas, &path, &document.sha256)?;
            files::put(conn, id, &agree(sha256, record_sha256), now_ms)?;
            Settled::FileWritten
        } else if let Some(scene) = on_disk {
            if record_changed {
                let copy = self.conflict_copy(conn, canvas, &document, now_ms)?;
                let sha256 = self.write_record_scene(canvas, &path, &document.sha256)?;
                files::put(conn, id, &agree(sha256, record_sha256), now_ms)?;
                Settled::ConflictCopy(Box::new(copy))
            } else {
                let edit = CanvasEdit {
                    scene: Some(&scene),
                    folder: refile,
                    ..CanvasEdit::default()
                };
                canvas::update(conn, id, &edit, self.canvases.device_id(), now_ms)?;
                let row = agree(document.sha256.clone(), files::scene_sha256(&scene));
                files::put(conn, id, &row, now_ms)?;
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

    /// Indexes the edges of the conflict copy a settle made, if it made one.
    pub(super) fn index_settled_copy(&self, settled: &Settled) -> Result<(), CanvasError> {
        match settled {
            Settled::ConflictCopy(copy) => {
                self.rewrite_edges(&copy.canvas.summary.id, &copy.canvas.scene)
            }
            _ => Ok(()),
        }
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
