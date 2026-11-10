//! The open vault's notices (Step 14l, #3531): a state of the vault the user can act on that no
//! screen shows otherwise, such as a `.memry/config.json` that cannot be read or the Linux
//! inotify watch limit. Electron has none of these; it only logs.
//!
//! One board per process, opened and closed with the vault session ([`VaultNotices::register`]).
//! A detector raises a notice for the vault it works in and clears it when the state passes; a
//! notice for a vault that is not the open one is dropped, so a late report of a closed vault
//! never shows in the next. The board holds at most one notice of each kind, and only in
//! memory: every open starts empty and finds its notices again.
//!
//! Each change is told to [`VaultNotices::subscribe`]rs with no payload; the window reads the
//! list ([`VaultNotices::list`]), so one that mounts after the open still sees it.

use std::mem::discriminant;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;

use crate::session::{OpenStage, Session};
use crate::vault::consumer::Applied;
use crate::vault::watch::VaultEvent;

/// A state of the open vault the user can act on:
/// - `configUnreadable`: `.memry/config.json` is there and cannot be read, so the journal days
///   are unknown: no file becomes a note or a day, and no move reaches its record, until it
///   reads (`notes::identity`). `path` is the file's, for the user to fix it.
/// - `watchLimit`: the Linux inotify watch limit left part of the vault unwatched
///   (`WatchFailed { limit: true }`): changes made outside the app there arrive with the
///   watcher's rescans, not at once, until the user raises `fs.inotify.max_user_watches` and
///   restarts.
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

    /// Shows `notice` for the vault at `root`, in place of one of its kind. `true` when the
    /// board had no notice of its kind, for the caller to log the state once per open; `false`
    /// too when `root` is not the open vault.
    pub fn raise(&self, root: &Path, notice: VaultNotice) -> bool {
        let mut board = self.board();
        if board.root.as_deref() != Some(root) {
            return false;
        }
        let kind = discriminant(&notice);
        match board
            .notices
            .iter_mut()
            .find(|n| discriminant(&**n) == kind)
        {
            Some(held) if *held == notice => return false,
            Some(held) => *held = notice,
            None => board.notices.push(notice),
        }
        let _ = self.changed.send(());
        true
    }

    /// The state of `like`'s kind passed in the vault at `root`.
    pub fn clear(&self, root: &Path, like: &VaultNotice) {
        let mut board = self.board();
        if board.root.as_deref() != Some(root) {
            return;
        }
        let before = board.notices.len();
        board
            .notices
            .retain(|n| discriminant(n) != discriminant(like));
        if board.notices.len() != before {
            let _ = self.changed.send(());
        }
    }

    /// Raises [`VaultNotice::WatchLimit`] for the open vault when its watcher reports the
    /// limit. The tier publishes a watcher fact only for the open it belongs to.
    pub fn follow(self: &Arc<Self>, mut facts: broadcast::Receiver<Applied>) {
        let board = self.clone();
        std::thread::spawn(move || {
            loop {
                match facts.blocking_recv() {
                    Ok(Applied::Vault(VaultEvent::WatchFailed { limit: true, .. })) => {
                        let root = board.board().root.clone();
                        if let Some(root) = root {
                            board.raise(&root, VaultNotice::WatchLimit);
                        }
                    }
                    Ok(_) => {}
                    Err(RecvError::Lagged(missed)) => tracing::warn!(
                        scope = "vault_notices",
                        missed,
                        "watcher facts were dropped: a watch limit among them shows no notice"
                    ),
                    Err(RecvError::Closed) => return,
                }
            }
        });
    }
}
