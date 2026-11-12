//! [`first_body`]: a new note's first body authored off the writer connection.

use std::sync::PoisonError;

use super::{FeedInput, collecting_sink, rides_as_one_update};
use crate::crdt::registry::{DocumentRegistry, client_id_from_device_id};
use crate::markdown::convert::api::{Converter, ReplaceOptions};
use crate::markdown::convert::apply::{CriticMarks, ReplaceOutcome};
use crate::markdown::shared::markdown_class::{MarkdownClassThresholds, classify_markdown_content};

/// The body a new note gets from its file's text, authored without the database. Only
/// [`first_body`] makes one, so the note it was authored for and its client id are the ones
/// the transaction that stores it checks ([`crate::domain::notes::new_files::adopt_new`]).
pub struct FirstBody {
    /// The id of the note the updates were authored for.
    pub(crate) note_id: String,
    /// The Yjs client id the updates were authored under: this device's for a document it
    /// never purged ([`crate::crdt::epoch::client_id`] at epoch 0).
    pub(crate) client_id: u64,
    pub(crate) updates: Vec<Vec<u8>>,
}

/// What [`super::seed_body_if_empty`] writes into the empty document of a note this device just
/// created, authored off the writer connection: a caller converts many files at once and
/// creates their notes with these bodies in one transaction
/// ([`crate::domain::notes::new_files::adopt_new`]). `input.note_id` is the id the note will get.
/// `None` when the seed would not answer [`super::FeedOutcome::Fed`] (large-file class, not
/// convertible, or past the update cap): the note is then created and seeded alone, which
/// records why.
pub fn first_body(
    converter: &Converter,
    input: FeedInput<'_>,
    device_id: &str,
) -> Option<FirstBody> {
    let markdown = input
        .markdown
        .strip_prefix('\u{feff}')
        .unwrap_or(input.markdown);
    if classify_markdown_content(markdown, MarkdownClassThresholds::default())
        .large_file
        .is_some()
    {
        return None;
    }
    let client_id = client_id_from_device_id(device_id);
    let (sink, authored) = collecting_sink();
    let document = DocumentRegistry::with_client_id(client_id, sink)
        .get_or_open(input.note_id)
        .ok()?;
    let options = ReplaceOptions {
        note_path: input.note_path,
        writing: input.writing,
        unless_changed_from: None,
        embeds: input.embeds,
        critic_marks: CriticMarks::FromMarkdown,
    };
    // The document is this call's alone and is dropped unless the body replaced it.
    if converter.replace_unshared_body(&document, markdown, options) != ReplaceOutcome::Replaced {
        return None;
    }
    let updates = std::mem::take(&mut *authored.lock().unwrap_or_else(PoisonError::into_inner));
    updates
        .iter()
        .all(|update| rides_as_one_update(update))
        .then(|| FirstBody {
            note_id: input.note_id.to_owned(),
            client_id,
            updates,
        })
}
