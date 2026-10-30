//! The vault consumer (Step 12e-2, #3529): the watcher's facts in, `note_files` rows and note
//! bodies out, then [`Applied`] facts for whatever derives from the rows (stats, search, the
//! renderer).
//!
//! - [`identity`]: which note a file belongs to, decided by Step 13's records.
//! - [`rows`]: the one lane that writes `note_files`, for the consumer and the app alike.
//! - `apply`: one fact applied to the rows.
//! - `run`: the thread that applies facts in the watcher's order, the open walk and retries.
//!
//! Invariants, each with a test in `tests/` here or in `tests/vault_consumer.rs`:
//! - **A row's hash names a file whose text the note's document holds.** The consumer records
//!   a file's hash only after the feed answered `Fed` or `Unchanged` for exactly the text,
//!   and the `writing` frontmatter when it parses, that hash was computed from. Every other
//!   answer (`Owed`, `Refused`, `LargeFile`, `NoNote`, `BodyPresent`, no device key, an error)
//!   records no hash: the row keeps the one it had, and a new row gets none. This holds for
//!   every way a file reaches the consumer: a watcher `Added` or `Changed`, the open walk, and
//!   a retry. The write-back takes "the file's hash equals the row's" for "the file holds
//!   nothing the document lacks" and writes over it, so a hash recorded early loses the file's
//!   text. The write-back records the hash of what it wrote from the document, which holds it
//!   by construction.
//!
//!   A file whose frontmatter does not parse is taken as read once its text is fed (#3750).
//!   Its block holds bytes the document never has, and no pass writes over them: a pass cannot
//!   read the file back, so it fails and the user is told. Left without the hash, the row
//!   would name an older file, and the next read of these same bytes (the open walk) would
//!   take them for a new outside edit and replace every edit made in the app since.
//! - **A row without a hash is never replaced from its file.** Its note's body may be one the
//!   file never had (synced, owed and since pulled, a note kept when its file went), so the
//!   file only fills an empty body; a conflict between the two is the write-back's (12e-3,
//!   Step 17). A note the identity keeps when its file goes loses its row's hash.
//! - **An outside edit replaces the body, and the body it replaces is kept.** A changed file
//!   whose row has a hash is fed; the feed keeps the body it replaces as a version first.
//!   Edits in the app and from sync reach the file through the write-back
//!   ([`crate::vault::writeback`]) once the note is quiet, so an outside edit replaces what
//!   its file showed, except for edits made in the moments before it, which the version holds.
//! - **A file the consumer could not read is read again.** A read that fails or finds no file
//!   is retried, never applied as done and never taken for a removal (#3736): only the
//!   watcher reports a removal, after its rename window. Otherwise a save read in the moment
//!   its name is missing would never reach the note, since the watcher does not report the
//!   same bytes twice.
//! - **One file, one note.** A file is offered to the identity only when no row names its path
//!   under any spelling the volume folds together, read under the lane when the fact is
//!   applied. A row the app reserved before writing its file, or one the open walk recorded,
//!   turns the watcher's later `Added` for that path into a change of that note.
//! - **A note's row goes only after its record, and moves only after it.** A removal deletes
//!   the row once the identity answered [`identity::Removal::Deleted`]; a move moves it once
//!   `on_renamed` answered `Ok`.
//! - **The cost is the work there is.** An identity that adopts nothing
//!   ([`identity::NoteIdentity::adopts`]) has no file without a row read: not by the open
//!   walk, not by a watcher's rescan. A queue overflow keeps what was queued and costs one
//!   resync per finished pass, spaced out while passes keep overflowing.
//! - **Order.** Facts are applied one at a time in the order the watcher reported them. The
//!   open walk runs after the session's first `Rescanned`, so the removals and moves found
//!   while the app was closed are applied before it; a fact that arrives during or after the
//!   walk, for a path it covered or not, is applied like any other. An [`Applied`] fact goes
//!   out after its row is written, under the lane.

mod apply;
pub mod identity;
pub mod rows;
mod run;
#[cfg(test)]
pub(crate) mod tests;
mod tier;

pub(crate) use apply::converter_for;
pub use run::{FIRST_RETRY, MAX_RETRIES, QUEUE_CAPACITY};
#[cfg(test)]
pub(crate) use tier::Hold;
pub use tier::VaultTier;

use run::{AfterWalk, Consumer, inbox};

use crate::vault::watch::VaultEvent;

/// Who changed a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeSource {
    /// An edit outside the app, fed into the note.
    Watcher,
    /// The app wrote the file.
    App,
}

/// A change to the rows, published after the row is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Applied {
    /// A file got its note. `created` when the note is new.
    Added {
        note_id: String,
        path: String,
        created: bool,
    },
    Changed {
        note_id: String,
        path: String,
        content_hash: Option<String>,
        source: ChangeSource,
    },
    Removed {
        note_id: String,
        path: String,
    },
    Renamed {
        note_id: String,
        old_path: String,
        new_path: String,
    },
    /// The open walk offered every file of the vault. `complete` is `false` when the walk hit
    /// its caps, or when the identity adopts nothing (files without a row stay unindexed);
    /// the next open walks again.
    Indexed {
        complete: bool,
    },
    /// A watcher fact that changes no row (`Unsupported`, `Unreadable`, `Unreachable`,
    /// `Reachable`, `Rescanned`, `WatchFailed`), passed on as it came.
    Vault(VaultEvent),
}
