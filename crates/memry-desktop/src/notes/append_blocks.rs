//! Blocks moved into another note (`notes:append-blocks`, `appendBlocksToNote` in desktop
//! `vault/append-blocks.ts`, #4181): the target half of the block side menu's "Move to". The
//! renderer removes the blocks from the source editor only once this answers, so every way it
//! fails is an error and leaves the target as it was: a failed move loses nothing.
//!
//! The target's body, its trailing whitespace dropped, takes a blank line and the moved
//! markdown, trimmed; an empty body takes the markdown alone. The frontmatter block, the file's
//! line ends and its final newline keep their bytes (`serializeParsedNote` with the
//! frontmatter not edited). Attachment and image refs in the markdown are resolved from the
//! source note's folder and written from the target's (`rewriteNoteRefsForMove`, mobile's
//! vault-root refs to the source's attachments too).
//!
//! The text goes through the app-edit seam ([`AppEdit`] with [`Precondition::Held`], in the
//! target's write turn, as [`ChangeSource::AppEdit`]): the note's document takes the new body
//! first, so an editor showing the target, in any window, gets the blocks as an edit it merges,
//! and the next write-back cannot write the old body over them (Electron awaits
//! `feedExternalEditToCrdt` for the same reason). The renderer hears `notes:updated` as an
//! outside edit from the row fact. Nothing is replaced, so no version is kept.
//!
//! Refused, the target's file and document as they were: a target or source that is not a
//! note (`note_not_found`), nothing to append or the source itself as the target
//! (`invalid_append`), a locked target or one in a locked folder (`note_locked`, Electron's
//! `assertNoteWritable` of the other writers; its append checks no lock), an excluded one
//! (`note_excluded`), and every file the seam keeps before the document takes the blocks: an
//! outside edit not fed yet or a document ahead of its file (typing the write-back has not
//! written; `note_edit_kept`, the user moves again a moment later), a body not pulled from sync,
//! a frontmatter that does not parse. A target whose file the document never took (a large
//! file, a body this build cannot read: the note owes its file body) is refused for good
//! (`invalid_append`): only a feed brings that file to the document, so a retry cannot land.
//! Electron appends to those files.
//!
//! Once the document took the blocks, the move landed whatever the file write does: a write
//! that fails (a disk error, the file changed under it) leaves the document ahead of its file,
//! and the write-back writes the blocks later. Refusing then would leave the source holding
//! the blocks the target's next write-back persists, and a second move would add them twice.
//! A file written whose text the document did not take (a feed that failed, a new text past
//! the large-file class) landed too: the watcher brings the file to the document.

use memry_core::domain::external_feed::same_text;
use memry_core::domain::write_back::BodyRead;
use memry_core::markdown::frontmatter::{
    is_js_whitespace, js_trim, parse_markdown_note, serialize_parsed_markdown_note,
    split_frontmatter_block,
};
use memry_core::markdown::schema::blocks::note_refs::{
    NoteRefsOptions, rewrite_note_refs_for_move,
};
use serde::{Deserialize, Serialize};

use super::error::{NotesError, SCOPE};
use super::service::NotesService;
use crate::session::OpenVault;
use crate::vault::app_edit::{AppEdit, Edited, Kept, Precondition};
use crate::vault::consumer::{ChangeSource, converter_for};
use crate::vault::embeds::Resolved;

/// `NoteAppendBlocksSchema`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppendBlocksInput {
    pub source_note_id: String,
    pub target_note_id: String,
    pub markdown: String,
}

/// What `notes:append-blocks` answers besides `success`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppendedBlocks {
    /// The target's vault-relative path.
    pub target_path: String,
}

/// The note file `text` (without a byte order mark) with `markdown` appended to its body.
pub fn appended(text: &str, markdown: &str) -> Result<String, NotesError> {
    let parsed = parse_markdown_note(text)?;
    let head = parsed.content.trim_end_matches(is_js_whitespace);
    let tail = js_trim(markdown);
    let content = match head.is_empty() {
        true => tail.to_owned(),
        false => format!("{head}\n\n{tail}"),
    };
    Ok(serialize_parsed_markdown_note(&parsed, &content, false)?)
}

/// The refusal of a target whose file its note never took.
fn never_taken(note_id: &str) -> NotesError {
    tracing::info!(
        scope = SCOPE,
        note_id,
        "blocks were not moved: the target's file is one its note never took"
    );
    NotesError::InvalidAppend(
        "the target note's file is too large or holds text the app cannot take in, so the \
         blocks stay where they are",
    )
}

