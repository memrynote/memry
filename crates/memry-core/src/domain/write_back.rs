//! What the desktop write-back (Step 12e-3) may put in a note's vault file: the body as the
//! note's document holds it, or why the file must be kept.
//!
//! The file is the user's data, and a write is permanent: the next outside read takes what
//! was written for the note. So every answer but [`BodyRead::Body`] keeps the file:
//! - the file holds an edit the document did not take (the owed-file-body marker, recorded
//!   for an owed and for a refused feed alike, [`super::owed_file_body`]);
//! - the note's server body has not been pulled ([`crate::sync::body_debt`]), so the
//!   document is not the note's body yet and could be empty;
//! - a write would lose content: the read does not keep every element, text run, mark and
//!   attribute ([`Converter::reads_losslessly`]): a node the schema cannot build, an element
//!   the read drops, a mark or attribute a newer build wrote;
//! - the serializer gave nothing, which includes an author's spelling it could not restore.
//!
//! The file-side rules (the row's hash, the bytes on disk) are the shell's. A journal day's
//! body is read as a note's is (Step 13m); the shell writes its frontmatter by the day's rule,
//! with the day's date ([`crate::domain::notes::journal_day::file_date`]).

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::crdt::BODY_FRAGMENT;
use crate::crdt::errors::CrdtError;
use crate::domain::notes::journal_day::body_owner;
use crate::domain::{note_snapshots, owed_file_body, reads};
use crate::markdown::convert::EmbedResolver;
use crate::markdown::convert::api::Converter;
use crate::markdown::convert::note_body::NoteBody;
use crate::markdown::convert::restore::SerializeOptions;
use crate::sync::body_debt;

#[derive(Debug, Clone, PartialEq)]
pub enum BodyRead {
    /// What the file gets: the body and its `writing` frontmatter.
    Body(NoteBody),
    /// No live note or journal day by that id.
    NoNote,
    /// The file holds an edit the document did not take.
    FileAhead,
    /// The server body has not been pulled.
    BodyNotPulled,
    /// Writing the body would lose content; the names of the nodes the schema cannot build,
    /// when that is what would go.
    NotRepresentable(Vec<String>),
    /// The serializer gave nothing.
    Failed(&'static str),
}

/// The body for the file at `note_path`, whose body is `file_body` (read with the bytes the
/// caller compared): the serializer restores the author's spelling from it. `embeds` is the
/// vault's image embed lookup for the proof parse, the one the body was seeded with. It runs
/// while this database's writer is held, so it must not read this database.
pub fn body_for_file(
    conn: &Connection,
    converter: &Converter,
    note_id: &str,
    note_path: &str,
    file_body: &str,
    embeds: &dyn EmbedResolver,
) -> Result<BodyRead, CrdtError> {
    if body_owner(conn, note_id)?.is_none() {
        return Ok(BodyRead::NoNote);
    }
    if owed_file_body::owes(conn, note_id)? {
        return Ok(BodyRead::FileAhead);
    }
    if body_debt::is_owed(conn, note_id)? {
        return Ok(BodyRead::BodyNotPulled);
    }
    let document = reads::document_of(conn, note_id)?;
    let read_file_body = || Ok(Some(file_body.to_owned()));
    let options = SerializeOptions {
        note_path: Some(note_path),
        read_file_body: Some(&read_file_body),
        embeds: Some(embeds),
        ..SerializeOptions::default()
    };
    // `None` too when the author's spelling could not be restored from the file
    // (`SourceRestoreOutcome::FileUnreadable`, `RestoreThrew`).
    let Some(body) = converter.serialize_note_body(&document, BODY_FRAGMENT, &options) else {
        return Ok(BodyRead::Failed("the body did not serialize"));
    };
    // One structural check: the read keeps every element, text run, mark and attribute. A
    // node the schema cannot build and an element the read drops both fail it.
    if !converter.reads_losslessly(&document, BODY_FRAGMENT) {
        return Ok(BodyRead::NotRepresentable(body.unrepresentable));
    }
    Ok(BodyRead::Body(body))
}

/// Keeps `content`, the whole file a write is about to replace, as a version of the note.
/// True when a row was written; a version with that content is not kept twice.
pub fn keep_replaced(
    conn: &Connection,
    note_id: &str,
    content: &str,
    body: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    let title = title(conn, note_id)?.ok_or_else(|| StorageError::Failed {
        what: format!("no note {note_id}"),
    })?;
    let version = note_snapshots::Version {
        note_id,
        content,
        body,
        title: &title,
        reason: note_snapshots::SIGNIFICANT,
    };
    note_snapshots::keep(conn, version, now_ms)
}

/// The live note's title, or the live day's date: the title its versions carry. `None` for
/// neither.
pub fn title(conn: &Connection, note_id: &str) -> Result<Option<String>, StorageError> {
    Ok(body_owner(conn, note_id)?.map(|owner| owner.title))
}
