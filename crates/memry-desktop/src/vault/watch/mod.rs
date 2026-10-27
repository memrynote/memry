//! The vault watcher (Step 12d, #3529): OS file events in, [`VaultEvent`] facts out.
//!
//! - [`filter`]: which paths count (`ignored` of the chokidar options).
//! - [`debounce`]: a path is looked at once it has been quiet.
//! - [`reconcile`]: what is on disk against `note_files`, plus the rescan.
//! - [`rename`]: a removed file whose content shows up elsewhere is a rename.
//! - [`echo`]: the app's own writes do not come back as outside edits.
//! - [`gone`]: a removal is real only if the vault is there and the file (and its iCloud
//!   placeholder) is not.
//! - [`runtime`]: the `notify` watcher and the one thread that owns the reconciler.
//! - [`tier`]: registers the watcher on the session's open and close.
//!
//! The tier is inert for notes: it reads `note_files` and the files, changes neither, and
//! hands events to a sink. The index update, the write-back's ingest of an outside edit (the
//! CRDT feed) and the renderer events consume them in later stages (12e and after).

pub mod debounce;
pub mod echo;
pub mod event;
pub mod filter;
pub mod gone;
pub mod reconcile;
pub mod rename;
pub mod reported;
mod rescan;
mod runtime;
mod tier;

pub use echo::EchoGuard;
pub use event::{EventSink, VaultEvent};
pub use runtime::{VaultWatcher, WatchError};
pub use tier::VaultTier;
