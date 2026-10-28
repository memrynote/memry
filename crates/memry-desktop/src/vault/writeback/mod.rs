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
//!   ([`crate::vault::note_file::write_note_over`], which never creates a folder) are kept as
//!   they are. The row check, the write and the row record run under the rows' lane, so no
//!   feed lands in between; the lane is held for the whole pass (one note's replay, serialize
//!   and write, about 20 ms at 12 KB), which is what the consumer waits at most.
//! - **No file is written while it is ahead of the document, or while the document is not the
//!   note's body**: the owed-file-body marker (an owed or a refused feed) and an unpulled
//!   server body keep the file ([`memry_core::domain::write_back`]).
//! - **Fail closed.** A body whose write would lose content (a node the schema cannot build,
//!   an element the read drops, a mark or attribute a newer build wrote), or that does not
//!   serialize, is not written.
//! - **The document holds the content, not every byte.** A row's hash says the document holds
//!   the file's body text and its `writing` data, not how the file spells them: the frontmatter
//!   block, the YAML spelling of the `writing` data, line ends, final newlines, the byte order
//!   mark. So a pass writes only when the document's content differs from the file's (the
//!   text after line-end normalization, the parsed `writing` data); an untouched note is no
//!   write, no mtime change, no watcher event. A write keeps those bytes where it can: the
//!   block byte for byte unless the `writing` data changed, the byte order mark, the file's
//!   line ends for the lines it writes.
//! - **Bytes a write does change and the document does not hold are kept first.** Before a
//!   write changes the frontmatter block or the body's bytes, the whole file is kept as a
//!   version, unless it is what this session's write-back last wrote for the note. A version
//!   that cannot be saved stops the write: the file is the only copy of those bytes.
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
