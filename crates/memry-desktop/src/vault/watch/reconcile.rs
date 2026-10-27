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
//! Invariants, each with a test in `tests/vault_watch.rs`:
//! - A file whose content differs from what was last reported, or from its row when nothing was
//!   reported, is always reported, whatever the own-write record says: that record absorbs only
//!   content equal to what the app wrote.
//! - A removal is reported only after the rename window, with the vault reachable and the file
//!   (and its iCloud placeholder) absent. A rescan withholds removals when too many are missing
//!   at once or the walk was cut short.
//! - A removal that pairs with a new file by content hash is a rename, never a delete plus a new
//!   file; a note whose row has no hash is never paired. A rename is reported once.
//! - Every markdown file is read by hash, streamed, on the watcher's thread; a file that cannot
//!   be read is reported unreadable and left alone.

use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use memry_core::api::errors::StorageError;
use memry_core::api::note_files::NoteFiles;
use memry_core::domain::note_files::NoteFile;

use super::echo::EchoGuard;
use super::event::{EventSink, VaultEvent};
use super::filter::WatchFilter;
use super::gone::{is_gone_from_disk, is_vault_reachable};
use super::rename::{Pending, RenameTracker};
use super::reported::{Reported, Seen};
use crate::vault::file_types::{FileType, extension, file_type_of_extension, is_supported_path};
use crate::vault::note_file::hash_file;
use crate::vault::walk::{Limits, walk_from};

/// How long a new markdown file waits before it is reported as new. The OS reports the two
/// halves of a move in no fixed order and the debounce releases paths a few milliseconds
/// apart, so a file can show up before the removal it pairs with is known.
pub const ADD_GRACE: Duration = Duration::from_millis(300);
/// Files held at once; past this a new file is reported at once and loses only the late pairing.
pub const MAX_HELD_ADDS: usize = 10_000;

