//! `updateCanvas` ([`CanvasService::update`]): the title, placement, icon and scene of a live
//! canvas, with the conflict copy that keeps a document changed on disk since the saver read it.

use std::collections::HashSet;

use memry_core::domain::canvas::file_format::{strip_file_meta, with_file_meta};
use memry_core::domain::canvas::{
    self, Canvas, CanvasEdit, NewCanvas, SyncHold, Updated, canonical_scene,
};
use rusqlite::Connection;

use super::files::{self, FileRow};
use super::scene_file::{
    CanvasDocument, Expect, ReadError, allocate_canvas_path, folder_of_canvas_path,
    rename_canvas_file, write_canvas_file,
};
use super::service::{
    CanvasError, CanvasService, CanvasUpdateInput, Found, Update, Written, file_stem, meta,
    stored_folder, summary,
};
use super::settle::Settled;

impl CanvasService {
    /// `updateCanvas`: the title, placement, icon and scene. A title or folder change moves the
    /// document and the title follows a renumbered file name. A scene saved over bytes other than
    /// the ones its reader got (`expected_sha256`) first keeps them: a drawing as a conflict-copy
    /// canvas, anything else as a file beside it, so the save then writes a new document.
    pub fn update(&self, input: &CanvasUpdateInput, now_ms: i64) -> Result<Update, CanvasError> {
        let scene = input.scene.as_deref().map(canonical_scene).transpose()?;
        let id = input.id.as_str();
        let (outcome, settled) = self.write::<_, CanvasError>(|conn| {
            let Some(canvas) = canvas::get(conn, id)? else {
                return Ok((Update::NotFound, None));
            };
            if input
                .expected_updated_at
                .is_some_and(|expected| expected != canvas.updated_at)
            {
                return Ok((Update::Conflict, None));
            }
            // A scene that reached the record or the document without passing through the
            // reader (a synced edit, an edit on disk) is settled first, so the save cannot
            // overwrite it unseen: it is kept as a conflict copy below.
            let settled = match &scene {
                Some(_) => Some(self.settle_in(conn, &canvas, self.locate(conn, id)?, now_ms)?),
                None => None,
            };
            let stale = settled.as_ref().is_some_and(Settled::scene_changed);
            let canvas = match stale {
                true => canvas::get(conn, id)?.unwrap_or(canvas),
                false => canvas,
            };
            let found = match self.locate(conn, id)? {
                Found::Outside => return Err(ReadError::Outside.into()),
                Found::File { path, document } => Some((path, document)),
                Found::None => None,
            };
            let mut conflict_copy = None;
            // `None` once the document at the path was set aside: the save writes a new one.
            let mut expected = found.as_ref().map(|(_, document)| document.sha256.clone());
            if let (Some(_), Some((path, document))) = (&scene, &found)
                && (stale || input.expected_sha256.as_deref() != Some(document.sha256.as_str()))
            {
                if canonical_scene(&strip_file_meta(&document.text)).is_ok() {
                    conflict_copy = Some(Box::new(
                        self.conflict_copy(conn, &canvas, document, now_ms)?,
                    ));
                } else {
                    self.set_aside(&canvas, path)?;
                    expected = None;
                }
            }

            let mut title = input.title.clone().unwrap_or(canvas.title.clone());
            let mut folder = match &input.folder {
                Some(folder) => stored_folder(conn, folder.as_deref())?,
                None => canvas.folder.clone(),
            };
            let mut moved = false;
            let mut file = None;
            if let Some((path, document)) = found {
                let mut path = path;
                let retitled = input.title.is_some() && title != canvas.title;
                if retitled || folder != canvas.folder {
                    let target = allocate_canvas_path(
                        &self.vault,
                        title.as_deref(),
                        &HashSet::new(),
                        Some(&path),
                        folder.as_deref(),
                    )?;
                    let landed = rename_canvas_file(&self.vault, &path, &target);
                    if landed != path {
                        moved = true;
                        path = landed;
                        if title.is_some() {
                            title = Some(file_stem(&path));
                        }
                    }
                }
                // The record describes where the document is, a failed move included.
                folder = folder_of_canvas_path(&path);
                file = Some((path, document));
            }

            // The document now on disk (the saver's next `expected_sha256`), and the agreement
            // point to record, if this save moved it.
            let agreed = files::get(conn, id)?;
            let (sha256, stamp) = match (&scene, file) {
                (Some(scene), Some((path, _))) => {
                    let text = with_file_meta(scene, &meta(id, canvas.created_at, now_ms));
                    let expect = expected.as_deref().map_or(Expect::New, Expect::Unchanged);
                    let sha256 = write_canvas_file(&self.vault, &path, &text, expect)?;
                    (Some(sha256.clone()), Some(FileRow::unmarked(path, sha256)))
                }
                (Some(scene), None) => {
                    let path = allocate_canvas_path(
                        &self.vault,
                        title.as_deref(),
                        &HashSet::new(),
                        None,
                        folder.as_deref(),
                    )?;
                    folder = folder_of_canvas_path(&path);
                    let text = with_file_meta(scene, &meta(id, canvas.created_at, now_ms));
                    let sha256 = write_canvas_file(&self.vault, &path, &text, Expect::New)?;
                    (Some(sha256.clone()), Some(FileRow::unmarked(path, sha256)))
                }
                (None, Some((path, document))) if moved => {
                    // Refresh the moved document's sidecar, unless its text is not a drawing
                    // (rewriting it would turn it into an empty board).
                    let current = strip_file_meta(&document.text);
                    let sha256 = match canonical_scene(&current) {
                        Ok(_) => write_canvas_file(
                            &self.vault,
                            &path,
                            &with_file_meta(&current, &meta(id, canvas.created_at, now_ms)),
                            Expect::Unchanged(&document.sha256),
                        )?,
                        Err(_) => document.sha256.clone(),
                    };
                    // The agreement follows the document, and its new bytes only when the bytes
                    // moved were the agreed ones: a disk edit no settle has seen stays unseen.
                    let row = agreed.map(|agreed| FileRow {
                        path,
                        sha256: match agreed.sha256 == document.sha256 {
                            true => sha256.clone(),
                            false => agreed.sha256,
                        },
                        record_sha256: agreed.record_sha256,
                    });
                    (Some(sha256), row)
                }
                (None, Some((_, document))) => (Some(document.sha256), None),
                (None, None) => (None, None),
            };

            let edit = CanvasEdit {
                title: (input.title.is_some() || moved).then_some(title.as_deref()),
                folder: (input.folder.is_some() || moved).then_some(folder.as_deref()),
                icon: input.icon.as_ref().map(Option::as_deref),
                scene: scene.as_deref(),
                // Checked above; a settle since has moved `updated_at` on.
                expected_updated_at: input.expected_updated_at.filter(|_| !stale),
            };
            let saved = match canvas::update(conn, id, &edit, self.canvases.device_id(), now_ms)? {
                Updated::Saved(saved) => saved,
                Updated::Conflict => return Ok((Update::Conflict, settled)),
            };
            if let Some(mut row) = stamp {
                // A scene saved: the document and the record now hold the same one.
                if scene.is_some() {
                    row.record_sha256 = Some(files::scene_sha256(&saved.canvas.scene));
                }
                files::put(conn, id, &row, now_ms)?;
            }
            let outcome = Update::Saved {
                too_large: saved.sync != SyncHold::Queued,
                sha256,
                summary: summary(saved.canvas),
                conflict_copy,
            };
            Ok((outcome, settled))
        })?;
        if let Some(settled) = &settled {
            self.index_settled_copy(settled)?;
        }
        if let Update::Saved { conflict_copy, .. } = &outcome {
            if let Some(scene) = &scene {
                self.rewrite_edges(id, scene)?;
            }
            if let Some(copy) = conflict_copy {
                self.rewrite_edges(&copy.canvas.summary.id, &copy.canvas.scene)?;
            }
        }
        Ok(outcome)
    }

