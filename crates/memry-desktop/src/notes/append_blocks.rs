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
//! (`note_excluded`), and every file the seam keeps: an outside edit not fed yet, a document
//! ahead of its file (typing the write-back has not written; `note_edit_kept`, the user moves
//! again a moment later), a body not pulled from sync, a frontmatter that does not parse, a
//! file that changed while the write ran. Electron writes over the last two cases. A file
//! written whose text the document did not take (a large file, a feed that failed) is a move
//! that landed: the watcher brings the file to the document.

use memry_core::markdown::frontmatter::{
    is_js_whitespace, js_trim, parse_markdown_note, serialize_parsed_markdown_note,
};
use memry_core::markdown::schema::blocks::note_refs::{
    NoteRefsOptions, rewrite_note_refs_for_move,
};
use serde::{Deserialize, Serialize};

use super::error::{NotesError, SCOPE};
use super::service::NotesService;
use crate::session::OpenVault;
use crate::vault::app_edit::{AppEdit, Edited, Precondition};
use crate::vault::consumer::ChangeSource;

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
            edit.run(turn, Precondition::Held, ChangeSource::AppEdit, |text| {
                appended(text, &markdown).map(Some)
            })
        })?;
        match edited {
            Edited::Wrote { held, .. } => {
                if !held {
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
            Edited::Unchanged { .. } => Err(NotesError::InvalidAppend("there is nothing to move")),
            Edited::Kept(kept) => {
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
}
