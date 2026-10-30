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
use super::handle::NewFiles;
use super::rename::{Pending, RenameTracker, observed};
use super::reported::Reported;
use super::rescan::RescanReport;
use crate::vault::file_types::FileType;
use crate::vault::walk::{Limits, walk_from};

/// How long a new markdown file waits before it is reported as new. The OS reports the two
/// halves of a move in no fixed order and the debounce releases paths a few milliseconds
/// apart, so a file can show up before the removal it pairs with is known.
pub const ADD_GRACE: Duration = Duration::from_millis(300);
/// Files held at once; past this a new file is reported at once and loses only the late pairing.
pub const MAX_HELD_ADDS: usize = 10_000;

pub(super) struct HeldAdd {
    pub(super) path: String,
    pub(super) file_type: FileType,
    pub(super) size: u64,
    pub(super) modified_ms: i64,
    pub(super) hash: Option<String>,
    pub(super) due: Instant,
}

pub struct Reconciler {
    pub(super) root: PathBuf,
    pub(super) exclude: Vec<String>,
    pub(super) filter: WatchFilter,
    pub(super) files: NoteFiles,
    pub(super) tracker: RenameTracker,
    pub(super) echo: Arc<EchoGuard>,
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
    pub(super) new_files: NewFiles,
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

pub(crate) fn modified_ms(meta: &Metadata) -> i64 {
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
            new_files: NewFiles::Report,
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Ends every step early once `stop` is set.
    #[must_use]
    pub fn with_stop(mut self, stop: Arc<AtomicBool>) -> Self {
        self.stop = stop;
        self
    }

    #[must_use]
    pub fn with_new_files(mut self, new_files: NewFiles) -> Self {
        self.new_files = new_files;
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

    /// A consumer could not apply what was reported for `rel` (its read found nothing, or
    /// failed) and asks for it again; the next batch looks at the path. A report that named a
    /// note is owed, not erased: while the file is absent, its removal and the pairing of its
    /// move read the bytes last reported, not the row's older ones, and the file, when it is
    /// there, is reported again even with those bytes. Any other report is forgotten, so the
    /// file is looked at as new.
    pub fn forget(&mut self, rel: &str) {
        if self
            .reported
            .get(rel)
            .is_some_and(|seen| seen.note_id.is_some())
        {
            self.reported.owe(rel);
        } else {
            self.reported.remove(rel);
        }
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

    pub(super) fn vanished(&mut self, rel: &str, now: Instant) {
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

    /// A folder showed up (created or moved in): every file under it counts as touched. The
    /// app's removal of a folder at that name, or of one below it that is back with it, is
    /// over, so its going again is not the app's.
    fn dir_appeared(&mut self, rel: &str, now: Instant) {
        let root = &self.root;
        self.echo.seen_folder(rel, |path| {
            std::fs::symlink_metadata(root.join(path)).is_ok()
        });
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
}
