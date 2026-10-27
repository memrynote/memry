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
//! append. Step 14 switches the caller to its resident editor.
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

use crate::crdt::epoch;
use crate::crdt::errors::CrdtError;
use crate::crdt::markdown_seed::body_is_empty;
use crate::crdt::registry::UpdateSink;
use crate::domain::body_write::append_in;
use crate::domain::notes::ITEM_TYPE;
use crate::domain::{owed_file_body, reads};
use crate::markdown::convert::api::{Converter, ReplaceOptions};
use crate::markdown::convert::apply::ReplaceOutcome;
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
    /// The markdown did not convert, or the document refused the replace.
    Refused,
    /// This vault holds no live note by that id.
    NoNote,
}

/// The file's text and where it lives.
pub struct FeedInput<'a> {
    pub note_id: &'a str,
    /// The body of the file, without the frontmatter block.
    pub markdown: &'a str,
    /// The vault-relative path, which relative links in the body resolve against.
    pub note_path: Option<&'a str>,
    /// The file's `writing` frontmatter, when the caller read the whole file.
    pub writing: Option<WritingFrontmatter>,
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
    } = input;
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
    if write == Write::SeedIfEmpty && !body_is_empty(&document)? {
        return Ok(FeedOutcome::BodyPresent);
    }
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
        ReplaceOutcome::Changed | ReplaceOutcome::Failed => return Ok(FeedOutcome::Refused),
    }

    let updates = std::mem::take(&mut *authored.lock().unwrap_or_else(PoisonError::into_inner));
    if !updates.iter().all(|update| rides_as_one_update(update)) {
        return Ok(FeedOutcome::LargeFile);
    }
    for update in &updates {
        append_in(&tx, ITEM_TYPE, note_id, update, now_ms)?;
    }
    owed_file_body::clear(&tx, note_id)?;
    tx.commit().map_err(storage_failed)?;
    Ok(FeedOutcome::Fed)
}

/// Whether the server takes this update as one: it caps the packed length
/// (header, compressed frame, AEAD tag), not the markdown or the raw update.
fn rides_as_one_update(update: &[u8]) -> bool {
    crdt_envelope::packed_len(update) <= MAX_UPDATE_BYTES
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
