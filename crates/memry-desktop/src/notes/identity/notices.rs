//! What the identity shows on the vault's notice board ([`VaultNotices`]): the vault config it
//! cannot read, the files it leaves undecided, the notes it keeps when their files are deleted,
//! and the watcher's inotify limit; and the state only logged so far.

use std::path::Path;
use std::sync::PoisonError;

use super::{NotesIdentity, SCOPE};
use crate::vault::config::{config_path, read_vault_config_strict};
use crate::vault::journal_format::JournalDays;
use crate::vault::notices::{Listed, VaultNotice};

#[cfg(doc)]
use crate::vault::notices::VaultNotices;

/// What is logged once per vault and process, not once per file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum Notice {
    ElectronNotImported,
}

impl NotesIdentity {
    pub(super) fn tell_once(&self, notice: Notice, root: &Path) {
        let first = self
            .told
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert((notice, root.to_path_buf()));
        if !first {
            return;
        }
        match notice {
            // TODO(#3553 Step 36): the import owns this state; its notice tells the user that
            // until the import runs, this vault names no file.
            Notice::ElectronNotImported => tracing::warn!(
                scope = SCOPE,
                "this vault holds the database of the previous app version, whose notes this \
                 app did not import; its files are not made notes here, so none syncs twice"
            ),
        }
    }

    /// The file at `path` has the name of a note or a day whose text is not the file's, or not
    /// here yet: it is listed until an ask names it, or the next open asks again.
    pub(super) fn undecided(&self, root: &Path, path: &str) {
        if self
            .notices
            .add(root, Listed::Undecided(&absolute(root, path)))
        {
            tracing::info!(
                scope = SCOPE,
                "a file has the name of a note or a day whose text is not the file's, or not \
                 here yet; it is not named, and the next open asks again"
            );
        }
    }

    /// The file at `path` is a note's or a day's now: it is not listed any more.
    pub(super) fn named(&self, root: &Path, path: &str) {
        let path = absolute(root, path);
        self.notices.remove(root, Listed::Undecided(&path));
    }

    /// `note_id` is kept although its file at `path` was deleted: listed until a file is at its
    /// path again.
    pub(super) fn kept(&self, root: &Path, note_id: &str, path: &str) {
        let path = absolute(root, path);
        self.notices.add(
            root,
            Listed::Kept {
                note_id,
                path: &path,
            },
        );
    }

    /// A file is at the path of `note_id`'s row again: it is not listed as kept any more.
    pub(super) fn returned(&self, root: &Path, note_id: &str) {
        self.notices
            .remove(root, Listed::Kept { note_id, path: "" });
    }

    /// The watcher of the vault at `root` hit the Linux inotify watch limit.
    pub(super) fn watch_limit(&self, root: &Path) {
        self.notices.raise(root, VaultNotice::WatchLimit);
    }

    /// Where the vault's journal days are; `None` when the vault config is there but unreadable,
    /// which the vault's notices show until a read succeeds. Read at every ask, so a config
    /// changed while the vault is open applies to the next file event; compiled again only when
    /// it changed.
    pub(super) fn journal(&self, root: &Path) -> Option<JournalDays> {
        match read_vault_config_strict(root) {
            Ok(config) => {
                let kind = VaultNotice::ConfigUnreadable {
                    path: String::new(),
                };
                self.notices.clear(root, &kind);
                let (folder, format) = (&config.journal_folder, &config.journal_date_format);
                let mut days = self.days.lock().unwrap_or_else(PoisonError::into_inner);
                if !days.as_ref().is_some_and(|days| days.is_of(folder, format)) {
                    *days = Some(JournalDays::new(folder, format));
                }
                days.clone()
            }
            Err(_) => {
                let path = config_path(root).to_string_lossy().into_owned();
                if self
                    .notices
                    .raise(root, VaultNotice::ConfigUnreadable { path })
                {
                    tracing::warn!(
                        scope = SCOPE,
                        "the vault config cannot be read, so the journal days are unknown; no \
                         file is made a note or a day, and no move reaches its record, until it \
                         can be"
                    );
                }
                None
            }
        }
    }
}

/// The absolute path of the vault file at `path`, for the user to find it.
fn absolute(root: &Path, path: &str) -> String {
    root.join(path).to_string_lossy().into_owned()
}
