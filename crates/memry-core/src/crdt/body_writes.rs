//! Which document bodies a write touched, told once the writer is free
//! (desktop Step 14c-1, #3531).
//!
//! The desktop editor host keeps the documents windows type into in memory
//! (`api::editor::Editor`), each a cache of the body log. Every other writer of
//! that log must reach it, or the windows keep typing into an older body: a
//! sync merge, a delete's purge, an outside edit fed from the file, a note or
//! journal command, a tag rename or link rewrite. A rule that each writer calls
//! the host after its commit is one the next writer forgets, so the log itself
//! notes what it writes, and the database handle tells:
//!
//! - every write of [`super::update_log`] (a local update, a server update or
//!   snapshot, a purge) calls [`noted`] on the thread that runs the write;
//! - a [`crate::storage::Db`] write closure records those notes only while a
//!   [`BodyObserver`] is registered on its handle (the editor host, desktop
//!   only), and hands them to the observer after the closure returned and the
//!   writer was released.
//!
//! A note says a document was written, not that the write committed: the
//! closure may have rolled it back. The observer reads the committed log.

use std::cell::{Cell, RefCell};

/// Where an update came from, for the windows it reaches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    /// A window's edit; the holder is the window that sent it, which the shell
    /// does not send it back to.
    Local(String),
    /// Merged from the server.
    Remote,
    /// An edit made to the vault file outside the app.
    External,
    /// Written by the app itself (a command, a repair, a restore).
    System,
}

impl Origin {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Local(_) => "local",
            Self::Remote => "remote",
            Self::External => "external",
            Self::System => "system",
        }
    }
}

/// One document a write closure wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyWrite {
    pub doc_id: String,
    pub origin: Origin,
    /// The write purged the document's log (a delete applied, chapter 07 §7.15).
    pub purged: bool,
}

/// Told what each write closure on a database handle wrote.
pub trait BodyObserver: Send + Sync {
    /// Runs after the closure returned and released the writer, on its thread.
    /// A write named here may have rolled back.
    fn bodies_written(&self, writes: &[BodyWrite]);
}

/// What [`super::update_log`] wrote.
pub(crate) enum Wrote {
    Local,
    Server,
    Purge,
}

thread_local! {
    static RECORDED: RefCell<Option<Vec<BodyWrite>>> = const { RefCell::new(None) };
    static EXTERNAL: Cell<bool> = const { Cell::new(false) };
}

/// Notes that `doc_id`'s log was written, when a closure on this thread records.
pub(crate) fn noted(doc_id: &str, wrote: Wrote) {
    RECORDED.with_borrow_mut(|recorded| {
        let Some(writes) = recorded else {
            return;
        };
        let purged = matches!(wrote, Wrote::Purge);
        // Consecutive writes of one document are one entry; an observer that
        // sees a document twice finds nothing new the second time.
        if let Some(last) = writes.last_mut().filter(|last| last.doc_id == doc_id) {
            last.purged |= purged;
            return;
        }
        let origin = match wrote {
            Wrote::Server => Origin::Remote,
            Wrote::Local if EXTERNAL.get() => Origin::External,
            Wrote::Local | Wrote::Purge => Origin::System,
        };
        writes.push(BodyWrite {
            doc_id: doc_id.to_owned(),
            origin,
            purged,
        });
    });
}

/// Runs `f` with the local updates it writes noted as [`Origin::External`]:
/// a body fed from the vault file. Call it inside the write closure.
pub fn as_external<T>(f: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            EXTERNAL.set(self.0);
        }
    }
    let _restore = Restore(EXTERNAL.replace(true));
    f()
}

/// Runs `f`, recording what it writes when `on`; returns what it recorded.
pub(crate) fn recording<T>(on: bool, f: impl FnOnce() -> T) -> (T, Vec<BodyWrite>) {
    struct Restore(Option<Option<Vec<BodyWrite>>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            if let Some(outer) = self.0.take() {
                RECORDED.set(outer);
            }
        }
    }
    let mut restore = Restore(Some(RECORDED.replace(on.then(Vec::new))));
    let value = f();
    let outer = restore.0.take().unwrap_or_default();
    let writes = RECORDED.replace(outer).unwrap_or_default();
    (value, writes)
}
