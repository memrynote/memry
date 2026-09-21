//! The read half of the projections: what a shell shows before it edits
//! anything (T164, FR-021's "route to it", FR-041's note read).
//!
//! Every function here is a `SELECT` over the typed projections of data-model
//! §A.4 plus, for a note body, the CRDT update log of chapter 07. Nothing here
//! writes, enqueues an outbox row, or touches the network — the read path is
//! the one path that must be safe to run before a vault has ever been pushed
//! to.
//!
//! **No markdown.** A body crosses as `extract_text` output, which chapter 12
//! §12.1's table names the **only** text operation a non-editor client owns: a
//! plain-text walk that keeps headings and list markers, drops everything else
//! and claims no markdown fidelity. The core neither parses nor serialises
//! BlockNote markdown here or anywhere.
//!
//! ## The one rule that shapes every function below
//!
//! **An empty answer means empty, and never "could not tell."**
//! [`crate::protocol::account`]'s module doc records what the other reading
//! costs: a `GET /sync/vaults` reader used `filter_map`, and reported "this
//! account has no vaults" against an account holding four. So:
//!
//! - every row is collected with `collect::<Result<Vec<_>, _>>()`. A row that
//!   will not decode fails the whole list. There is no `filter_map`, no
//!   `.ok()`, and no `.flatten()` in this file, and adding one is the bug.
//! - [`note`] answers `None` **only** when the query succeeded and matched no
//!   live row. Every other outcome is an error.
//! - [`NoteBody::present`] carries the same distinction one level down, for the
//!   case a `String` alone cannot express: a note whose body this device has
//!   never pulled extracts to `""`, and so does a note the user genuinely left
//!   empty. Without the flag a shell would render "this note is empty" over a
//!   note whose text is sitting on the server.

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension as _, Row};

use crate::api::errors::StorageError;
use crate::crdt::blocks::{Block, TableContent, extract_blocks, extract_table};
use crate::crdt::comments::{ReviewComment, extract_comments};
use crate::crdt::errors::CrdtError;
use crate::crdt::registry::{Document, DocumentRegistry, UpdateSink};
use crate::crdt::text_extract::extract_text;
use crate::crdt::update_log;

/// The device id the read-only document registry runs under.
///
/// Reading a body never appends an update, so the Yjs client id this derives
/// affects nothing: no write leaves the document. A write path takes the
/// registered device id instead (chapter 07, research R2), and must never
/// reuse this constant.
const READER_DEVICE_ID: &str = "memry-core-reader";

/// One row of the `folders` projection (data-model §A.4, chapter 13 §13.7.10).
///
/// `parent_path` and `name` are the projector's split of `path`, carried rather
/// than re-derived so a shell building a tree does not string-split on every
/// row — and so that it splits the same way the core does.
///
/// **This is the `folder_config` projection and nothing else.** A folder that
/// holds notes but has never had a `folder_config` record written for it has no
/// row here; §13.7.10 makes such folders legal, and no chapter says whether a
/// folder tree must show them. Inventing them in the core would be inventing
/// policy, so the list is the records, honestly.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FolderSummary {
    pub path: String,
    /// `None` is a folder at the vault root.
    pub parent_path: Option<String>,
    pub name: String,
    pub icon: Option<String>,
}

/// One row of the `notes` projection.
///
/// `content` is deliberately absent, as it is from the table: the body lives in
/// the CRDT log and crosses through [`note`].
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    /// `None` is the vault root (chapter 13 §13.4's explicit null).
    pub folder_path: Option<String>,
    pub emoji: Option<String>,
    /// Epoch milliseconds (data-model §A.6). `None` means the payload carried
    /// no such instant, never "zero".
    pub created_at: Option<i64>,
    pub modified_at: Option<i64>,
}

/// A note's body as the core can express it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NoteBody {
    /// `extract_text` output (chapter 12 §12.1). Plain text, not markdown.
    pub text: String,
    /// Whether this device holds **any** body state for the note at all.
    ///
    /// `false` with an empty `text` is "the body has not been pulled here";
    /// `true` with an empty `text` is "the user left this note empty". A shell
    /// that renders them identically is reporting an unread note as an empty
    /// one, which is the failure this whole module is written against.
    pub present: bool,
}

/// A note and its body.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NoteDetail {
    pub summary: NoteSummary,
    pub body: NoteBody,
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// Every live folder, parent before child.
///
/// `ORDER BY path` is a total order on a unique primary key, so two runs over
/// an unchanged database return the same sequence — and because a child's path
/// is its parent's plus a separator, it is also the order a tree builder wants.
pub fn folders(conn: &Connection) -> Result<Vec<FolderSummary>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT path, parent_path, name, icon FROM folders \
             WHERE deleted_at IS NULL \
             ORDER BY path",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row: &Row<'_>| {
            Ok(FolderSummary {
                path: row.get(0)?,
                parent_path: row.get(1)?,
                name: row.get(2)?,
                icon: row.get(3)?,
            })
        })
        .map_err(failed)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(failed)
}

