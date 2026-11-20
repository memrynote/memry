//! Canvas documents removed outside the app (`vault/watcher.ts:1199-1210`). The watcher does not
//! read `data.db`, so it reports the removed path under `canvases/`, a file or a folder, once the
//! rename window is over and the path is still gone; the canvas service decides which canvas
//! that deletes. A path put back inside the window (a save, the second half of a move) is never
//! reported.

use std::time::Instant;

use super::event::VaultEvent;
use super::gone::{is_gone_from_disk, is_vault_reachable};
use super::reconcile::Reconciler;
use super::rename::{RENAME_WINDOW, observed};
use crate::vault::layout::CANVAS_DIR;

impl Reconciler {
    /// Opens the window of a removed path under `canvases/` (or of the folder itself).
    pub(super) fn track_canvas_gone(&mut self, rel: &str, now: Instant) {
        if !(rel == CANVAS_DIR
            || rel
                .strip_prefix(CANVAS_DIR)
                .is_some_and(|r| r.starts_with('/')))
        {
            return;
        }
        let due = observed(now) + RENAME_WINDOW;
        self.canvas_gone.retain(|(path, _)| path != rel);
        self.canvas_gone.push((rel.to_owned(), due));
    }

    /// Reports each removed canvas path whose window is over and that is still gone.
    pub(super) fn settle_canvas_gone(&mut self, now: Instant) {
        if self.canvas_gone.iter().all(|(_, due)| *due > now) {
            return;
        }
        if !is_vault_reachable(&self.root) {
            self.go_away();
            return;
        }
        let (due, waiting): (Vec<_>, Vec<_>) = std::mem::take(&mut self.canvas_gone)
            .into_iter()
            .partition(|(_, due)| *due <= now);
        self.canvas_gone = waiting;
        for (path, _) in due {
            if is_gone_from_disk(&self.root.join(&path)) {
                self.emit(VaultEvent::CanvasGone { path });
            }
        }
    }
}
