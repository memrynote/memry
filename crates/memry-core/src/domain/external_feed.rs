//! Feeds an edit made outside the app into a note's document (desktop
//! `feedExternalEditToCrdt`, `sync/crdt-external-feed.ts`).
//!
//! The vault file is the user's, and an editor, a sync client or a script can
//! change it while the app runs. The document is what syncs, so an edit that
//! never reaches it is an edit no other device sees, and the write-back would
//! later replace the file with the older document body.
//!
//! **No resident document.** The app holds no open document of a note until the
//! editor does (Step 14). So, like every other body write in the core
//! ([`super::body_write`]), the document is replayed from the durable log, the
//! converter replaces its body, and the update the transaction authored is
//! stored with its outbox row in one transaction. The whole step runs on the
//! writer connection, so no sync apply can land between the replay and the
//! append. It holds the writer for one replay, one serialization and one
//! conversion of the note: milliseconds for an ordinary note, longer for one
//! near the large-file class, during which other writes of the vault wait. Step
//! 14 switches the caller to its resident editor.
//!
//! **A feed never removes what the file cannot hold, and never removes a body
//! without keeping it.** The replace empties the body and rebuilds it from the
//! markdown, so:
//!
//! - a body this build cannot read whole is refused ([`FeedOutcome::Refused`]),
//!   the way the write-back refuses to write it: replacing it would delete the
//!   part no file holds, on every device. One structural check decides it
//!   ([`crate::markdown::convert::canonical::read_is_lossless`]): every element,
//!   text run, mark and attribute of the fragment must reach the document this
//!   build reads, so a block type, a mark or an attribute a newer build added
//!   refuses the feed, as does a block markdown cannot hold;
//! - a refused feed owes the file body ([`super::owed_file_body`]), so the file,
//!   which holds an edit the document did not take, is never written over: the
//!   write-back (12e-3) skips a note that owes its file body;
//! - a body that already serializes to the file's text, with the file's
//!   `writing` frontmatter, is not fed again ([`FeedOutcome::Unchanged`]), so a device whose file merely caught up with
//!   a synced body pushes no second copy;
//! - a body that is replaced is first kept as a version of the whole file, under
//!   the file's frontmatter ([`super::note_snapshots::keep`]), so an edit this device holds and the file
//!   does not (a peer's, merged after the file was last written) can be restored.
//!
//! The replace is not a merge. Two devices feeding the same new text into one
//! body at the same time each delete the old body and insert their copy, and the
//! merge holds both; a peer's edit inside a paragraph the feed replaced, not
//! merged here yet, lands in deleted text. The version above is what recovers
//! either. A diff-based feed that keeps unchanged blocks would avoid both and is
//! not built.
//!
//! **A note whose server body is not here yet is not fed.** Its document is
//! empty or partial, and a body replaced into it shares no Yjs items with the
//! server body: the merge would hold two copies (#2536). A note or journal
//! record from the server stays owed a body pull until its body is wholly in
//! the log, through every door that lands one (the feed page, the first sync's
//! metadata and bodies passes: the invariant of [`crate::sync::body_debt`]), so
//! "owed a body pull" is exactly "the document awaits its merge". The note owes
//! its file body instead ([`super::owed_file_body`]), written in the same
//! transaction that read the debt, and the step that merges the server body takes
//! the file then (Step 17).
//!
//! An empty document of a note that is not owed a pull is fed like any other:
//! the note was made on this device and has no body anywhere else, so the file
//! text is its first body. (Electron answered "false" there and let the next
//! editor open seed it; with no editor in the picture the feed is the seed.)
//!
//! [`seed_body_if_empty`] is the same step for a file whose note record already
//! exists (adopted by folder path and title, or left by a crash between the
//! record and its seed): it writes only into an empty body, so it can never
//! replace a body the document already holds.
//!
//! A body that cannot ride as one update is never fed: either the markdown is
//! large-file class (over 1 MB, or a run of 128 KB with no blank line), or the
//! update it authors packs past the server's 5 MiB cap
//! ([`crate::protocol::crdt_envelope::packed_len`], the measure the server
//! applies; the raw markdown length is wrong both ways). The caller must not
//! treat the file as read. The same holds for [`FeedOutcome::Refused`].

use std::sync::{Arc, Mutex, PoisonError};

use rusqlite::Connection;