/// Every live note, newest first.
///
/// **There is no folder filter, deliberately.** The obvious signature is
/// `notes(folder: Option<String>)`, and it has no honest reading: `None` is
/// both "every folder" and "the vault root", and the root is a real folder
/// holding real notes (§13.4). A shell filters on `folder_path`, where the two
/// are different values rather than the same absent one.
pub fn notes(conn: &Connection) -> Result<Vec<NoteSummary>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id, title, folder_path, emoji, created_at, modified_at FROM notes \
             WHERE deleted_at IS NULL \
             ORDER BY COALESCE(modified_at, created_at, 0) DESC, id",
        )
        .map_err(failed)?;
    let rows = statement.query_map([], read_summary).map_err(failed)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(failed)
}

fn read_summary(row: &Row<'_>) -> Result<NoteSummary, rusqlite::Error> {
    Ok(NoteSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        folder_path: row.get(2)?,
        emoji: row.get(3)?,
        created_at: row.get(4)?,
        modified_at: row.get(5)?,
    })
}

/// Whether this vault holds a **live** note by that id.
///
/// The same `deleted_at IS NULL` predicate [`note`] reads under, and
/// deliberately not a second opinion about it: chapter 07 §7.15 forbids pulling
/// the body of a tombstoned document, and a liveness check that could disagree
/// with the read would let a note be fetched that the note view says is gone.
/// It decodes nothing, so it costs one indexed row rather than a whole update
/// log.
pub fn note_exists(conn: &Connection, id: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM notes WHERE id = ?1 AND deleted_at IS NULL",
        rusqlite::params![id],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// One note and its body, or `None` when this vault holds no live note by that
/// id.
///
/// `None` is reachable from exactly one place: a successful query that matched
/// no row. A failure to read, to decode the log, or to extract the text is an
/// error — a note that exists but cannot be read must never present as a note
/// that does not exist, because the shell's answer to the second is "it was
/// deleted" and to the first is "something is wrong here".
pub fn note(conn: &Connection, id: &str) -> Result<Option<NoteDetail>, CrdtError> {
    let summary = conn
        .query_row(
            "SELECT id, title, folder_path, emoji, created_at, modified_at FROM notes \
             WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![id],
            read_summary,
        )
        .optional()
        .map_err(failed)?;
    let Some(summary) = summary else {
        return Ok(None);
    };
    Ok(Some(NoteDetail {
        body: body(conn, id)?,
        summary,
    }))
}

/// One note's body as blocks, for a shell that renders rather than previews.
///
/// `None` has the same meaning it has in [`note`]: the query succeeded and
/// matched no live row. **An empty list is not `None`** — it is a note whose
/// body this device holds and which contains nothing, and a caller that
/// rendered the two the same way would report an unpulled note as an empty
/// one, which is the failure [`NoteBody::present`] exists against.
pub fn note_blocks(conn: &Connection, id: &str) -> Result<Option<Vec<Block>>, CrdtError> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM notes WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    if exists.is_none() {
        return Ok(None);
    }
    let document = document_of(conn, id)?;
    Ok(Some(extract_blocks(&document)?))
}

/// One table's structure inside one note's body.
///
/// Two ways to get `None`, and they are deliberately the same answer: the note
/// is gone, or the block id names something that is not a table. The caller
/// asked "what does this table look like" and the honest reply to both is
/// "there is no such table" — a shell only reaches here for a block it has
/// already seen with `kind == "table"`.
pub fn note_table(
    conn: &Connection,
    id: &str,
    block_id: &str,
) -> Result<Option<TableContent>, CrdtError> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM notes WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    if exists.is_none() {
        return Ok(None);
    }
    let document = document_of(conn, id)?;
    extract_table(&document, block_id)
}

/// Every review comment and suggestion on one note (N604).
///
/// Read only: §12.5.1 forbids a non-editor client writing the
/// `criticMarkupMarks` root, and §12.5.0 says what dropping it costs.
pub fn note_comments(conn: &Connection, id: &str) -> Result<Vec<ReviewComment>, CrdtError> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM notes WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    if exists.is_none() {
        // An empty list rather than an error: a note that is not here has no
        // comments, and that is an answer.
        return Ok(Vec::new());
    }
    let document = document_of(conn, id)?;
    extract_comments(&document)
}

/// The body of one document, from whatever the update log already holds.
///
/// A read, never a fetch: chapter 07's downward body feed is the sync tier's,
/// and a read path that reached for the network would be a second sync client
/// the core cannot see.
fn body(conn: &Connection, doc_id: &str) -> Result<NoteBody, CrdtError> {
    let present = !update_log::load_plan(conn, doc_id)?.is_empty();
    let document = document_of(conn, doc_id)?;
    Ok(NoteBody {
        text: extract_text(&document)?,
        present,
    })
}

/// The document a body id resolves to, rebuilt from the durable log.
///
/// Shared by [`body`] and [`note_blocks`], so the text preview and the rendered
/// blocks are two readings of the **same** document rather than two loads that
/// could disagree about which updates had arrived.
fn document_of(conn: &Connection, doc_id: &str) -> Result<Arc<Document>, CrdtError> {
    // The document id of a note body is the note record's id (chapter 07 §7.1).
    let plan = update_log::load_plan(conn, doc_id)?;
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new(READER_DEVICE_ID, sink).get_or_open(doc_id)?;
    for blob in plan.blobs() {
        document.apply_durable_update(blob)?;
    }
    Ok(document)
}
