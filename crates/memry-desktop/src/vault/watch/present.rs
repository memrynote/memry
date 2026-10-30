//! A path that is there: what the reconciler reports for a file it found (`handleFileAdd` and
//! `handleFileChange` of `vault/watcher.ts`). Split from `reconcile`, whose invariants it keeps.

use std::fs::Metadata;
use std::time::Instant;

use super::event::VaultEvent;
use super::home::{Home, spelling_listed};
use super::reconcile::{ADD_GRACE, HeldAdd, MAX_HELD_ADDS, Reconciler, modified_ms};
use super::rename::{Pending, observed};
use super::reported::Seen;
use crate::vault::file_types::{FileType, extension, file_type_of_extension};
use crate::vault::note_file::hash_file;

impl Reconciler {
    pub(super) fn file_present(&mut self, rel: &str, meta: &Metadata, now: Instant) {
        if self.stopped() {
            return;
        }
        let root = &self.root;
        self.echo.seen_file(rel, |path| {
            std::fs::symlink_metadata(root.join(path)).is_ok()
        });
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
        if unchanged && !self.reported.is_owed(rel) {
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
            && let Some(from) = self.tracker.claim(hash, rel)
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
    pub(super) fn resolve_adds(&mut self, now: Instant) {
        for add in std::mem::take(&mut self.held_adds) {
            let stat = (add.size, add.modified_ms);
            let claimed = add
                .hash
                .as_ref()
                .and_then(|h| self.tracker.claim(h, &add.path));
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