use crate::crdt::BODY_FRAGMENT;
use crate::crdt::epoch;
use crate::crdt::errors::CrdtError;
use crate::crdt::markdown_seed::body_is_empty;
use crate::crdt::registry::UpdateSink;
use crate::domain::body_write::append_in;
use crate::domain::notes::ITEM_TYPE;
use crate::domain::{note_snapshots, owed_file_body, reads};
use crate::markdown::convert::api::{Converter, ReplaceOptions};
use crate::markdown::convert::apply::ReplaceOutcome;
use crate::markdown::convert::restore::SerializeOptions;
use crate::markdown::shared::markdown_class::{MarkdownClassThresholds, classify_markdown_content};
use crate::markdown::shared::writing_tools::WritingFrontmatter;
use crate::protocol::account::MAX_UPDATE_BYTES;
use crate::protocol::crdt_envelope;
use crate::sync::body_debt;

/// What a feed did. Anything but [`FeedOutcome::Fed`] left the document and the
/// outbox as they were.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedOutcome {
    /// The markdown is now the note's body; its update is stored and queued.
    Fed,
    /// The note's server body is not here yet. Nothing was written; the note now
    /// owes its file body.
    Owed,
    /// No update can carry this markdown: large-file class, or its update packs
    /// past [`MAX_UPDATE_BYTES`].
    LargeFile,
    /// Seed only: the document already holds a body, which was left alone.
    BodyPresent,
    /// The document's body already serializes to this markdown: nothing was
    /// written, and the file counts as read.
    Unchanged,
    /// Nothing was written, and the note now owes its file body: the file holds
    /// an edit the document did not take. The caller logs it with the note id and
    /// the reason, and does not treat the file as read.
    Refused(Refusal),
    /// This vault holds no live note by that id. A journal day's file answers
    /// this too: journals are not fed (their documents live under `journal_entries`).
    /// The caller must not treat the file as read.
    NoNote,
}

/// Why a feed wrote nothing although the file differs from the body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The body holds what this build cannot read whole (a block type, a mark or
    /// an attribute a newer build added, or a node the schema would drop):
    /// replacing it would delete that on every device.
    BodyNotRepresentable,
    /// The file's markdown does not convert, or the converter refused the replace.
    FileNotConvertible,
}

/// The file's text and where it lives.
pub struct FeedInput<'a> {
    pub note_id: &'a str,
    /// The body of the file, without the frontmatter block. A leading byte-order
    /// mark is dropped; CRLF and LF line ends read the same.
    pub markdown: &'a str,
    /// The vault-relative path, which relative links in the body resolve against.
    pub note_path: Option<&'a str>,
    /// The file's `writing` frontmatter, when the caller read the whole file.
    pub writing: Option<WritingFrontmatter>,
    /// The file's frontmatter block, verbatim (`split_frontmatter_block`), which a
    /// kept version carries above the body it replaced, as the file did.
    pub frontmatter: Option<&'a str>,
}