fn owes_file_body(open: &OpenVault, note_id: &str) -> bool {
    open.vault
        .note_files()
        .owes_file_body(note_id)
        .unwrap_or_else(|error| {
            tracing::error!(
                scope = SCOPE,
                note_id,
                "whether the target owes its file body could not be read: {error}"
            );
            false
        })
}

impl NotesService {
    pub fn append_blocks(
        &self,
        open: &OpenVault,
        input: AppendBlocksInput,
    ) -> Result<AppendedBlocks, NotesError> {
        let AppendBlocksInput {
            source_note_id: source_id,
            target_note_id: target_id,
            markdown,
        } = input;
        if js_trim(&markdown).is_empty() {
            return Err(NotesError::InvalidAppend("there is nothing to move"));
        }
        if source_id == target_id {
            return Err(NotesError::InvalidAppend(
                "blocks cannot be moved into the note they are in",
            ));
        }
        let files = open.vault.note_files();
        let listed = |id: &str| {
            files
                .listed_by_id(id)?
                .ok_or_else(|| NotesError::NotFound(id.to_owned()))
        };
        let target = listed(&target_id)?;
        let source = listed(&source_id)?;
        let options = NoteRefsOptions {
            source_note_id: Some(&source_id),
            preserve_root_relative_attachments: false,
        };
        let markdown = rewrite_note_refs_for_move(&markdown, &source.path, &target.path, options)
            .unwrap_or(markdown);
        let edit = AppEdit::new(&self.tier, &self.store, open)?;
        let edited = self.order.run(&target_id, |turn| {
            // The new text, once the seam asked for it: past every check the seam makes before
            // the document takes it.
            let mut asked = None;
            let edited = edit.run(turn, Precondition::Held, ChangeSource::AppEdit, |text| {
                let next = appended(text, &markdown)?;
                asked = Some(next.clone());
                Ok::<_, NotesError>(Some(next))
            });
            let unwritten = matches!(edited, Ok(Edited::Kept(Kept::FileChanged)) | Err(_));
            match asked {
                Some(next) if unwritten && self.document_holds(open, &target_id, &target.path, &next) => {
                    tracing::warn!(
                        scope = SCOPE,
                        note_id = target_id,
                        ?edited,
                        "moved blocks are in the note but not in its file; the write-back writes them"
                    );
                    Ok(None)
                }
                _ => edited.map(Some),
            }
        })?;
        match edited {
            // `None`: the document took the blocks and the file write did not land.
            wrote @ (None | Some(Edited::Wrote { .. })) => {
                if let Some(Edited::Wrote { held: false, .. }) = wrote {
                    tracing::warn!(
                        scope = SCOPE,
                        note_id = target_id,
                        "moved blocks are in the file; the watcher brings them to the note"
                    );
                }
                tracing::info!(
                    scope = SCOPE,
                    note_id = target_id,
                    source_id,
                    chars = markdown.len(),
                    "appended blocks to a note"
                );
                Ok(AppendedBlocks {
                    target_path: target.path,
                })
            }
            // Text was appended, so the file always changes; a move that wrote nothing must not
            // let the source drop its blocks.
            Some(Edited::Unchanged { .. }) => {
                Err(NotesError::InvalidAppend("there is nothing to move"))
            }
            // Only a feed takes an owed file in, whose row then still names the bytes before it
            // (`FileChanged`): the move would be refused on every retry.
            Some(Edited::Kept(Kept::FileAhead)) => Err(never_taken(&target_id)),
            Some(Edited::Kept(Kept::FileChanged)) if owes_file_body(open, &target_id) => {
                Err(never_taken(&target_id))
            }
            Some(Edited::Kept(kept)) => {
                tracing::info!(
                    scope = SCOPE,
                    note_id = target_id,
                    ?kept,
                    "blocks were not moved: the target's file is kept as it is"
                );
                Err(NotesError::kept(&target_id, kept))
            }
        }
    }

    /// Whether the note's document holds the body of `text`: the feed took the move.
    fn document_holds(&self, open: &OpenVault, note_id: &str, path: &str, text: &str) -> bool {
        let body = split_frontmatter_block(text).body;
        let settings = open.vault.app_settings(self.store.clone()).ok();
        let embeds = Resolved::of_markdown(&open.path, &open.vault.note_files(), body, path);
        let read = open.vault.write_back().body(
            &converter_for(settings.as_ref()),
            note_id,
            path,
            body,
            &embeds,
        );
        match read {
            Ok(BodyRead::Body(held)) => same_text(&held.markdown, body),
            Ok(_) => false,
            Err(error) => {
                tracing::error!(
                    scope = SCOPE,
                    note_id,
                    "whether the moved blocks reached the note could not be read: {error}"
                );
                false
            }
        }
    }
}