    /// Files the drawing found edited on disk as a new canvas beside the original.
    pub(super) fn conflict_copy(
        &self,
        conn: &Connection,
        canvas: &Canvas,
        document: &CanvasDocument,
        now_ms: i64,
    ) -> Result<Written, CanvasError> {
        let scene = strip_file_meta(&document.text);
        let title = conflict_title(canvas);
        tracing::warn!(
            scope = "CanvasStore",
            "a canvas document changed on disk since it was read; keeping it as a conflict copy"
        );
        self.create_in(
            conn,
            &NewCanvas {
                title: Some(&title),
                scene: Some(&scene),
                folder: canvas.folder.as_deref(),
                icon: canvas.icon.as_deref(),
                ..NewCanvas::default()
            },
            now_ms,
        )
    }

    /// Moves a document that is no longer a drawing to `"<title> (conflict copy)"` beside it,
    /// bytes untouched, where Electron would overwrite it. Refuses the save when it cannot move.
    fn set_aside(&self, canvas: &Canvas, path: &str) -> Result<(), CanvasError> {
        let target = allocate_canvas_path(
            &self.vault,
            Some(&conflict_title(canvas)),
            &HashSet::new(),
            None,
            folder_of_canvas_path(path).as_deref(),
        )?;
        if rename_canvas_file(&self.vault, path, &target) == path {
            return Err(CanvasError::ChangedUnreadable);
        }
        tracing::warn!(
            scope = "CanvasStore",
            "a canvas document is no longer a drawing; keeping it beside the saved canvas"
        );
        Ok(())
    }
}

fn conflict_title(canvas: &Canvas) -> String {
    format!(
        "{} (conflict copy)",
        canvas.title.as_deref().unwrap_or("Canvas")
    )
}
