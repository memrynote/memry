//! `Notes`, read-only: the folder tree, the note list, and one note's body
//! (T164). Reached from [`crate::api::vault::Vault::notes`], which is the only
//! way to build one — a `Notes` with a database handle nobody opened is a
//! `Notes` over the wrong vault.
//!
//! Every method here is a thin hop onto [`crate::domain::reads`], which holds
//! the queries and the rule they all obey: **an empty list means empty, never
//! "could not tell"**. The doc comments that matter are there.

use crate::api::errors::StorageError;
use crate::crdt::blocks::{Block, TableContent};
use crate::crdt::comments::ReviewComment;
use crate::crdt::errors::CrdtError;
use crate::domain::attachments::{self, BlockAttachment, CachedAttachment};
use crate::domain::note_meta::{self, NoteMetadata};
use crate::domain::reads::{
    self, FolderSummary, LinkedTask, NoteDetail, NoteSummary, ReminderSummary, TagSummary,
    TaskCard, TemplateSummary,
};
use crate::storage::Db;

/// The read-only content surface over one opened vault.
///
/// Every method **blocks** (spec-defect 90). Nothing here touches the network,
/// so there is nothing to suspend on; the shell runs them on its serial core
/// queue.
#[derive(uniffi::Object)]
pub struct Notes {
    pub(crate) db: Db,
}

impl Notes {
    /// Not exported: a `Notes` is only ever minted by the `Vault` that opened
    /// the database it reads.
    pub(crate) fn over(db: Db) -> Self {
        Self { db }
    }
}

#[uniffi::export]
impl Notes {
    /// Every live folder, parent before child.
    pub fn folders(&self) -> Result<Vec<FolderSummary>, StorageError> {
        self.db.call_blocking(|conn| reads::folders(conn))
    }

    /// Every live note, newest first. No folder filter — [`reads::notes`] says
    /// why one cannot be given an honest signature.
    pub fn list(&self) -> Result<Vec<NoteSummary>, StorageError> {
        self.db.call_blocking(|conn| reads::notes(conn))
    }

    /// The tasks linked to one note (N807).
    ///
    /// Both relationships in one list: a task carries `source_note_id` for the
    /// note it was written in and `linked_note_ids` for the ones it
    /// references. `from_this_note` tells them apart, because "this note made
    /// this task" and "this task mentions this note" are different facts.
    pub fn linked_tasks(&self, note_id: String) -> Result<Vec<LinkedTask>, StorageError> {
        self.db
            .call_blocking(move |conn| reads::tasks_for_note(conn, &note_id))
    }

    /// The card a `taskBlock` draws for its task: tick, priority, project
    /// and due date. `None` when this vault does not hold the task.
    pub fn task(&self, task_id: String) -> Result<Option<TaskCard>, StorageError> {
        self.db
            .call_blocking(move |conn| reads::task_card(conn, &task_id))
    }

    /// Every template a note can be made from (N803).
    pub fn templates(&self) -> Result<Vec<TemplateSummary>, StorageError> {
        self.db.call_blocking(|conn| reads::templates(conn))
    }

    /// The reminders pointing at one note (N804).
    ///
    /// **`triggeredAt` is not among them**, and §13.7.12 says why: each
    /// device shows its own notification, so a synced "already fired" would
    /// suppress it on a device that never displayed it. Dismiss and snooze do
    /// sync, and both are here.
    pub fn reminders(&self, note_id: String) -> Result<Vec<ReminderSummary>, StorageError> {
        self.db
            .call_blocking(move |conn| reads::reminders_for(conn, &note_id))
    }

    /// Every tag in this vault, with the number of live notes carrying it
    /// (N600).
    ///
    /// Ordered by count then name — the tags a user actually uses first, with
    /// a stable tie-break so two reads of an unchanged vault agree.
    pub fn tags(&self) -> Result<Vec<TagSummary>, StorageError> {
        self.db.call_blocking(|conn| reads::tags(conn))
    }

    /// The live notes carrying one tag (N600).
    ///
    /// Matched by the column's own `COLLATE NOCASE`, so a screen opened from
    /// `#café` finds a note that spelled it `#Café`. That is FR-047's
    /// "letter-case behaviour identical to desktop".
    pub fn notes_tagged(&self, tag: String) -> Result<Vec<NoteSummary>, StorageError> {
        self.db
            .call_blocking(move |conn| reads::notes_tagged(conn, &tag))
    }

    /// One note's tags, typed properties and aliases.
    ///
    /// `nil` is "no such note", the same answer [`Notes::read`] gives. A note
    /// that exists and carries none of these reads as **empty lists**, which is
    /// a different screen from a note that is gone.
    ///
    /// Property values cross as JSON text against a declared type name rather
    /// than as a closed union: §13.7.1 lets a property hold any JSON, and a
    /// shell that meets a type it does not know shows the raw value instead of
    /// dropping the property.
    pub fn metadata(&self, id: String) -> Result<Option<NoteMetadata>, StorageError> {
        self.db
            .call_blocking(move |conn| note_meta::metadata(conn, &id))
    }

