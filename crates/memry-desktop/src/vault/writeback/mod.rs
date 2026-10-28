//! The write-back (Step 12e-3a, #3529): a note's document body out to its vault file
//! (`performWriteback` and `writebackExisting` of desktop `crdt-writeback.ts`).
//!
//! [`WriteBack::schedule`] is the seam: the editor (Step 14) calls it after a body edit is
//! durable, the sync driver (Step 17) after a page commits. A scheduled note gets one pass on
//! the write-back thread; the debounce, the cooldown and the flush on quit are 12e-3b's.
//!
//! Invariants, each with a test in `tests/` here for every way a body changes (an edit in the
//! app, a body merged from sync) and a file changes (an outside edit):
//! - **No byte the document does not hold is written over.** A pass writes only a file whose
//!   bytes hash to its row's hash, which names a whole file the document holds
//!   (`vault::consumer`). A row without a hash, a file whose hash differs (an outside edit
//!   not fed yet), and a file that changes, moves or goes between that read and the write
//!   ([`crate::vault::note_file::write_note_over`]) are kept as they are. The row check, the
//!   write and the row record run under the rows' lane, so no feed lands in between.
//! - **No file is written while it is ahead of the document, or while the document is not the
//!   note's body**: the owed-file-body marker (an owed or a refused feed) and an unpulled
//!   server body keep the file ([`memry_core::domain::write_back`]).
//! - **Fail closed.** A body whose write would lose content (a node the schema cannot build,
//!   an element the read drops, a mark or attribute a newer build wrote), or that does not
//!   serialize, is not written.
//! - **Unedited bytes stay.** A body that serializes to the bytes on disk is no write: no
//!   mtime change, no watcher event. A write keeps the frontmatter block byte for byte unless
//!   the `writing` data changed, the line ends of the file, and its byte order mark.
//! - **A replaced body is kept.** Before a write changes a body that is not the one this
//!   session's write-back last wrote for the note, the whole file is kept as a version.
//! - **The app's write is not an outside edit.** The pass tells the own-write record
//!   ([`crate::vault::watch::EchoGuard`]) before it writes, records the row with the new hash,
//!   then publishes `Applied::Changed` with `ChangeSource::App`, under the lane.
//! - **One session.** A pass names the vault session it was started in and writes nothing
//!   once that session closed.
//!
//! A journal note's file is not written yet: its frontmatter rule (the date, the tags) comes
//! with the open reconcile (12e-3c). A file the note has no row or no file for is not
//! created: the note records create files (Step 13).

mod pass;
#[cfg(test)]
mod tests;

pub use pass::{Keep, Outcome, Pass};

use std::collections::HashSet;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

const SCOPE: &str = "vault_writeback";

/// The write-back thread of one vault session.
pub struct WriteBack {
    tx: Option<mpsc::Sender<String>>,
    /// Notes scheduled and not yet started: a second schedule of one is the same pass.
    pending: Arc<Mutex<HashSet<String>>>,
    thread: Option<JoinHandle<()>>,
}

impl WriteBack {
    pub(crate) fn start(pass: Pass) -> std::io::Result<Self> {
        let (tx, rx) = mpsc::channel::<String>();
        let pending: Arc<Mutex<HashSet<String>>> = Arc::default();
        let queued = pending.clone();
        let thread = std::thread::Builder::new()
            .name("vault-writeback".into())
            .spawn(move || {
                for note_id in rx {
                    // Taken off before the pass, so an edit during it schedules another.
                    queued
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&note_id);
                    log(&note_id, &pass.run(&note_id));
                }
            })?;
        Ok(Self {
            tx: Some(tx),
            pending,
            thread: Some(thread),
        })
    }

    /// Writes the note's body to its file, on the write-back thread.
    pub fn schedule(&self, note_id: &str) {
        let Some(tx) = &self.tx else { return };
        let fresh = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(note_id.to_owned());
        if fresh && tx.send(note_id.to_owned()).is_err() {
            tracing::error!(scope = SCOPE, note_id, "the write-back thread is gone");
        }
    }

    /// Lets the queued passes run, then joins the thread.
    pub(crate) fn stop(&mut self) {
        self.tx = None;
        if let Some(thread) = self.thread.take()
            && thread.join().is_err()
        {
            tracing::error!(scope = SCOPE, "the write-back thread panicked");
        }
    }
}

impl Drop for WriteBack {
    fn drop(&mut self) {
        self.stop();
    }
}

fn log(note_id: &str, outcome: &Outcome) {
    match outcome {
        Outcome::Wrote { .. } | Outcome::Unchanged => {
            tracing::debug!(scope = SCOPE, note_id, outcome = ?outcome);
        }
        Outcome::Kept(keep) => {
            tracing::info!(scope = SCOPE, note_id, keep = ?keep, "the file was kept");
        }
        Outcome::Failed(reason) => {
            tracing::error!(scope = SCOPE, note_id, "the write-back failed: {reason}");
        }
    }
}
