//! The full pass: every row against the disk (`rescan` of `vault/watcher.ts`). Runs when the
//! watcher starts (files removed or moved while the app was closed), after an OS event
//! overflow, and when a vault that was away returns.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use super::event::VaultEvent;
use super::gone::{is_gone_from_disk, is_vault_reachable};
use super::home::{Home, home_of_row};
use super::reconcile::{Probe, Reconciler, modified_ms, probe};
use super::rename::{Pending, observed};
use crate::vault::walk::walk_vault_with;
use memry_core::api::errors::StorageError;

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
        // Each note where it was last reported, else where its row says: a move already
        // reported leaves the row stale, and a removal already reported leaves nothing to
        // remove again.
        let homes: Vec<Home> = rows
            .iter()
            .filter_map(|row| home_of_row(&self.reported, row))
            .collect();
        let candidates: HashSet<&str> = rows.iter().map(|r| r.note_id.as_str()).collect();
        let mut known: HashSet<String> = self
            .files
            .list_paths()?
            .into_iter()
            .filter(|(note_id, _)| !candidates.contains(note_id.as_str()))
            .map(|(_, path)| path)
            .collect();
        known.extend(homes.iter().map(|home| home.path.clone()));
        let walk = walk_vault_with(&self.root, &self.exclude, self.limits);
        let listed: HashSet<&str> = walk.files.iter().map(String::as_str).collect();

        let mut missing: Vec<&Home> = Vec::new();
        for home in &homes {
            if stop.load(Ordering::Relaxed) {
                return Ok(false);
            }
            if listed.contains(home.path.as_str()) || under_any(&home.path, &walk.unreadable) {
                continue;
            }
            // The walk skips hidden, excluded and unreadable places; the disk has the last word.
            if is_gone_from_disk(&self.root.join(&home.path)) {
                missing.push(home);
            }
        }
        let added: Vec<&String> = walk.files.iter().filter(|p| !known.contains(*p)).collect();
        // A partial walk cannot say what is gone, so it never drives a delete.
        let cut_short = walk.truncated.is_some() || walk.too_deep > 0;
        let mass = missing.len() > MASS_REMOVAL_MIN_COUNT
            && missing.len() as f64 > homes.len() as f64 * MASS_REMOVAL_MIN_SHARE;
        let withheld = cut_short || mass;
        if withheld {
            tracing::warn!(
                scope = "vault_watch",
                missing = missing.len(),
                checked = homes.len(),
                cut_short,
                "too many files are missing at once; reporting no removals until the next open"
            );
        }

        // With nothing missing no add can be a rename, and the open's index walk lists adds.
        // The pass still ends with its signal: the consumer orders its own open walk after it.
        if missing.is_empty() && !with_changes {
            self.rescans.push(RescanReport {
                event: VaultEvent::Rescanned {
                    missing: 0,
                    removed: 0,
                    added: added.len(),
                    changed: 0,
                    removals_withheld: withheld,
                },
                waiting_notes: HashSet::new(),
                waiting_paths: HashMap::new(),
            });
            self.report_settled_rescans();
            return Ok(true);
        }
        // Edited since indexed: a later modification time, or another size. An edit that keeps
        // both (a sync tool restoring times, a same-length change) is not seen here; reading
        // every file for it would cost a vault-sized read on every rescan.
        let changed: Vec<&Home> = if with_changes {
            homes
                .iter()
                .filter(|home| listed.contains(home.path.as_str()))
                .filter(|home| {
                    std::fs::metadata(self.root.join(&home.path)).is_ok_and(|m| {
                        modified_ms(&m) > home.indexed_at
                            || home
                                .size
                                .is_some_and(|size| i64::try_from(m.len()) != Ok(size))
                    })
                })
                .collect()
        } else {
            Vec::new()
        };

        let batch = self.tracker.new_batch();
        for home in &missing {
            self.tracker
                .track((*home).clone().pending(), observed(now), Some(batch));
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
        // What no add claimed is a delete like any other: it waits out the rename window and is
        // checked against the disk again before it is reported, so a pass that ran while a
        // checkout or a copy was in the middle of the vault reports nothing it undoes.
        let mut waiting_notes = HashSet::new();
        if !withheld {
            for pending in self.tracker.settle(batch) {
                waiting_notes.insert(pending.note_id.clone());
                self.track_removal(pending, now);
            }
        } else {
            self.tracker.settle(batch);
        }
        for home in &changed {
            if stop.load(Ordering::Relaxed) {
                return Ok(false);
            }
            if let Probe::File(meta) = probe(&self.root.join(&home.path)) {
                self.file_present(&home.path, &meta, now);
            }
        }
        self.rescans.push(RescanReport {
            event: VaultEvent::Rescanned {
                missing: missing.len(),
                removed: 0,
                added: added.len(),
                changed: changed.len(),
                removals_withheld: withheld,
            },
            waiting_notes,
            waiting_paths: self
                .held_adds
                .iter()
                .map(|a| (a.path.clone(), a.due))
                .collect(),
        });
        self.report_settled_rescans();
        Ok(true)
    }

    /// Tracks a delete found by a rescan. Every delete, live or found by a pass over the vault,
    /// waits out the rename window and is re-checked against the disk when it ends: a vault
    /// mid-checkout looks like a mass delete for a moment, and a delete that did not stay gone
    /// is not reported. The window starts here, after the pass looked at the disk, not when the
    /// pass began ([`observed`]).
    fn track_removal(&mut self, pending: Pending, started: Instant) {
        self.tracker.track(pending, observed(started), None);
    }

    pub(super) fn count_removed(&mut self, note_id: &str) {
        for report in &mut self.rescans {
            if report.waiting_notes.contains(note_id)
                && let VaultEvent::Rescanned { removed, .. } = &mut report.event
            {
                *removed += 1;
            }
        }
    }

    /// Emits, in the order the passes ran, the `Rescanned` of every pass whose deletes have
    /// settled and whose held new files are out of the grace they had when it ended, so nothing
    /// the pass found arrives after it. A file held again since (a writer still rewriting it)
    /// is news after the pass and does not hold its signal back.
    pub(super) fn report_settled_rescans(&mut self) {
        let settled = self
            .rescans
            .iter()
            .take_while(|report| {
                !report
                    .waiting_notes
                    .iter()
                    .any(|note| self.tracker.has_note(note))
                    && !self.held_adds.iter().any(|add| {
                        report
                            .waiting_paths
                            .get(&add.path)
                            .is_some_and(|due| add.due <= *due)
                    })
            })
            .count();
        for report in self.rescans.drain(..settled).collect::<Vec<_>>() {
            self.emit(report.event);
        }
    }
}

/// A finished pass whose `Rescanned` waits for what it found to settle.
pub(super) struct RescanReport {
    event: VaultEvent,
    waiting_notes: HashSet<String>,
    /// Each held new file and the end of the grace it had when the pass ended.
    waiting_paths: HashMap<String, Instant>,
}

/// Whether `path` is inside one of the folders (vault-relative, `/`-separated).
fn under_any(path: &str, folders: &[String]) -> bool {
    folders
        .iter()
        .any(|f| f.is_empty() || path.starts_with(&format!("{f}/")))
}
