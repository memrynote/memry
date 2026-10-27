//! What the watcher reports. Facts about the vault folder, measured against `note_files`: the
//! consumer (the indexer, the write-back's ingest, the renderer events) decides what each
//! one means for notes. The watcher itself changes no row and no file.

use std::sync::Arc;

use crate::vault::file_types::FileType;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultEvent {
    /// A file no row names. Not read: `content_hash` is set only when a rename was being
    /// looked for.
    Added {
        path: String,
        file_type: FileType,
        size: u64,
        modified_ms: i64,
        content_hash: Option<String>,
    },
    /// A file a row names, with other content than the row holds (markdown by hash, other
    /// kinds by size or a newer modification time).
    Changed {
        note_id: String,
        path: String,
        /// `None` for a file that is not markdown.
        content_hash: Option<String>,
        size: u64,
        modified_ms: i64,
    },
    /// A note's file is gone for good: the rename window closed, the vault is there and the
    /// file is not on disk.
    Removed { note_id: String, path: String },
    /// A removed note's content appeared at another path: the note keeps its id.
    Renamed {
        note_id: String,
        old_path: String,
        new_path: String,
        content_hash: String,
    },
    /// A file of a type the vault does not index appeared.
    Unsupported { path: String },
    /// A file exists and could not be read (hard-linked, not UTF-8 is not checked here,
    /// permission, a lock). It is left alone.
    Unreadable { path: String, reason: String },
    /// The vault folder went away (an unplugged drive, a dropped share, a renamed folder).
    /// Removals are ignored until [`VaultEvent::Reachable`].
    Unreachable,
    /// The vault is back; a rescan with changes follows.
    Reachable,
    /// A full pass over the vault finished.
    Rescanned {
        missing: usize,
        added: usize,
        changed: usize,
        /// Too many files were missing at once (20 and 25 % of the rows), or the walk was cut
        /// short: no removal was reported, so no delete reaches the other devices. The rows
        /// are checked again at the next open.
        removals_withheld: bool,
    },
    /// The OS watcher failed or could not start. `limit` is the Linux inotify watch limit
    /// (the user can raise it).
    WatchFailed { message: String, limit: bool },
}

/// Where events go. Called on the watcher's thread: it must not block.
pub type EventSink = Arc<dyn Fn(VaultEvent) + Send + Sync>;
