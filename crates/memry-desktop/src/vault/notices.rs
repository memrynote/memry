//! The open vault's notices (Step 14l, #3531): a state of the vault the user can act on that no
//! screen shows otherwise, such as a `.memry/config.json` that cannot be read or the Linux
//! inotify watch limit. Electron has none of these; it only logs.
//!
//! One board per process, opened and closed with the vault session ([`VaultNotices::register`]).
//! A detector raises a notice for the vault it works in and clears it when the state passes; a
//! notice for a vault that is not the open one is dropped, so a late report of a closed vault
//! never shows in the next. The board holds at most one notice of each kind, and only in
//! memory: every open starts empty and finds its notices again. A notice about some files or
//! notes lists them ([`VaultNotices::add`], [`VaultNotices::remove`]), at most [`LISTED`] of
//! them.
//!
//! Each change is told to [`VaultNotices::subscribe`]rs with no payload; the window reads the
//! list ([`VaultNotices::list`]), so one that mounts after the open still sees it.

use std::mem::discriminant;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::session::{OpenStage, Session};

/// A state of the open vault the user can act on:
/// - `configUnreadable`: `.memry/config.json` is there and cannot be read, so the journal days
///   are unknown: no file becomes a note or a day, and no move reaches its record, until it
///   reads (`notes::identity`). `path` is the file's, for the user to fix it.
/// - `watchLimit`: the Linux inotify watch limit left part of the vault unwatched
///   (`WatchFailed { limit: true }`): changes made outside the app there arrive with the
///   watcher's rescans, not at once, until the user raises `fs.inotify.max_user_watches` and
///   restarts.
/// - `undecidedFiles`: files that have the name of a note or a journal day whose text is not
///   the file's, or is not on this device yet (`Deferral::Undecided`): they stay files, not
///   notes, and the next open asks again. `paths` are absolute, for the user to find them.
/// - `keptRemovals`: files deleted outside the app whose notes were kept, because the note has
///   text the file never had (`Removed::Undecided`), rather than deleting that text on every
///   device. Listed until a file is at the note's path again; every open lists them again
///   while their rows have no file.
/// - `more` says a list notice had more items than [`LISTED`].
//
// The variants carry no doc comments: specta would write them into a union with trailing
// whitespace in `bindings.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum VaultNotice {
    ConfigUnreadable { path: String },
    WatchLimit,
    UndecidedFiles { paths: Vec<String>, more: bool },
    KeptRemovals { notes: Vec<KeptRemoval>, more: bool },
}

/// A note kept when its file was deleted outside the app; `path` is the deleted file's,
/// absolute.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KeptRemoval {
    pub note_id: String,
    pub path: String,
}

/// The most items a list notice names, few enough to act on one by one; past it the notice
/// only says there are more.
pub const LISTED: usize = 50;

/// An item of a list notice: [`VaultNotices::add`] adds it to its notice,
/// [`VaultNotices::remove`] takes it off once its state passed.
#[derive(Debug, Clone, Copy)]
pub enum Listed<'a> {
    /// An undecided file, by its absolute path.
    Undecided(&'a str),
    /// A kept note: its id, and the deleted file's absolute path (only `add` reads it).
    Kept { note_id: &'a str, path: &'a str },
}

/// The open vault's notices, as a window reads them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, specta::Type)]
pub struct VaultNoticeList {
    /// Changes with every open, so a window forgets the notices the user closed in the vault
    /// before.
    pub open: u32,
    pub notices: Vec<VaultNotice>,
}

#[derive(Default)]
struct Board {
    /// The open vault's root; `None` while no vault is open.
    root: Option<PathBuf>,
    /// Counts the opens.
    open: u32,
    notices: Vec<VaultNotice>,
}

pub struct VaultNotices {
    board: Mutex<Board>,
    changed: broadcast::Sender<()>,
}