/// Replaces the body of the note with the file's text.
pub fn feed_external_edit(
    conn: &Connection,
    converter: &Converter,
    input: FeedInput<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<FeedOutcome, CrdtError> {
    author(conn, converter, input, device_id, now_ms, Write::Replace)
}

/// Gives a note with an empty body the file's text, and does nothing to one that
/// has a body.
pub fn seed_body_if_empty(
    conn: &Connection,
    converter: &Converter,
    input: FeedInput<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<FeedOutcome, CrdtError> {
    author(
        conn,
        converter,
        input,
        device_id,
        now_ms,
        Write::SeedIfEmpty,
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Write {
    Replace,
    SeedIfEmpty,
}

fn author(
    conn: &Connection,
    converter: &Converter,
    input: FeedInput<'_>,
    device_id: &str,
    now_ms: i64,
    write: Write,
) -> Result<FeedOutcome, CrdtError> {
    let FeedInput {
        note_id,
        markdown,
        note_path,
        writing,
        frontmatter,
    } = input;
    let markdown = markdown.strip_prefix('\u{feff}').unwrap_or(markdown);
    if !reads::note_exists(conn, note_id) {
        return Ok(FeedOutcome::NoNote);
    }
    if classify_markdown_content(markdown, MarkdownClassThresholds::default())
        .large_file
        .is_some()
    {
        return Ok(FeedOutcome::LargeFile);
    }

    let tx = conn.unchecked_transaction().map_err(storage_failed)?;
    if body_debt::is_owed(&tx, note_id)? {
        owed_file_body::record(&tx, note_id, now_ms)?;
        tx.commit().map_err(storage_failed)?;
        return Ok(FeedOutcome::Owed);
    }

    let authored: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let sink: UpdateSink = {
        let authored = Arc::clone(&authored);
        Arc::new(move |_, bytes: &[u8]| {
            authored
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(bytes.to_vec());
        })
    };
    let document = epoch::open_for_write(&tx, device_id, note_id, sink)?;
    let empty = body_is_empty(&document)?;
    if write == Write::SeedIfEmpty && !empty {
        return Ok(FeedOutcome::BodyPresent);
    }
    // The body as the write-back would write it. One this build cannot write out
    // whole (a block a newer build added, a node the schema would drop) is never
    // replaced, and one the file already says is not fed again.
    let replaced = if empty {
        None
    } else {
        let options = SerializeOptions {
            note_path,
            ..SerializeOptions::default()
        };
        let Some(body) = converter.serialize_note_body(&document, BODY_FRAGMENT, &options) else {
            return refuse(tx, note_id, now_ms, Refusal::BodyNotRepresentable);
        };
        if !body.unrepresentable.is_empty() || !converter.reads_losslessly(&document, BODY_FRAGMENT)
        {
            return refuse(tx, note_id, now_ms, Refusal::BodyNotRepresentable);
        }
        if same_text(&body.markdown, markdown)
            && body.writing == writing.clone().unwrap_or_default()
        {
            owed_file_body::clear(&tx, note_id)?;
            tx.commit().map_err(storage_failed)?;
            return Ok(FeedOutcome::Unchanged);
        }
        Some(body.markdown)
    };
    let outcome = converter.replace_body(
        &document,
        markdown,
        ReplaceOptions {
            note_path,
            writing,
            unless_changed_from: None,
            embeds: None,
        },
    );
    match outcome {
        ReplaceOutcome::Replaced => {}
        ReplaceOutcome::RefusedLargeFile => return Ok(FeedOutcome::LargeFile),
        ReplaceOutcome::Changed | ReplaceOutcome::Failed => {
            return refuse(tx, note_id, now_ms, Refusal::FileNotConvertible);
        }
    }

    let updates = std::mem::take(&mut *authored.lock().unwrap_or_else(PoisonError::into_inner));
    if !updates.iter().all(|update| rides_as_one_update(update)) {
        return Ok(FeedOutcome::LargeFile);
    }
    if let Some(previous) = replaced {
        let version = note_snapshots::Version {
            note_id,
            content: &as_file(frontmatter, &previous),
            body: &previous,
            title: &title(&tx, note_id)?,
            reason: note_snapshots::SIGNIFICANT,
        };
        note_snapshots::keep(&tx, version, now_ms)?;
    }
    for update in &updates {
        append_in(&tx, ITEM_TYPE, note_id, update, now_ms)?;
    }
    owed_file_body::clear(&tx, note_id)?;
    tx.commit().map_err(storage_failed)?;
    Ok(FeedOutcome::Fed)
}

/// The file holds an edit the document did not take: it owes its body, so the
/// write-back keeps the file rather than write the document over it.
fn refuse(
    tx: rusqlite::Transaction<'_>,
    note_id: &str,
    now_ms: i64,
    refusal: Refusal,
) -> Result<FeedOutcome, CrdtError> {
    owed_file_body::record(&tx, note_id, now_ms)?;
    tx.commit().map_err(storage_failed)?;
    Ok(FeedOutcome::Refused(refusal))
}

/// A kept body as the file it was: the file's frontmatter block, verbatim, above
/// it, and one trailing newline (`writeMarkdownNote`).
fn as_file(frontmatter: Option<&str>, body: &str) -> String {
    let body = body.trim_end_matches('\n');
    let newline = if body.is_empty() { "" } else { "\n" };
    format!("{}{body}{newline}", frontmatter.unwrap_or_default())
}

/// Whether the file's text is the body's: line ends and the trailing newlines a
/// body cannot hold do not count.
fn same_text(body: &str, file: &str) -> bool {
    let normalize = |text: &str| text.replace("\r\n", "\n").trim_end_matches('\n').to_owned();
    normalize(body) == normalize(file)
}

/// Whether the server takes this update as one: it caps the packed length
/// (header, compressed frame, AEAD tag), not the markdown or the raw update.
fn rides_as_one_update(update: &[u8]) -> bool {
    crdt_envelope::packed_len(update) <= MAX_UPDATE_BYTES
}

fn title(conn: &Connection, note_id: &str) -> Result<String, CrdtError> {
    conn.query_row(
        "SELECT title FROM notes WHERE id = ?1",
        rusqlite::params![note_id],
        |row| row.get(0),
    )
    .map_err(storage_failed)
}

fn storage_failed(error: rusqlite::Error) -> CrdtError {
    CrdtError::from(crate::api::errors::StorageError::Failed {
        what: error.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cap_is_on_the_packed_length_not_the_raw_one() {
        // Repetitive: 6 MiB raw packs far below the cap. Incompressible: 5 MiB raw packs above it.
        assert!(rides_as_one_update(&vec![b'a'; 6 * 1024 * 1024]));
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        let noise: Vec<u8> = (0..MAX_UPDATE_BYTES)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state.to_le_bytes()[0]
            })
            .collect();
        assert!(!rides_as_one_update(&noise));
    }
}
