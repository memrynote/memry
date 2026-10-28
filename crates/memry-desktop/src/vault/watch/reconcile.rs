//! Turns "this path was touched" into facts, by comparing the disk with what was last
//! reported and with `note_files` (`handleFileAdd`, `handleFileChange`, `handleFileDelete` of
//! `vault/watcher.ts`; the rescan is in `rescan`).
//!
//! The OS event kind is never trusted: after the debounce the path is looked at and what is
//! there decides. A rename arrives as two touched paths in no fixed order, so removals are
//! handled first within a batch, and a new file is held for [`ADD_GRACE`] so a removal that
//! becomes known a moment later still pairs with it. The reconciler reads `note_files` and the
//! files and changes neither.
//!
//! Invariants, each with a test in `tests/vault_watch.rs` and `tests/vault_watch_reported.rs`:
//! - No event contradicts an earlier one. A removal, a rescan and a rename pairing read what was
//!   reported (`reported`, through `home`) before the row, which no consumer has updated yet.
//! - A file whose content differs from what was last reported, or from its row when nothing was
//!   reported, is always reported, whatever the own-write record says: that record absorbs only
//!   content equal to what the app wrote.
//! - A removal is reported only after the rename window, with the vault reachable and the file
//!   (and its iCloud placeholder) absent, whatever found it: an OS event, a respelled path or a
//!   rescan of any kind. `confirm_removed` is the only exit and only `settle_expired` reaches it.
//!   A delete that did not stay gone, or a note that was respelled in place, is never reported.
//!   Each window starts when its own absence was observed ([`observed`]). A rescan withholds
//!   removals when too many are missing at once or the walk was cut short, and reports
//!   `Rescanned` once the windows it opened are over, in the order the passes ran: after what
//!   it found, and never later than its end plus the longer window, whatever writers do.
//! - A gone path is the delete of the note at that spelling only: a note found under another
//!   spelling whose own file is still listed is a different file (`home::homes_gone_at`).
//! - A removal that pairs with a new file by content hash is a rename, never a delete plus a new
//!   file; a note whose row has no hash is never paired. A rename is reported once.
//! - Every markdown file is read by hash, streamed, on the watcher's thread; a file that cannot
//!   be read is reported unreadable and left alone.

use std::collections::HashMap;
use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use memry_core::api::errors::StorageError;
use memry_core::api::note_files::NoteFiles;
use memry_core::domain::note_files::NoteFile;

use super::echo::EchoGuard;
use super::event::{EventSink, VaultEvent};
use super::filter::WatchFilter;
use super::gone::{is_gone_from_disk, is_vault_reachable};
use super::home::{Home, spelling_listed};
use super::rename::{Pending, RenameTracker, observed};
use super::reported::{Reported, Seen};
use super::rescan::RescanReport;
use crate::vault::file_types::{FileType, extension, file_type_of_extension};
use crate::vault::note_file::hash_file;
use crate::vault::walk::{Limits, walk_from};

/// How long a new markdown file waits before it is reported as new. The OS reports the two
/// halves of a move in no fixed order and the debounce releases paths a few milliseconds
/// apart, so a file can show up before the removal it pairs with is known.
pub const ADD_GRACE: Duration = Duration::from_millis(300);
/// Files held at once; past this a new file is reported at once and loses only the late pairing.
pub const MAX_HELD_ADDS: usize = 10_000;

pub(super) struct HeldAdd {
    pub(super) path: String,
    file_type: FileType,
    size: u64,
    modified_ms: i64,
    hash: Option<String>,
    pub(super) due: Instant,
}

pub struct Reconciler {
    pub(super) root: PathBuf,
    pub(super) exclude: Vec<String>,
    filter: WatchFilter,
    pub(super) files: NoteFiles,
    pub(super) tracker: RenameTracker,
    echo: Arc<EchoGuard>,
    sink: EventSink,
    away: bool,
    /// A bounded step stopped short (a folder walk): a full rescan owes the rest.
    rescan_owed: bool,
    /// Every row, loaded at most once per batch: a vanished folder needs them all.
    pub(super) all_rows: Option<Vec<NoteFile>>,
    /// `all_rows` by folded path, built at most once per batch.
    pub(super) folded: Option<HashMap<String, Vec<usize>>>,
    pub(super) limits: Limits,
    pub(super) held_adds: Vec<HeldAdd>,
    /// Rescans whose `Rescanned` waits for their deletes and held adds.
    pub(super) rescans: Vec<RescanReport>,
    pub(super) reported: Reported,
    /// Set when the watcher stops: long steps (a folder of a million files) end early and
    /// report nothing more.
    stop: Arc<AtomicBool>,
}

