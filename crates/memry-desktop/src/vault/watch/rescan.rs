//! The full pass: every row against the disk (`rescan` of `vault/watcher.ts`). Runs when the
//! watcher starts (files removed or moved while the app was closed), after an OS event
//! overflow, and when a vault that was away returns.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use memry_core::api::errors::StorageError;
use memry_core::domain::note_files::NoteFile;

use super::event::VaultEvent;
use super::gone::{is_gone_from_disk, is_vault_reachable};
use super::reconcile::{Probe, Reconciler, modified_ms, pending_of, probe};
use crate::vault::walk::walk_vault_with;

/// A rescan that finds this many files missing at once, and more than this share of the rows,
/// reports none of their removals. A half-copied or half-restored vault (`.memry/` landed, most
/// files not yet) looks exactly like a mass delete, and a synced delete unlinks the files on
/// every device. The floor keeps a small vault's ordinary cleanup flowing; the share keeps a
/// large vault's folder delete flowing.
pub const MASS_REMOVAL_MIN_COUNT: usize = 20;
pub const MASS_REMOVAL_MIN_SHARE: f64 = 0.25;

impl Reconciler {
    /// `with_changes` also reports files edited since they were indexed (the open's index walk
    /// covers that at open). Returns `false` when stopped partway; a stopped pass reports no
    /// removal.
    pub fn rescan(
        &mut self,
        with_changes: bool,
        now: Instant,
        stop: &AtomicBool,
    ) -> Result<bool, StorageError> {
        if !is_vault_reachable(&self.root) {
            self.go_away();
            return Ok(true);
        }
        let rows = self.files.list_missing_candidates()?;
        let known: HashSet<String> = self
            .files
            .list_paths()?
            .into_iter()
            .map(|(_, path)| path)
            .collect();
        let walk = walk_vault_with(&self.root, &self.exclude, self.limits);
        let listed: HashSet<&str> = walk.files.iter().map(String::as_str).collect();

        let mut missing: Vec<&NoteFile> = Vec::new();
        for row in &rows {
            if stop.load(Ordering::Relaxed) {
                return Ok(false);
            }
            if listed.contains(row.path.as_str()) || under_any(&row.path, &walk.unreadable) {
                continue;
            }
            // The walk skips hidden, excluded and unreadable places; the disk has the last word.
            if is_gone_from_disk(&self.root.join(&row.path)) {
                missing.push(row);
            }
        }
        let added: Vec<&String> = walk.files.iter().filter(|p| !known.contains(*p)).collect();
        // A partial walk cannot say what is gone, so it never drives a delete.
        let cut_short = walk.truncated.is_some() || walk.too_deep > 0;
        let mass = missing.len() > MASS_REMOVAL_MIN_COUNT
            && missing.len() as f64 > rows.len() as f64 * MASS_REMOVAL_MIN_SHARE;
        let withheld = cut_short || mass;
        if withheld {
            tracing::warn!(
                scope = "vault_watch",
                missing = missing.len(),
                checked = rows.len(),
                cut_short,
                "too many files are missing at once; reporting no removals until the next open"
            );
        }

        // With nothing missing no add can be a rename, and the open's index walk lists adds.
        if missing.is_empty() && !with_changes {
            return Ok(true);
        }
        let changed: Vec<&NoteFile> = if with_changes {
            rows.iter()
                .filter(|row| listed.contains(row.path.as_str()))
                .filter(|row| {
                    std::fs::metadata(self.root.join(&row.path))
                        .is_ok_and(|m| modified_ms(&m) > row.indexed_at)
                })
                .collect()
        } else {
            Vec::new()
        };

        let batch = self.tracker.new_batch();
        for row in &missing {
            self.tracker
                .track(pending_of((*row).clone()), now, Some(batch));
        }
        for path in &added {
            if stop.load(Ordering::Relaxed) {
                self.tracker.discard(batch);
                return Ok(false);
            }
            if let Probe::File(meta) = probe(&self.root.join(path.as_str())) {
                self.file_present(path, &meta, now);
            }
        }
        let unclaimed = self.tracker.settle(batch);
        if !withheld {
            for pending in unclaimed {
                self.confirm_removed(pending);
            }
        }
        for row in &changed {
            if stop.load(Ordering::Relaxed) {
                return Ok(false);
            }
            if let Probe::File(meta) = probe(&self.root.join(&row.path)) {
                self.file_present(&row.path, &meta, now);
            }
        }
        self.emit(VaultEvent::Rescanned {
            missing: missing.len(),
            added: added.len(),
            changed: changed.len(),
            removals_withheld: withheld,
        });
        Ok(true)
    }
}

/// Whether `path` is inside one of the folders (vault-relative, `/`-separated).
fn under_any(path: &str, folders: &[String]) -> bool {
    folders
        .iter()
        .any(|f| f.is_empty() || path.starts_with(&format!("{f}/")))
}