struct HeldAdd {
    path: String,
    file_type: FileType,
    size: u64,
    modified_ms: i64,
    hash: Option<String>,
    due: Instant,
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
    all_rows: Option<Vec<NoteFile>>,
    pub(super) limits: Limits,
    held_adds: Vec<HeldAdd>,
    reported: Reported,
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

pub(super) fn pending_of(row: NoteFile) -> Pending {
    Pending {
        note_id: row.note_id,
        path: row.path,
        hash: row.content_hash,
    }
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
            limits: Limits::DEFAULT,
            held_adds: Vec::new(),
            reported: Reported::default(),
        }
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
    }

    pub(super) fn emit(&self, event: VaultEvent) {
        (self.sink)(event);
    }

    /// The vault left: every removal reported from here on would be false. Pending deletes
    /// are dropped, so none settles; the rescan on return finds what is really gone.
    pub fn go_away(&mut self) {
        if !self.away {
            self.away = true;
            self.tracker.clear();
            self.held_adds.clear();
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
        let mut dirs = Vec::new();
        let mut present = Vec::new();
        for rel in rels {
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
            self.file_present(&rel, &meta, now);
        }
        self.resolve_adds(now);
    }

    fn vanished(&mut self, rel: &str, now: Instant) {
        if !is_vault_reachable(&self.root) {
            self.go_away();
            return;
        }
        // What was reported about it, and a file created and removed inside the grace, are
        // history now.
        self.reported.forget_tree(rel);
        let below = format!("{rel}/");
        self.held_adds
            .retain(|a| a.path != rel && !a.path.starts_with(&below));
        if self.echo.absorbs_removal(rel) {
            return;
        }
        let rows = match self.files.by_path(rel) {
            Ok(Some(row)) => vec![row],
            // A folder that went: every note below it went with it.
            Ok(None) => match self.rows_under(rel) {
                Ok(rows) => rows,
                Err(error) => return self.storage_failed(&error),
            },
            Err(error) => return self.storage_failed(&error),
        };
        for row in rows {
            self.tracker.track(pending_of(row), now, None);
        }
    }

    fn rows_under(&mut self, rel: &str) -> Result<Vec<NoteFile>, StorageError> {
        // A name with a supported extension is a file: no folder to look under. Editors' temp
        // files (`a.md.sb-1234`) vanish by the dozen and must not each load the table.
        if is_supported_path(rel) {
            return Ok(Vec::new());
        }
        if self.all_rows.is_none() {
            self.all_rows = Some(self.files.list_missing_candidates()?);
        }
        let prefix = format!("{rel}/");
        Ok(self
            .all_rows
            .iter()
            .flatten()
            .filter(|row| row.path.starts_with(&prefix))
            .cloned()
            .collect())
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
    }

    pub(super) fn confirm_removed(&mut self, pending: Pending) {
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
        self.reported.forget_tree(&pending.path);
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
            if self.filter.ignores(&path) {
                continue;
            }
            if let Probe::File(meta) = probe(&self.root.join(&path)) {
                self.file_present(&path, &meta, now);
            }
        }
    }

    pub(super) fn file_present(&mut self, rel: &str, meta: &Metadata, now: Instant) {
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
            None
        };
        let row = match self.files.by_path(rel) {
            Ok(row) => row,
            Err(error) => return self.storage_failed(&error),
        };
        // The baseline is what was last reported, else the row. Comparing with the row alone
        // would repeat a report until a consumer updated it, and would miss an edit that
        // returns the file to the row's old content.
        let seen = self.reported.get(rel).cloned();
        let known_id = seen
            .as_ref()
            .and_then(|s| s.note_id.clone())
            .or_else(|| row.as_ref().map(|r| r.note_id.clone()));
        if let Some(hash) = &hash
            && self.echo.absorbs_write(rel, hash)
        {
            // The app's write is the state now: an outside edit back to what was reported
            // before it must not read as "unchanged".
            self.reported.put(
                rel,
                Seen {
                    hash: Some(hash.clone()),
                    stat: (size, modified),
                    note_id: known_id,
                },
            );
            return;
        }
        let unchanged = if is_markdown {
            let known_hash = match (&seen, &row) {
                (Some(seen), _) => seen.hash.as_ref(),
                (None, Some(row)) => row.content_hash.as_ref(),
                (None, None) => None,
            };
            hash.is_some() && known_hash == hash.as_ref()
        } else {
            match (&seen, &row) {
                (Some(seen), _) => seen.stat == (size, modified),
                (None, Some(row)) => {
                    row.file_size == i64::try_from(size).ok() && modified <= row.indexed_at
                }
                (None, None) => false,
            }
        };
        if unchanged {
            return;
        }
        let stat = (size, modified);
        if let Some(note_id) = known_id {
            self.reported.put(
                rel,
                Seen {
                    hash: hash.clone(),
                    stat,
                    note_id: Some(note_id.clone()),
                },
            );
            self.emit(VaultEvent::Changed {
                note_id,
                path: rel.to_owned(),
                content_hash: hash,
                size,
                modified_ms: modified,
            });
            return;
        }
        self.unknown_file(rel, file_type, hash, stat, now);
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
                due: now + ADD_GRACE,
            });
            return;
        }
        self.report_added(rel.to_owned(), file_type, stat, hash);
    }

    fn report_rename(&mut self, from: Pending, to: String, hash: String, stat: (u64, i64)) {
        self.reported.forget_tree(&from.path);
        self.reported.put(
            &to,
            Seen {
                hash: Some(hash.clone()),
                stat,
                note_id: Some(from.note_id.clone()),
            },
        );
        self.emit(VaultEvent::Renamed {
            note_id: from.note_id,
            old_path: from.path,
            new_path: to,
            content_hash: hash,
        });
    }

    fn report_added(
        &mut self,
        path: String,
        file_type: FileType,
        stat: (u64, i64),
        hash: Option<String>,
    ) {
        self.reported.put(
            &path,
            Seen {
                hash: hash.clone(),
                stat,
                note_id: None,
            },
        );
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
