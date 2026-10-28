//! Which note a vault file belongs to: the decisions that need the note records. The consumer
//! owns `note_files` and calls this trait; Step 13 implements it over the core's note records
//! (`notes/identity.rs`). Agreed on #3529 (issuecomment-6451032104, with Step 13's changes in
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
use memry_core::api::vault::Vault;

use crate::vault::file_types::FileType;
use crate::vault::note_file::NoteFile;

/// What every call gets. Valid for one vault session.
pub struct IdentityCtx<'a> {
    pub root: &'a Path,
    pub vault: &'a Vault,
}

/// A file no row names.
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Adoption {
    /// A record that has no row owns this file (same folder and title, or a record whose file
    /// moved while the app was closed). The consumer records the row and seeds the body only if
    /// the record's body is empty: a crash between a create and its seed ends here.
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
    /// Record and row stay (a locked note, or policy); the row loses its hash, since it names
    /// a file that is gone. The next open reports the file again.
    Kept,
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

    /// The note of a new file. Never the id of a deleted record. Idempotent: called again for
    /// the same file after a crash, it returns the record it created then.
    fn adopt_or_create(
        &self,
        ctx: &IdentityCtx<'_>,
        file: &Candidate<'_>,
    ) -> Result<Adoption, IdentityError>;

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
    /// folder), never the file. The row moves only after `Ok`: on an `Err` record and row both
    /// stay at the old path, and the next open's rescan reports the move again.
    fn on_renamed(
        &self,
        ctx: &IdentityCtx<'_>,
        note_id: &str,
        old_path: &str,
        new_path: &str,
    ) -> Result<(), IdentityError>;
}

/// The identity until Step 13 registers its own: adopts nothing, deletes nothing, so a file
/// outside the index stays outside it, as the app behaves before 13c.
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
    ) -> Result<(), IdentityError> {
        Ok(())
    }
}