pub(super) enum Probe {
    Gone,
    Dir,
    File(Metadata),
    /// A link, a device, or a path that could not be looked at: left alone.
    Skip,
}

pub(super) fn probe(path: &Path) -> Probe {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => Probe::Dir,
        Ok(meta) if meta.is_file() => Probe::File(meta),
        Ok(_) => Probe::Skip,
        Err(_) if is_gone_from_disk(path) => Probe::Gone,
        Err(_) => Probe::Skip,
    }
}

pub(super) fn modified_ms(meta: &Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

impl Reconciler {
    pub fn new(
        root: PathBuf,
        exclude: Vec<String>,
        files: NoteFiles,
        echo: Arc<EchoGuard>,
        sink: EventSink,
    ) -> Self {
        Self {
            filter: WatchFilter::new(exclude.clone()),
            root,
            exclude,
            files,
            tracker: RenameTracker::default(),
            echo,
            sink,
            away: false,
            rescan_owed: false,
            all_rows: None,
            folded: None,
            limits: Limits::DEFAULT,
            held_adds: Vec::new(),
            rescans: Vec::new(),
            reported: Reported::default(),
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Ends every step early once `stop` is set.
    #[must_use]
    pub fn with_stop(mut self, stop: Arc<AtomicBool>) -> Self {
        self.stop = stop;
        self
    }

    pub(super) fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    /// The step bounds of the folder walks (the defaults are the vault walk's).
    #[must_use]
    pub fn with_limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }

    pub fn is_away(&self) -> bool {
        self.away
    }

    pub fn take_rescan_owed(&mut self) -> bool {
        std::mem::take(&mut self.rescan_owed)
    }

    pub fn clear(&mut self) {
        self.tracker.clear();
        self.held_adds.clear();
        self.rescans.clear();
    }

    pub(super) fn emit(&self, event: VaultEvent) {
        (self.sink)(event);
    }

    /// The vault left: every removal reported from here on would be false. Pending deletes
    /// are dropped, so none settles; the rescan on return finds what is really gone.
    pub fn go_away(&mut self) {
        if !self.away {
            self.away = true;
            self.clear();
            tracing::warn!(
                scope = "vault_watch",
                "the vault is unreachable; removals are ignored"
            );
            self.emit(VaultEvent::Unreachable);
        }
    }

    pub fn come_back(&mut self) {
        if self.away {
            self.away = false;
            self.emit(VaultEvent::Reachable);
        }
    }

    pub(super) fn storage_failed(&self, error: &StorageError) {
        tracing::error!(
            scope = "vault_watch",
            "note_files could not be read: {error}"
        );
        self.emit(VaultEvent::WatchFailed {
            message: error.to_string(),
            limit: false,
        });
    }

    /// The root itself was touched: if it is gone the vault is away.
    pub fn check_reachable(&mut self) {
        if !is_vault_reachable(&self.root) {
            self.go_away();
        }
    }

    /// One debounced batch of vault-relative paths. Vanished paths first, then folders, then
    /// files, so a moved file finds the delete it pairs with.
    pub fn batch(&mut self, rels: Vec<String>, now: Instant) {
        self.all_rows = None;
        self.folded = None;
        let mut dirs = Vec::new();
        let mut present = Vec::new();
        for rel in rels {
            if self.stopped() {
                return;
            }
            if self.filter.ignores(&rel) {
                continue;
            }
            match probe(&self.root.join(&rel)) {
                Probe::Gone => self.vanished(&rel, now),
                Probe::Dir => dirs.push(rel),
                Probe::File(meta) => present.push((rel, meta)),
                Probe::Skip => {}
            }
        }
        if self.away {
            return;
        }
        for rel in dirs {
            self.dir_appeared(&rel, now);
        }
        for (rel, meta) in present {
            if self.stopped() {
                return;
            }
            self.file_present(&rel, &meta, now);
        }
        self.resolve_adds(now);
    }

    fn vanished(&mut self, rel: &str, now: Instant) {
        if !is_vault_reachable(&self.root) {
            self.go_away();
            return;
        }
        // A file created and removed inside the grace is history now.
        let below = format!("{rel}/");
        self.held_adds
            .retain(|a| a.path != rel && !a.path.starts_with(&below));
        if self.echo.absorbs_removal(rel) {
            self.reported.forget_tree(rel);
            return;
        }
        let homes = match self.homes_gone_at(rel) {
            Ok(homes) => homes,
            Err(error) => return self.storage_failed(&error),
        };
        // What was reported for a note stays until its removal settles: it names where the note
        // lives, which the rows may not know. Entries that name no note have nothing to remove.
        self.reported.forget_unowned_tree(rel);
        for home in homes {
            self.tracker.track(home.pending(), observed(now), None);
        }
    }

    /// Settles the live deletes whose rename window is over, and the held new files whose
    /// grace is.
    pub fn settle_expired(&mut self, now: Instant) {
        if self.away {
            return;
        }
        self.resolve_adds(now);
        for pending in self.tracker.expired(now) {
            self.confirm_removed(pending);
        }
        self.report_settled_rescans(now);
    }

    /// The one place a `Removed` leaves the reconciler, reached only from [`Self::settle_expired`]:
    /// the window is over, and the file and the vault are checked again.
    fn confirm_removed(&mut self, pending: Pending) {
        if !is_vault_reachable(&self.root) {
            self.go_away();
            return;
        }
        if !is_gone_from_disk(&self.root.join(&pending.path)) {
            tracing::info!(
                scope = "vault_watch",
                "an unlinked file is still there; keeping it"
            );
            return;
        }
        self.reported.forget_note(&pending.note_id);
        match self.files.by_id(&pending.note_id) {
            Ok(Some(row)) => self.reported.mark_removed(&row),
            Ok(None) => {}
            Err(error) => return self.storage_failed(&error),
        }
        self.count_removed(&pending.note_id);
        self.emit(VaultEvent::Removed {
            note_id: pending.note_id,
            path: pending.path,
        });
    }

    /// A folder showed up (created or moved in): every file under it counts as touched.
    fn dir_appeared(&mut self, rel: &str, now: Instant) {
        let walk = walk_from(&self.root, rel, &self.exclude, self.limits);
        if walk.truncated.is_some() || walk.too_deep > 0 {
            self.rescan_owed = true;
        }
        // The OS may not have armed the new folder's watch before a file landed in it, so the
        // walk is the only report of that file: unsupported ones too.
        for path in walk.unsupported {
            if !self.filter.ignores(&path) {
                self.emit(VaultEvent::Unsupported { path });
            }
        }
        for path in walk.files {
            if self.stopped() {
                return;
            }
            if self.filter.ignores(&path) {
                continue;
            }
            if let Probe::File(meta) = probe(&self.root.join(&path)) {
                self.file_present(&path, &meta, now);
            }
        }
    }

    pub(super) fn file_present(&mut self, rel: &str, meta: &Metadata, now: Instant) {
        if self.stopped() {
            return;
        }
        if !self.filter.takes_file(rel) {
            if !self.filter.ignores(rel) && file_type_of_extension(&extension(rel)).is_none() {
                self.emit(VaultEvent::Unsupported {
                    path: rel.to_owned(),
                });
            }
            return;
        }
        let Some(file_type) = file_type_of_extension(&extension(rel)) else {
            return;
        };
        let (size, modified) = (meta.len(), modified_ms(meta));
        let stat = (size, modified);
        let is_markdown = file_type == FileType::Markdown;

        let hash = if is_markdown {
            match hash_file(&self.root, rel) {
                Ok(Some(hash)) => Some(hash),
                // It went between the probe and the read.
                Ok(None) => return self.vanished(rel, now),
                Err(error) => {
                    self.emit(VaultEvent::Unreadable {
                        path: rel.to_owned(),
                        reason: error.to_string(),
                    });
                    return;
                }
            }
        } else {
            self.echo.seen_present(rel);
            None
        };
        if let Some(hash) = &hash
            && self.echo.absorbs_write(rel, hash)
        {
            // The app's write is the state now: an outside edit back to what was reported
            // before it must not read as "unchanged". Only the cheap lookups run here: the
            // app's own writes are the common case and must not scan the table.
            let note_id = self.known_note(rel);
            self.reported.put(Seen {
                path: rel.to_owned(),
                hash: Some(hash.clone()),
                stat,
                note_id,
            });
            return;
        }
        let home = match self.home_at(rel) {
            Ok(home) => home,
            Err(error) => return self.storage_failed(&error),
        };
        let home = match home {
            Some(home) if home.path != rel => self.respelled(home, rel, hash.as_deref(), stat),
            home => home,
        };
        // The baseline is what was last reported, else the row. Comparing with the row alone
        // would repeat a report until a consumer updated it, and would miss an edit that
        // returns the file to the row's old content.
        let seen = self.reported.get(rel).cloned();
        let unchanged = if is_markdown {
            let known_hash = match (&seen, &home) {
                (Some(seen), _) => seen.hash.as_ref(),
                (None, Some(home)) => home.hash.as_ref(),
                (None, None) => None,
            };
            hash.is_some() && known_hash == hash.as_ref()
        } else {
            match (&seen, &home) {
                (Some(seen), _) => seen.stat == stat,
                (None, Some(home)) => {
                    home.size == i64::try_from(size).ok() && modified <= home.indexed_at
                }
                (None, None) => false,
            }
        };
        if unchanged {
            return;
        }
        if let Some(home) = home {
            self.reported.put(Seen {
                path: rel.to_owned(),
                hash: hash.clone(),
                stat,
                note_id: Some(home.note_id.clone()),
            });
            self.emit(VaultEvent::Changed {
                note_id: home.note_id,
                path: rel.to_owned(),
                content_hash: hash,
                size,
                modified_ms: modified,
            });
            return;
        }
        self.unknown_file(rel, file_type, hash, stat, now);
    }

    /// The note named at `rel` by a report or by its row at exactly that path, without the
    /// folded lookup.
    fn known_note(&self, rel: &str) -> Option<String> {
        if let Some(seen) = self.reported.get(rel) {
            return seen.note_id.clone();
        }
        let row = self.files.by_path(rel).ok().flatten()?;
        super::home::home_of_row(&self.reported, &row).map(|home| home.note_id)
    }

    /// `home` is the same file as `rel` under another case or normalization: the volume
    /// reports the spelling the file was last given. A rename, unless the old spelling is
    /// still an entry of its folder (two files on a case-sensitive volume), which leaves `rel`
    /// a file of its own.
    fn respelled(
        &mut self,
        home: Home,
        rel: &str,
        hash: Option<&str>,
        stat: (u64, i64),
    ) -> Option<Home> {
        if spelling_listed(&self.root, &home.path) {
            return None;
        }
        // The old spelling is not a delete: the file is the same note under a new one. A removal
        // tracked for it in this batch (a volume that reports both paths) would settle into a
        // `Removed` after this `Renamed`.
        self.tracker.drop_note(&home.note_id);
        self.reported.put(Seen {
            path: rel.to_owned(),
            // The content baseline stays the old one: an edit with the move is still a change.
            hash: if hash.is_some() {
                home.hash.clone()
            } else {
                None
            },
            stat,
            note_id: Some(home.note_id.clone()),
        });
        self.emit(VaultEvent::Renamed {
            note_id: home.note_id.clone(),
            old_path: home.path.clone(),
            new_path: rel.to_owned(),
            content_hash: hash.map(str::to_owned),
        });
        Some(Home {
            path: rel.to_owned(),
            ..home
        })
    }

    fn unknown_file(
        &mut self,
        rel: &str,
        file_type: FileType,
        hash: Option<String>,
        stat: (u64, i64),
        now: Instant,
    ) {
        // Only markdown pairs: Electron's non-markdown add path never looks for a rename.
        if let Some(hash) = &hash
            && let Some(from) = self.tracker.claim(hash)
        {
            self.report_rename(from, rel.to_owned(), hash.clone(), stat);
            return;
        }
        if hash.is_some() && self.held_adds.len() < MAX_HELD_ADDS {
            self.held_adds.retain(|a| a.path != rel);
            self.held_adds.push(HeldAdd {
                path: rel.to_owned(),
                file_type,
                size: stat.0,
                modified_ms: stat.1,
                hash,
                due: observed(now) + ADD_GRACE,
            });
            return;
        }
        self.report_added(rel.to_owned(), file_type, stat, hash);
    }

    fn report_rename(&mut self, from: Pending, to: String, hash: String, stat: (u64, i64)) {
        self.reported.remove(&from.path);
        self.reported.put(Seen {
            path: to.clone(),
            hash: Some(hash.clone()),
            stat,
            note_id: Some(from.note_id.clone()),
        });
        self.emit(VaultEvent::Renamed {
            note_id: from.note_id,
            old_path: from.path,
            new_path: to,
            content_hash: Some(hash),
        });
    }

    fn report_added(
        &mut self,
        path: String,
        file_type: FileType,
        stat: (u64, i64),
        hash: Option<String>,
    ) {
        self.reported.put(Seen {
            path: path.clone(),
            hash: hash.clone(),
            stat,
            note_id: None,
        });
        self.emit(VaultEvent::Added {
            path,
            file_type,
            size: stat.0,
            modified_ms: stat.1,
            content_hash: hash,
        });
    }

    /// Reports the held new files whose grace is over, and pairs the rest with removals that
    /// became known after them.
    fn resolve_adds(&mut self, now: Instant) {
        for add in std::mem::take(&mut self.held_adds) {
            let stat = (add.size, add.modified_ms);
            let claimed = add.hash.as_ref().and_then(|h| self.tracker.claim(h));
            if let (Some(from), Some(hash)) = (claimed, &add.hash) {
                self.report_rename(from, add.path, hash.clone(), stat);
            } else if add.due <= now {
                if std::fs::symlink_metadata(self.root.join(&add.path)).is_ok() {
                    self.report_added(add.path, add.file_type, stat, add.hash);
                }
            } else {
                self.held_adds.push(add);
            }
        }
    }
}
