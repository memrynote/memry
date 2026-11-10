//! Which note a vault file belongs to: the decisions that need the note records. The consumer
//! owns `note_files` and calls this trait; Step 13 implements it over the core's note records
//! (`crate::notes::identity`). Agreed on #3529 (issuecomment-6451032104, with Step 13's changes in
//! issuecomment-6452209253).
//!
//! An implementation is called on the consumer's one thread, may block for one core write,
//! reads `note_files` but never writes it, and never calls back into the consumer.
//!
//! An `Err` is logged with the note id and the fact is retried a few times in the session
//! ([`super::MAX_RETRIES`]); a removal or rename that fails waits for the next open. The
//! consumer has no user-facing surface: the implementation knows when it failed and is the one
//! that tells the user (Step 13), a note that keeps failing included.

use std::path::Path;

use memry_core::api::errors::StorageError;
use memry_core::api::search::Search;
use memry_core::api::vault::Vault;
use memry_core::domain::external_feed::FirstBody;

use crate::vault::file_types::FileType;
use crate::vault::note_file::NoteFile;

/// What every call gets. Valid for one vault session.
pub struct IdentityCtx<'a> {
    pub root: &'a Path,
    pub vault: &'a Vault,
    /// The vault's note index, which measures the files the rows name.
    pub search: &'a Search,
}

/// A file no row names.
#[derive(Clone, Copy)]
pub struct Candidate<'a> {
    /// Vault-relative, `/`-separated.
    pub path: &'a str,
    pub file_type: FileType,
    pub size: u64,
    pub modified_ms: i64,
    /// Markdown only: the text the consumer read, and its hash. The body the consumer seeds is
    /// this text, so the record and the seed describe the same file.
    pub file: Option<&'a NoteFile>,
}

/// A markdown file no row names, its text read, with the id its new note is to get and the body
/// its text gives that note, authored before the note exists.
#[derive(Clone, Copy)]
pub struct NewFile<'a> {
    pub candidate: Candidate<'a>,
    pub id: &'a str,
    pub body: &'a FirstBody,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Adoption {
    /// A record that has no row owns this file (same folder and title, and a body that is empty
    /// or already the file's text). The consumer records the row and seeds the body only if the
    /// record's body is empty: a crash between a create and its seed ends here. A body that
    /// already is the file's text gives the row the file's hash; another is left alone.
    Existing(String),
    /// A new record, created without a body. The consumer records the row and seeds the body
    /// from the file.
    Created(String),
    /// Not now. The consumer records nothing and does not retry; the next open's walk asks
    /// again.
    Defer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Removal {
    /// The record was deleted. The consumer then removes the row.
    Deleted,
    /// Record and row stay (a locked note, or a note or journal day whose row does not say the
    /// file held all of it: no bytes to pair a move on, a document that does not hold them, an
    /// edit the file never got); the row loses its hashes, since it names a file that is gone,
    /// so a file that shows up at that path later is not taken for the note's text. The next
    /// open reports the removal again.
    ///
    /// A kept note's file that shows up at another path is not paired with it: once its
    /// removal settled, the file is new to the watcher, whether the app was open or closed
    /// (a hash kept for pairing would cover only the closed app). It reaches
    /// [`NoteIdentity::adopt_or_create`] as a new file, and an identity that keeps notes must
    /// recognise its kept note there and answer `Existing`, or the file becomes a second
    /// note.
    Kept,
}

/// What a move did to the note's record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rename {
    /// The record follows the file, or is owed the move: the row moves.
    Followed,
    /// The move changed what the file is (a note to a day's path, a day out of the journal or
    /// to another date) and the record was deleted, as Electron re-creates such a file: the row
    /// goes, and the file at the new path is a new one ([`NoteIdentity::adopt_or_create`]).
    Crossed,
}

/// A record deleted for an owed move that changed what its file is ([`Rename::Crossed`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Crossed {
    pub note_id: String,
    /// Where the note's row and its file are.
    pub path: String,
}

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("storage: {0}")]
    Storage(#[from] StorageError),
    #[error("{0}")]
    Other(String),
}

pub trait NoteIdentity: Send + Sync {
    /// Whether this identity names a note for a new file at all. `false` lets the watcher's
    /// rescans and the open walk pass over files no row names without reading them.
    fn adopts(&self) -> bool {
        true
    }

    /// Whether the vault is one this app does not index yet (an Electron vault it did not
    /// import): no file of it gets a new note id while this holds, though one may still be
    /// matched to a note the core already has. Its activity log is left as it is: neither the
    /// walk nor the watcher's unsupported or unreadable files are recorded in it.
    fn leaves_vault(&self, _ctx: &IdentityCtx<'_>) -> bool {
        false
    }

