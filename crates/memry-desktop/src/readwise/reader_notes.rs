//! The one write path from a saved Reader document into the vault (`reader-notes.ts`, D11). A
//! document gets a note once. Its link row, or a note that already names it in `readwise_url`,
//! means the note exists: whether this pass made it, the v2 book of the same document did, or
//! another device did, it stays as the user has it. A failure never throws: the Reader cursor
//! stays put and the next pass reads the document again.

use std::collections::HashSet;

use memry_core::domain::readwise::{LinkKey, LinkState, parse_readwise_url};

use super::images::resolve_images;
use super::library::Library;
use super::reader::{PlanReaderNoteOptions, ReaderNotePlan, plan_reader_note, reader_document_url};
use super::types::{FolderLayout, ReaderDocument, SavedImages, json_value, split_frontmatter};
use super::writer::SkipReason;
use crate::notes::create::NewNoteFile;
use crate::notes::read;
use crate::notes::update::NoteUpdateInput;

const SCOPE: &str = "ReadwiseReaderNotes";

/// `ReaderOutcome`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReaderOutcome {
    Created(String),
    /// The document already has a note. It is never written again (D4, D11).
    Unchanged(String),
    Skipped(SkipReason),
    Failed(String),
}

/// `ReaderNoteOptions`.
pub struct ReaderNoteOptions<'a> {
    pub root: &'a str,
    pub folder_layout: FolderLayout,
    pub book_external_ids: &'a HashSet<String>,
    /// Restore (D16): a deleted note comes back. The link's `note-deleted` state is ignored, a
    /// note that already names the document is adopted, and otherwise the note is created.
    pub restore: bool,
}

/// `bodyOf`: the section, then the article text when there is one.
fn body_of(plan: &ReaderNotePlan) -> String {
    match &plan.full_text {
        Some(text) => format!("{}\n\n{text}", plan.note.section),
        None => plan.note.section.clone(),
    }
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// `writeReaderNote`. One write at a time, with the book writer.
pub fn write_reader_note(
    library: &Library,
    document: &ReaderDocument,
    options: &ReaderNoteOptions<'_>,
) -> ReaderOutcome {
    let _one = (library.writes.lock()).unwrap_or_else(std::sync::PoisonError::into_inner);
    match write(library, document, options) {
        Ok(outcome) => outcome,
        Err(reason) => {
            tracing::warn!(
                scope = SCOPE,
                document_id = document.id.as_str(),
                "a Reader document could not be written: {reason}"
            );
            ReaderOutcome::Failed(reason)
        }
    }
}

fn write(
    library: &Library,
    document: &ReaderDocument,
    options: &ReaderNoteOptions<'_>,
) -> Result<ReaderOutcome, String> {
    let store = library.store();
    let link = store.link_by_reader_document(&document.id).map_err(text)?;
    if let Some(link) = link.filter(|_| !options.restore) {
        match link.state {
            LinkState::Linked => {}
            LinkState::NoteDeleted => return Ok(ReaderOutcome::Skipped(SkipReason::NoteDeleted)),
            LinkState::SourceDeleted => {
                return Ok(ReaderOutcome::Skipped(SkipReason::SourceDeleted));
            }
            LinkState::Other(_) => return Ok(ReaderOutcome::Skipped(SkipReason::UnknownLink)),
        }
        if read::get(&library.open, &link.note_id, None)
            .map_err(text)?
            .is_some()
        {
            return Ok(ReaderOutcome::Unchanged(link.note_id));
        }
        // A missing row also means "not indexed yet". `note-deleted` is sticky (D9).
        if (library.indexing)() {
            return Err("The vault is still indexing".to_owned());
        }
        let key = LinkKey::ReaderDocument(document.id.clone());
        store
            .mark_link_state(key, LinkState::NoteDeleted)
            .map_err(text)?;
        return Ok(ReaderOutcome::Skipped(SkipReason::NoteDeleted));
    }

    let named = parse_readwise_url(&reader_document_url(document));
    if let Some(existing) = named
        .map(|item| library.note_id_naming(&item))
        .transpose()?
        .flatten()
    {
        store
            .upsert_link(None, Some(&document.id), &existing, LinkState::Linked)
            .map_err(text)?;
        return Ok(ReaderOutcome::Unchanged(existing));
    }

    // Departure: the article text (`readerFullText`) waits for Step 32's HTML converter.
    let plan = |images: &SavedImages| {
        let options = PlanReaderNoteOptions {
            root: options.root,
            folder_layout: options.folder_layout,
            images,
            full_text: None,
            book_external_ids: options.book_external_ids,
        };
        plan_reader_note(document, &options).map_err(text)
    };
    let Some(first) = plan(&SavedImages::new())? else {
        return Ok(ReaderOutcome::Skipped(SkipReason::HasBook));
    };
    let (tags, properties) = split_frontmatter(&first.note.frontmatter);
    let new = NewNoteFile {
        title: first.note.title.clone(),
        content: body_of(&first),
        folder: Some(first.note.folder.clone()),
        tags,
        properties,
        ..NewNoteFile::default()
    };
    let created = library.notes.create(&library.open, new).map_err(text)?;
    store
        .upsert_link(None, Some(&document.id), &created.id, LinkState::Linked)
        .map_err(text)?;

    // The note as written, read back as `latest` is below: `create` answers the text without
    // the newline the file ends with.
    let before = read::get(&library.open, &created.id, None).map_err(text)?;
    // Images need the note to exist (D14): download them, then plan again with the refs.
    let images = resolve_images(library, &created.id, &created.path, &first.note.image_urls);
    if images.is_empty() {
        return Ok(ReaderOutcome::Created(created.id));
    }
    let with_images = plan(&images)?;
    // Edited meanwhile, open in an editor, or just synced in (D6): leave it, the images stay
    // attachments.
    let latest = read::get(&library.open, &created.id, None).map_err(text)?;
    let unchanged = matches!((before, latest), (Some(b), Some(l)) if b.content == l.content);
    let (Some(with_images), true, false) =
        (with_images, unchanged, library.busy(&created.id, false))
    else {
        tracing::warn!(
            scope = SCOPE,
            document_id = document.id.as_str(),
            "a Reader note changed while its images downloaded; they stay attachments only"
        );
        return Ok(ReaderOutcome::Created(created.id));
    };
    let cover = (with_images.note.frontmatter.iter())
        .find(|(key, _)| *key == "cover")
        .map(|(_, value)| serde_json::Map::from_iter([("cover".to_owned(), json_value(value))]));
    let input = NoteUpdateInput {
        id: created.id.clone(),
        content: Some(body_of(&with_images)),
        frontmatter: cover,
        ..NoteUpdateInput::default()
    };
    if let Err(error) = (library.notes).update_ignoring_inline_tags(&library.open, input) {
        // The note exists and is linked, so the pass must not fail: the text is written once.
        tracing::warn!(
            scope = SCOPE,
            document_id = document.id.as_str(),
            "a Reader note could not be written with its images: {error}"
        );
    }
    Ok(ReaderOutcome::Created(created.id))
}
