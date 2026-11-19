//! A canvas document removed outside the app becomes a canvas delete (Electron's
//! `canvas/delete.ts::trackExternalCanvasRemoval`): the vault watcher reports the removed path
//! once its rename window is over ([`crate::vault::watch::VaultEvent::CanvasGone`]), and the
//! vault-open reconcile replays the removals made while the app was closed
//! (`vault/watcher.ts:503-560`).
//!
//! The tombstone syncs to every device, so every doubt keeps the canvas: the vault must be
//! reachable, the document (and its iCloud placeholder) absent, and no document under
//! `canvases/` that no other live canvas owns may carry its id or be unreadable. A document moved
//! or renamed outside the app is therefore never a delete; the next open's reconcile re-points
//! the canvas to it, as in Electron. The check and the tombstone run in one writer call, so a
//! save, which writes its document inside the writer, either lands first and keeps the canvas
//! or finds it deleted.

use std::collections::HashSet;
use std::sync::Arc;

use memry_core::domain::canvas::file_format::read_file_meta;
use memry_core::domain::canvas::folder_paths::canvas_path_key;
use memry_core::domain::canvas::{self, edges};
use memry_core::seams::secure_store::SecureStore;
use rusqlite::Connection;

use super::files;
use super::reconcile::{Reconciled, now_ms};
use super::scene_file::{list_canvas_files, read_canvas_file, resolve_canvas_file};
use super::service::{CanvasError, CanvasService};
use crate::session::OpenVault;
use crate::vault::consumer::CanvasGone;
use crate::vault::watch::gone::{is_gone_from_disk, is_vault_reachable};
use crate::vault::watch::{MASS_REMOVAL_MIN_COUNT, MASS_REMOVAL_MIN_SHARE};

const SCOPE: &str = "CanvasWatch";

/// The watcher's hook: each canvas a removed path deleted is handed to `deleted` (the
/// renderer's `canvas:deleted`).
pub fn gone_hook(
    store: Arc<dyn SecureStore>,
    deleted: Arc<dyn Fn(String) + Send + Sync>,
) -> CanvasGone {
    Arc::new(move |view: &OpenVault, path: &str| {
        let service = match CanvasService::open(view, store.clone()) {
            Ok(service) => service,
            Err(error) => {
                tracing::error!(scope = SCOPE, %error, "a canvas removed outside the app was kept: no canvas store");
                return;
            }
        };
        match service.removed_outside(path, now_ms()) {
            Ok(ids) => ids.into_iter().for_each(|id| deleted(id)),
            Err(error) => {
                tracing::error!(scope = SCOPE, %error, "a canvas removed outside the app was kept")
            }
        }
    })
}

impl CanvasService {
    /// Deletes each live canvas whose document was at `path`, or under it when `path` was a
    /// folder, and is gone for good. Returns the ids deleted.
    pub fn removed_outside(&self, path: &str, now_ms: i64) -> Result<Vec<String>, CanvasError> {
        if !is_vault_reachable(&self.vault) {
            return Ok(Vec::new());
        }
        let key = canvas_path_key(path);
        let below = format!("{key}/");
        let mut deleted = Vec::new();
        for (id, at) in self.write(live_documents)? {
            let at_key = canvas_path_key(&at);
            if (at_key == key || at_key.starts_with(&below))
                && self.delete_gone(&id, &at, now_ms)?
            {
                deleted.push(id);
            }
        }
        Ok(deleted)
    }

    /// Vault open: every live canvas whose document this device had and is gone now, as a live
    /// unlink would have deleted it. Too many gone at once (a half-copied or half-restored
    /// vault looks like a mass delete) deletes none, as the watcher's rescan withholds them.
    pub(super) fn replay_missed_removals(
        &self,
        now_ms: i64,
        done: &mut Reconciled,
    ) -> Result<(), CanvasError> {
        if !is_vault_reachable(&self.vault) {
            return Ok(());
        }
        let rows = self.write(live_documents)?;
        let missing: Vec<&(String, String)> = rows
            .iter()
            .filter(|(_, at)| self.document_gone(at))
            .collect();
        if missing.len() > MASS_REMOVAL_MIN_COUNT
            && missing.len() as f64 > rows.len() as f64 * MASS_REMOVAL_MIN_SHARE
        {
            tracing::warn!(
                scope = SCOPE,
                missing = missing.len(),
                checked = rows.len(),
                "too many canvas documents are missing at once; deleting none until the next open"
            );
            done.removals_withheld = true;
            return Ok(());
        }
        for (id, at) in missing {
            if self.delete_gone(id, at, now_ms)? {
                done.removed += 1;
            }
        }
        Ok(())
    }

    /// Tombstones canvas `id` if its document is still the one at `at` and still gone, and no
    /// document may still be it. `false` when it was kept.
    fn delete_gone(&self, id: &str, at: &str, now_ms: i64) -> Result<bool, CanvasError> {
        let deleted = self.write::<_, CanvasError>(|conn| {
            // The app or a sync apply moved it meanwhile and re-pointed the row.
            if files::get(conn, id)?.is_none_or(|row| row.path != at)
                || !self.document_gone(at)
                || self.may_still_hold(conn, id)?
            {
                return Ok(false);
            }
            Ok(canvas::delete(conn, id, self.canvases.device_id(), now_ms)?)
        })?;
        if deleted {
            self.index.call_blocking(|index| edges::clear(index, id))?;
            self.release_removed(&[id.to_owned()])?;
        }
        Ok(deleted)
    }

    /// Absent from a reachable vault. A path that resolves outside the vault is never gone.
    fn document_gone(&self, at: &str) -> bool {
        resolve_canvas_file(&self.vault, at).is_ok_and(|absolute| is_gone_from_disk(&absolute))
    }

    /// Whether a document under `canvases/` that no other live canvas owns may still be canvas
    /// `id` (`mayStillHoldCanvas`): it carries the id, or it cannot be read or parsed. Only a
    /// positive absence of the id deletes.
    fn may_still_hold(&self, conn: &Connection, id: &str) -> Result<bool, CanvasError> {
        let owned: HashSet<String> = live_documents(conn)?
            .into_iter()
            .filter(|(other, _)| other != id)
            .map(|(_, at)| canvas_path_key(&at))
            .collect();
        Ok(list_canvas_files(&self.vault)
            .iter()
            .filter(|at| !owned.contains(&canvas_path_key(at)))
            .any(|at| match read_canvas_file(&self.vault, at) {
                Ok(None) => false,
                Ok(Some(document)) => match read_file_meta(&document.text, 0) {
                    Some(meta) => meta.id == id,
                    None => serde_json::from_str::<serde_json::Value>(&document.text).is_err(),
                },
                Err(error) => {
                    tracing::warn!(scope = SCOPE, %error, "a canvas document cannot be read; keeping the removed canvas");
                    true
                }
            }))
    }
}

/// `(canvas_id, document path)` of every live canvas this device keeps a document for.
fn live_documents(conn: &Connection) -> Result<Vec<(String, String)>, CanvasError> {
    Ok(files::all(conn)?
        .into_iter()
        .filter(|(_, _, live)| *live)
        .map(|(id, at, _)| (id, at))
        .collect())
}
