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
//! server body: the merge would hold two copies (#2536). The pull records a body
//! debt before it applies a note record ([`crate::sync::body_debt`]), so
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
//! Large-file-class markdown (over 1 MB, or a run of 128 KB with no blank line)
//! is never fed: no document can take it. The caller must not treat the file as
//! read. The same holds for [`FeedOutcome::Refused`].

use std::sync::{Arc, Mutex, PoisonError};

use rusqlite::Connection;

use crate::crdt::errors::CrdtError;
use crate::crdt::registry::UpdateSink;
use crate::crdt::epoch;
use crate::domain::body_write::append_in;
use crate::domain::notes::ITEM_TYPE;
use crate::domain::{owed_file_body, reads};
use crate::markdown::convert::api::{Converter, ReplaceOptions};
use crate::markdown::convert::apply::ReplaceOutcome;
use crate::markdown::shared::markdown_class::{MarkdownClassThresholds, classify_markdown_content};
use crate::markdown::shared::writing_tools::WritingFrontmatter;
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
    /// Large-file-class markdown: no document takes it.
    LargeFile,
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

pub fn feed_external_edit(
    conn: &Connection,
    converter: &Converter,
    input: FeedInput<'_>,
    device_id: &str,
    now_ms: i64,
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
    for update in &updates {
        append_in(&tx, ITEM_TYPE, note_id, update, now_ms)?;
    }
    owed_file_body::clear(&tx, note_id)?;
    tx.commit().map_err(storage_failed)?;
    Ok(FeedOutcome::Fed)
}

fn storage_failed(error: rusqlite::Error) -> CrdtError {
    CrdtError::from(crate::api::errors::StorageError::Failed {
        what: error.to_string(),
    })
}