    /// What a `[[wiki link]]` points at, by title and then by alias.
    ///
    /// `nil` is a **broken link, not a failure**: chapter 12 §12.3 carries a
    /// title rather than an id, so a link can name a note that does not exist
    /// and the shell offers to create it. Nothing is created here — a reader
    /// that wrote would turn scrolling past a broken link into an edit.
    pub fn resolve_wiki_target(&self, target: String) -> Result<Option<String>, StorageError> {
        self.db
            .call_blocking(move |conn| note_meta::resolve_wiki_target(conn, &target))
    }

    /// One note and its body, or `nil` when this vault holds no live note by
    /// that id.
    ///
    /// `nil` means "no such note". A note that exists and cannot be read
    /// **throws**, and the two must never be rendered the same way.
    ///
    /// The error is `CrdtError` rather than `StorageError` because a body is a
    /// CRDT document: a log row that will not decode is
    /// `CrdtError::Undecodable`, which is a permanently unreadable body and a
    /// different sentence from a failed disk read — and a failed disk read
    /// still crosses intact, as `CrdtError::Storage`, carrying the
    /// `StorageError` rather than flattening it.
    pub fn read(&self, id: String) -> Result<Option<NoteDetail>, CrdtError> {
        // The closure cannot return `CrdtError`, so the inner result is carried
        // out whole and unwrapped here. Mapping it to `StorageError` on the way
        // through would collapse `Undecodable` into "storage failure".
        self.db
            .call_blocking(|conn| Ok(reads::note(conn, &id)))
            .map_err(CrdtError::from)?
    }

    /// One note's body as blocks, for a shell that renders it rather than
    /// previewing it.
    ///
    /// `nil` is "no such note", exactly as in [`Self::read`]. An **empty list**
    /// is a note whose body this device holds and which contains nothing: two
    /// different facts, and a shell that renders them the same way reports an
    /// unpulled note as an empty one.
    ///
    /// Not a second source of truth for the same text — this and `read`'s
    /// `NoteBody.text` are two readings of one document rebuilt from one update
    /// log, and `tests/crdt_blocks.rs` holds them to the same lines.
    pub fn blocks(&self, id: String) -> Result<Option<Vec<Block>>, CrdtError> {
        self.db
            .call_blocking(|conn| Ok(reads::note_blocks(conn, &id)))
            .map_err(CrdtError::from)?
    }

    /// One table's rows, cells and column widths, by the `blockContainer` id
    /// [`Self::blocks`] reported for the `table` block.
    ///
    /// A second call rather than a field on `Block`, because a table is the
    /// one block whose shape a flat list cannot carry: rows and columns are
    /// two dimensions and `depth` is one. A shell asks for it when it meets a
    /// `table` block and not before, so a note full of tables costs nothing to
    /// scroll past.
    ///
    /// `nil` is "there is no such table here" — no such note, or a block id
    /// that holds something else.
    pub fn table(&self, id: String, block_id: String) -> Result<Option<TableContent>, CrdtError> {
        self.db
            .call_blocking(move |conn| Ok(reads::note_table(conn, &id, &block_id)))
            .map_err(CrdtError::from)?
    }

    /// Every review comment and suggestion on one note (N604).
    ///
    /// **Read only, and normatively so.** §12.5.1 forbids a non-editor client
    /// writing the `criticMarkupMarks` root; §12.5.0's root table says a drop
    /// deletes every suggestion from the file on desktop's next write-back.
    /// There is no matching write on this API on purpose.
    ///
    /// The offsets are into the note's flattened text and may cross blocks,
    /// so binding one to a block is the shell's job.
    pub fn comments(&self, id: String) -> Result<Vec<ReviewComment>, CrdtError> {
        self.db
            .call_blocking(move |conn| Ok(reads::note_comments(conn, &id)))
            .map_err(CrdtError::from)?
    }

    /// Every attachment this vault knows one note references (§14.7).
    ///
    /// **An empty list is not "this note has no attachments."** It is also
    /// what a note whose references have never arrived looks like, because an
    /// absent `attachmentReferences` means "this sender does not know"
    /// (chapter 13 §13.4). A shell must not render the two the same way.
    pub fn attachments(&self, id: String) -> Result<Vec<CachedAttachment>, StorageError> {
        self.db
            .call_blocking(move |conn| attachments::for_note(conn, &id))
    }

    /// What one body block's `url` points at (Q4).
    ///
    /// A block carries a **vault-relative path**, not an attachment id, so
    /// something has to bind the two. Desktop writes an embedded attachment to
    /// `attachments/<noteId>/<basename(manifest.filename)>` and resolves a
    /// block url against that same path, so the basename is the binding —
    /// `research.md` §Q4 carries the citations.
    ///
    /// Four answers rather than an optional one, because a shell draws each
    /// differently: a remote image is ordinary content rather than a failed
    /// download, and an **ambiguous** basename is refused rather than guessed,
    /// since showing the wrong picture is worse than showing a placeholder.
    pub fn attachment_for_block(
        &self,
        id: String,
        url: String,
    ) -> Result<BlockAttachment, StorageError> {
        self.db
            .call_blocking(move |conn| attachments::resolve_for_block(conn, &id, &url))
    }
}