impl VaultNotices {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            board: Mutex::default(),
            changed: broadcast::channel(16).0,
        })
    }

    fn board(&self) -> MutexGuard<'_, Board> {
        self.board.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Told after every change of the open vault's notices, and when a vault opens or closes.
    pub fn subscribe(&self) -> broadcast::Receiver<()> {
        self.changed.subscribe()
    }

    /// The open vault's notices, in the order they were raised.
    pub fn list(&self) -> Vec<VaultNotice> {
        self.board().notices.clone()
    }

    /// [`Self::list`] with the open it belongs to.
    pub fn read(&self) -> VaultNoticeList {
        let board = self.board();
        VaultNoticeList {
            open: board.open,
            notices: board.notices.clone(),
        }
    }

    /// Opens the board with every open and empties it with every close.
    pub fn register(self: &Arc<Self>, session: &Session) {
        let board = self.clone();
        session.on_open(
            "vault-notices",
            OpenStage::Settings,
            Arc::new(move |vault| {
                board.open(&vault.path);
                Ok(())
            }),
        );
        let board = self.clone();
        session.on_close(
            "vault-notices",
            Arc::new(move |view| board.close(&view.path)),
        );
    }

    pub fn open(&self, root: &Path) {
        let mut board = self.board();
        *board = Board {
            root: Some(root.to_path_buf()),
            open: board.open.wrapping_add(1),
            notices: Vec::new(),
        };
        drop(board);
        let _ = self.changed.send(());
    }

    /// A late close of an earlier vault leaves the open one's notices alone.
    pub fn close(&self, root: &Path) {
        let mut board = self.board();
        if board.root.as_deref() == Some(root) {
            board.root = None;
            board.notices.clear();
            let _ = self.changed.send(());
        }
    }

    /// Runs `edit` on the notices of the vault at `root`, and tells the subscribers when it
    /// says it changed them. Nothing runs when `root` is not the open vault.
    fn edit(&self, root: &Path, edit: impl FnOnce(&mut Vec<VaultNotice>) -> bool) -> bool {
        let mut board = self.board();
        if board.root.as_deref() != Some(root) || !edit(&mut board.notices) {
            return false;
        }
        let _ = self.changed.send(());
        true
    }

    /// Shows `notice` for the vault at `root`, in place of one of its kind. `true` when the
    /// board had no notice of its kind, for the caller to log the state once per open; `false`
    /// too when `root` is not the open vault.
    pub fn raise(&self, root: &Path, notice: VaultNotice) -> bool {
        let mut new = false;
        self.edit(root, |notices| {
            let kind = discriminant(&notice);
            match notices.iter_mut().find(|n| discriminant(&**n) == kind) {
                Some(held) if *held == notice => return false,
                Some(held) => *held = notice,
                None => {
                    notices.push(notice);
                    new = true;
                }
            }
            true
        });
        new
    }

    /// The state of `like`'s kind passed in the vault at `root`.
    pub fn clear(&self, root: &Path, like: &VaultNotice) {
        self.edit(root, |notices| {
            let before = notices.len();
            notices.retain(|n| discriminant(n) != discriminant(like));
            notices.len() != before
        });
    }

    /// Lists `item` in its notice for the vault at `root`, raising the notice if it is not up.
    /// `true` when it was not, for the caller to log the state once per open.
    pub fn add(&self, root: &Path, item: Listed<'_>) -> bool {
        let mut new = false;
        self.edit(root, |notices| {
            let at = match notices
                .iter()
                .position(|n| listed_kind(n) == Some(kind_of(item)))
            {
                Some(at) => at,
                None => {
                    notices.push(empty(item));
                    new = true;
                    notices.len() - 1
                }
            };
            match (&mut notices[at], item) {
                (VaultNotice::UndecidedFiles { paths, more }, Listed::Undecided(path)) => {
                    push_listed(paths, more, path.to_owned())
                }
                (VaultNotice::KeptRemovals { notes, more }, Listed::Kept { note_id, path }) => {
                    let note = KeptRemoval {
                        note_id: note_id.to_owned(),
                        path: path.to_owned(),
                    };
                    push_listed(notes, more, note)
                }
                _ => false,
            }
        });
        new
    }

    /// `item`'s state passed: it leaves its notice, and the notice goes with its last item.
    /// A notice that had more items than it listed stays until the next open.
    pub fn remove(&self, root: &Path, item: Listed<'_>) {
        self.edit(root, |notices| {
            let Some(at) = notices
                .iter()
                .position(|n| listed_kind(n) == Some(kind_of(item)))
            else {
                return false;
            };
            let (removed, empty) = match (&mut notices[at], item) {
                (VaultNotice::UndecidedFiles { paths, more }, Listed::Undecided(path)) => {
                    let before = paths.len();
                    paths.retain(|held| held != path);
                    (paths.len() != before, paths.is_empty() && !*more)
                }
                (VaultNotice::KeptRemovals { notes, more }, Listed::Kept { note_id, .. }) => {
                    let before = notes.len();
                    notes.retain(|held| held.note_id != note_id);
                    (notes.len() != before, notes.is_empty() && !*more)
                }
                _ => (false, false),
            };
            if empty {
                notices.remove(at);
            }
            removed
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ListKind {
    Undecided,
    Kept,
}

fn kind_of(item: Listed<'_>) -> ListKind {
    match item {
        Listed::Undecided(_) => ListKind::Undecided,
        Listed::Kept { .. } => ListKind::Kept,
    }
}

fn listed_kind(notice: &VaultNotice) -> Option<ListKind> {
    match notice {
        VaultNotice::UndecidedFiles { .. } => Some(ListKind::Undecided),
        VaultNotice::KeptRemovals { .. } => Some(ListKind::Kept),
        VaultNotice::ConfigUnreadable { .. } | VaultNotice::WatchLimit => None,
    }
}

fn empty(item: Listed<'_>) -> VaultNotice {
    match item {
        Listed::Undecided(_) => VaultNotice::UndecidedFiles {
            paths: Vec::new(),
            more: false,
        },
        Listed::Kept { .. } => VaultNotice::KeptRemovals {
            notes: Vec::new(),
            more: false,
        },
    }
}

/// Adds `item` to `list` unless it is there; past [`LISTED`] items only `more` is set. `true`
/// when the list or `more` changed.
fn push_listed<T: PartialEq>(list: &mut Vec<T>, more: &mut bool, item: T) -> bool {
    if list.contains(&item) {
        false
    } else if list.len() < LISTED {
        list.push(item);
        true
    } else {
        !std::mem::replace(more, true)
    }
}
