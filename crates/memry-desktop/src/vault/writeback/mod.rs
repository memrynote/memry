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
//!   bytes hash to its row's hash, which names a file whose text the document holds
//!   (`vault::consumer`). A row without a hash, a file whose hash differs (an outside edit
//!   not fed yet), and a file that changes, moves or goes between that read and the write
//!   ([`crate::vault::note_file::write_note_over`], which never creates a folder) are kept as
//!   they are. A file whose frontmatter does not parse holds a block the document does not:
//!   it cannot be read back, so its pass fails and the user is told, and the document keeps
//!   the edits made in the app until the file is fixed (#3750). The row check, the write and
//!   the row record run under the rows' lane, so no feed lands in between; the lane is held for the whole pass (one note's replay, serialize
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
//!   runs gives it one more pass after it, once that pass's cooldown ended.
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
//!   a row hash that still matches it. Until the next open's reconcile, an outside edit of
//!   such a file replaces the newer body, which the feed keeps as a version.
//! - **Every open brings the files left behind to their bodies, and touches no other file**
//!   ([`reconcile`]). Once the open walk ends, so the outside edits made while the vault was
//!   closed are fed, every note whose row says the document holds its file and whose body
//!   moved after that row was stamped gets a pass ([`memry_core::domain::note_files::behind_bodies`]).
//!   A note whose body did not move gets none, even when its document would write other
//!   bytes (a file the read does not keep whole, seeded as the reference app seeds it): a
//!   file the app did not change is never rewritten.
//!
//!   A row's stamp has one meaning for every writer: the row accounts for every change to the
//!   file and to the body made at or before it
//!   ([`memry_core::domain::note_files::NoteFile::indexed_at`]). A pass stamps the time before
//!   it read the body, whether it wrote or found the file unchanged, so an edit made while it
//!   ran is after the stamp and a reconciled note is not behind again. The consumer stamps a
//!   feed when it records it, after the feed. A file read again and found to be the row's
//!   bytes says nothing of the body, so that refresh moves the stamp only while the body has
//!   not moved since; otherwise a pass a crash cut short would vanish from the reconcile the
//!   moment the open walk re-read its file. Body entries are stamped under the database's
//!   writer, which the pass also reads the body under, so an entry the pass did not see is
//!   stamped after the pass's stamp. The stamps are this device's clock: an entry stamped in
//!   the same millisecond as its row, or before it by a clock set back, is not seen, and that
//!   file waits for the note's next edit. A note whose pass keeps its file for good (a file
//!   ahead of its body, a body that would not write whole) stamps nothing, so it stays behind: every open
//!   reads its file again (a refresh, which keeps the stamp) and runs its pass again, which
//!   keeps the file again.
//! - **A deleted note's file goes to the OS trash, never away for good, and only while it is
//!   the file the note held** ([`Pass::trash_deleted`]). Before its passes, the open
//!   reconcile moves to the trash the file of every tombstoned note and journal day
//!   ([`memry_core::domain::note_files::rows_of_deleted_notes`]): a deletion made on another
//!   device, or one whose file removal a crash cut short. The file goes only when its bytes
//!   are still the ones its row read; a file edited since, or one the document never took,
//!   holds bytes the note did not, and stays with its row. A file whose frontmatter does not
//!   parse is one the document took once its text was fed (#3750), so it goes to the trash
//!   too, its block with it, and can be put back from there. A row whose file is gone is
//!   removed. A note with no record here is not a deleted one: its record may not have
//!   arrived yet. A file the trash refuses stays, with its row, for the next open. Each file
//!   holds the rows' lane from its check to its row's removal, and a stop or a close ends the
//!   run between files. The check and the move are two steps: an outside edit that lands
//!   between them goes to the trash with the file, from which it can be put back. The trash
//!   is the OS's: on a Windows volume without a Recycle Bin (a network share), the shell
//!   deletes the file for good and reports success, as desktop's unlink always did (measured
//!   on Windows 11 with `trash` 5.2.9: the file was neither in the Recycle Bin nor on the share).
//! - **A failed write is told, once per run of failures.** The first failed pass of a note
//!   sends [`WriteBackFailed`]; the next pass that does not fail ends the run. A failed pass is
//!   not retried on its own: the note's next schedule is its retry, and its body stays in the
//!   document until then.
//!
//! A journal day's file is not written: journal files are not fed (`external_feed` answers
//! `NoNote`), so no journal row says the document holds its file. Its frontmatter rule
//! (desktop `writebackJournal`: the day's `date`) comes with the stage that feeds them. A
//! file the note has no row or no file for is not created: the note records create files
//! (Step 13).

mod deleted;
mod pass;
mod reconcile;
mod schedule;
#[cfg(test)]
mod tests;

pub use deleted::Leftover;
pub use pass::{Keep, Outcome, Pass};
pub(crate) use reconcile::reconcile;
pub use schedule::{COOLDOWN_FACTOR, DEBOUNCE, Failure, MAX_COOLDOWN, WriteBack, WriteBackFailed};
