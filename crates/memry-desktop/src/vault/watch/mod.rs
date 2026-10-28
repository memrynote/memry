//! The vault watcher (Step 12d, #3529): OS file events in, [`VaultEvent`] facts out.
//!
//! - [`filter`]: which paths count (`ignored` of the chokidar options).
//! - [`debounce`]: a path is looked at once it has been quiet.
//! - [`reconcile`]: what is on disk against `note_files`; `present` for a file that is there,
//!   `rescan` for the rescan.
//! - [`rename`]: a removed file whose content shows up elsewhere is a rename.
//! - [`echo`]: the app's own writes do not come back as outside edits.
//! - [`reported`]: what was already told, which every removal and rescan reads before the row.
//! - [`gone`]: a removal is real only if the vault is there and the file (and its iCloud
//!   placeholder) is not.
//! - `handle`: the worker's queue, and what a consumer may ask of it.
//! - [`runtime`]: the `notify` watcher and the one thread that owns the reconciler.
//! - [`safety`]: the rescans that stand in for events the OS watcher lost without saying so.
//!
//! The watcher is inert for notes: it reads `note_files` and the files, changes neither, and
//! hands events to a sink. The consumer (`vault::consumer`) applies them.

pub mod debounce;
pub mod echo;
pub mod event;
pub mod filter;
pub mod gone;
mod handle;
mod home;
mod present;
pub mod reconcile;
pub mod rename;
pub mod reported;
mod rescan;
mod runtime;
pub mod safety;

pub use echo::EchoGuard;
pub use event::{EventSink, VaultEvent};
pub use handle::{NewFiles, WatchHandle};
pub use runtime::{VaultWatcher, WatchError};
pub use safety::Tuning;