    /// The tier opened the vault, before its consumer starts: for what the identity owes the
    /// vault from an earlier session. Its failures are its own to log.
    fn opened(&self, _ctx: &IdentityCtx<'_>) {}

    /// The note of a new file. Never the id of a deleted record. Idempotent: called again for
    /// the same file after a crash, it returns the record it created then.
    fn adopt_or_create(
        &self,
        ctx: &IdentityCtx<'_>,
        file: &Candidate<'_>,
    ) -> Result<Adoption, IdentityError>;

    /// For each of many markdown files no row names, their text read: whether it may become a
    /// new note with no record to match, so the consumer may author its body before the note
    /// exists and hand it to [`Self::adopt_new_files`]. A hint only, which saves authoring a
    /// body for a file that is not a new note (a journal day, a large file); `false` sends
    /// the file to [`Self::adopt_or_create`] alone.
    fn may_be_new(&self, _ctx: &IdentityCtx<'_>, files: &[Candidate<'_>]) -> Vec<bool> {
        vec![false; files.len()]
    }

    /// The notes of many new files at once, the open's first adoptions: for each, `true` when
    /// its note was created with the id and body given, all in one transaction that holds
    /// every such note's record and body; `false` to ask [`Self::adopt_or_create`] about that
    /// file alone. Answers what [`Self::adopt_or_create`] would for each file it creates
    /// ([`Adoption::Created`]) and never names a file another way. An `Err` created nothing.
    fn adopt_new_files(
        &self,
        _ctx: &IdentityCtx<'_>,
        files: &[NewFile<'_>],
    ) -> Result<Vec<bool>, IdentityError> {
        Ok(vec![false; files.len()])
    }

    /// The watcher reported the note's file removed (it passed the rename window and the
    /// mass-removal guard). Delete the record first: the consumer removes the row only after
    /// [`Removal::Deleted`], so a local-only note's flag is still there to read. Idempotent: a
    /// crash before the row is removed asks again at the next open, for a record already
    /// deleted, and the answer is `Deleted`.
    fn on_removed(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        path: &str,
    ) -> Result<Removal, IdentityError>;

    /// The note's file moved or was respelled. Called before the row moves, once `new_path`
    /// is known to be free; the row still names `old_path`. Updates the record (title,
    /// folder), or deletes it when the move changed what the file is ([`Rename::Crossed`]),
    /// never the file. The row moves or goes only after `Ok`: on an `Err` record and row both
    /// stay at the old path, and the next open's rescan reports the move again. A crossing
    /// whose row the consumer did not drop (a crash) is owed, and [`Self::settle_crossings`]
    /// returns it at the next open.
    fn on_renamed(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        old_path: &str,
        new_path: &str,
    ) -> Result<Rename, IdentityError>;

    /// Once the queue went quiet after a batch of facts, with the rows' lane released: the
    /// journal setting follows a journal folder whose days the batch held (`notes::owed_moves::follow_held`). `true` when
    /// it followed, for the consumer to say so ([`super::Applied::JournalFollowed`]).
    fn follow_held(&self, _ctx: &IdentityCtx<'_>) -> bool {
        false
    }

    /// Before the open walk: deletes the records of the owed moves that changed what their
    /// file is and returns them, whose rows the consumer drops and whose files it asks about
    /// as new ([`Rename::Crossed`]). Its failures are its own to log.
    fn settle_crossings(&self, _ctx: &IdentityCtx<'_>) -> Vec<Crossed> {
        Vec::new()
    }

    /// An edit outside the app replaced the note's file, and its document took the file's text
    /// (`file`); `previous` is the hash of the file it replaced, which the row named. Gives the
    /// record what the file's frontmatter says of it (#3825). Never called for bytes the app
    /// wrote. Called too when an editor save replaces such a file before the consumer fed it
    /// (`AppEdit`, `Precondition::Save`): the document then takes the save's text. An `Err` retries the fact, and the document answers the same text `Unchanged`,
    /// so an implementation is idempotent.
    fn on_changed(
        &self,
        _ctx: &IdentityCtx<'_>,
        _note_id: &str,
        _previous: &str,
        _file: &NoteFile,
    ) -> Result<(), IdentityError> {
        Ok(())
    }

    /// Whether the app's own move of the note's file to `new_path` keeps what the file is, so
    /// its record may follow (Step 13g). `false` when it changes that, or when that is not
    /// known: the record then stays as it was and is owed the move, as for
    /// [`Self::on_renamed`]. An identity that does not say keeps nothing (fails closed): a
    /// record owed a move is settled later, one moved into the wrong kind is not.
    fn keeps_kind(
        &self,
        _ctx: &IdentityCtx<'_>,
        _note_id: &str,
        _new_path: &str,
    ) -> Result<bool, IdentityError> {
        Ok(false)
    }
}

/// The identity of a tier nothing set one on ([`super::VaultTier::set_identity`]): adopts
/// nothing and deletes nothing, so a file outside the index stays outside it. The app sets the
/// notes identity (`crate::notes::identity`).
pub struct DeferIdentity;

impl NoteIdentity for DeferIdentity {
    fn adopts(&self) -> bool {
        false
    }

    fn adopt_or_create(
        &self,
        _: &IdentityCtx<'_>,
        _: &Candidate<'_>,
    ) -> Result<Adoption, IdentityError> {
        Ok(Adoption::Defer)
    }

    fn on_removed(&self, _: &IdentityCtx<'_>, _: &str, _: &str) -> Result<Removal, IdentityError> {
        Ok(Removal::Kept)
    }

    fn on_renamed(
        &self,
        _: &IdentityCtx<'_>,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<Rename, IdentityError> {
        Ok(Rename::Followed)
    }
}
