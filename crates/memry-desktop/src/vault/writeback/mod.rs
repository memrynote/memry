//! The write-back (Step 12e-3, #3529): a note's document body out to its vault file
//! (`performWriteback` and `writebackExisting` of desktop `crdt-writeback.ts`).
//!
//! [`WriteBack::schedule`] is the seam: the editor (Step 14) calls it after a body edit is
//! durable, the sync driver (Step 17) after a page commits. A scheduled note gets a pass on
//! the write-back thread once it is quiet (`schedule`).
//!
//! Invariants, each with a test in `tests/` here for every way a body changes (an edit in the
//! app, a body merged from sync) and a file changes (an outside edit).
//!
//! **What** a pass writes:
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
//! **When** a pass runs:
//! - **Once the note is quiet.** A note's pass runs [`DEBOUNCE`] after its last schedule, and
//!   not before the cooldown of its last pass ends: [`COOLDOWN_FACTOR`] times what that pass
//!   took, at most [`MAX_COOLDOWN`]. One pass runs at a time; a schedule while the note's pass
//!   runs gives it one more pass after it.
//! - **Nothing scheduled waits out a quit or a close.** [`WriteBack::flush`] makes every
//!   scheduled pass due now and waits for them and the one running. The `flush-writebacks`
//!   shutdown step calls it on every way the app quits (the app menu, Cmd-Q, the Dock, a
//!   session end, an update restart), within its share of the budget
//!   ([`crate::shell::shutdown::writeback_flush_timeout`]) so the steps behind it still run,
//!   and again in the last chance when a step before it wedged
//!   ([`crate::vault::consumer::VaultTier::flush_step`]). A vault close, the quit's included,
//!   runs every pass scheduled until the write-back stops, after the watcher and the consumer
//!   stopped and before the rows close. A schedule during either is due at once. The close
//!   has no bound of its own on those passes: the session goes on after its close hook
//!   deadline and the quit after the sequence budget, and a pass still running when the
//!   process ends is a forced exit (below). A close that ends after the next vault opened
//!   stops only its own vault's write-back and rows.
//! - **A crash or a forced exit leaves files behind their bodies, never the reverse.** The
//!   body is durable in the document before its note is scheduled, and the queue is in
//!   memory, so a process that ends before a pass leaves that note's file with older text and
//!   a row hash that still matches it. The open reconcile (12e-3c) brings such files to their
//!   bodies: a pass for every note whose body may be newer than its file writes exactly the
//!   notes this left behind. Until it runs, an outside edit of such a file replaces the newer
//!   body, which the feed keeps as a version.
//! - **A failed write is told, once per run of failures.** The first failed pass of a note
//!   sends [`WriteBackFailed`]; the next pass that does not fail ends the run. A failed pass is
//!   not retried on its own: the note's next schedule is its retry, and its body stays in the
//!   document until then.
//!
//! A journal note's file is not written yet: its frontmatter rule (the date, the tags) comes
//! with the open reconcile (12e-3c). A file the note has no row or no file for is not
//! created: the note records create files (Step 13).

mod pass;
mod schedule;
#[cfg(test)]
mod tests;

pub use pass::{Keep, Outcome, Pass};
pub use schedule::{COOLDOWN_FACTOR, DEBOUNCE, MAX_COOLDOWN, WriteBack, WriteBackFailed};
