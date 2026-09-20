//! `Notes`, read-only: the folder tree, the note list, and one note's body
//! (T164). Reached from [`crate::api::vault::Vault::notes`], which is the only
//! way to build one — a `Notes` with a database handle nobody opened is a
//! `Notes` over the wrong vault.
//!
//! Every method here is a thin hop onto [`crate::domain::reads`], which holds
//! the queries and the rule they all obey: **an empty list means empty, never
//! "could not tell"**. The doc comments that matter are there.

use crate::api::errors::StorageError;
use crate::crdt::blocks::Block;
use crate::crdt::errors::CrdtError;
use crate::domain::reads::{self, FolderSummary, NoteDetail, NoteSummary};
use crate::storage::Db;

/// The read-only content surface over one opened vault.
///
/// Every method **blocks** (spec-defect 90). Nothing here touches the network,
/// so there is nothing to suspend on; the shell runs them on its serial core
/// queue.
#[derive(uniffi::Object)]
pub struct Notes {
    db: Db,
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
}
