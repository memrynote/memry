//! "Link" on an unlinked mention (#3320 on Electron, #3530 13i-5): `notes:link-mention` of
//! desktop `ipc/notes-handlers.ts`, the port of `linkUnlinkedMentionInSource`
//! (`vault/unlinked-mentions.ts`) and of the part of `landSourceRewrite` it lands with.
//!
//! The source's `ordinal`-th mention of the target becomes `[[Title]]`, or `[[Title|text]]`
//! when the text is an alias or another spelling. Mentions are counted in the body after the
//! frontmatter block, with the target's title and aliases, as [`super::mentions`] lists them,
//! so an ordinal from the panel names the mention it showed; the rewrite is
//! `mention_mask::link_unlinked_mention`, which the `markdown` cases of the `unlinked-mentions`
//! vectors pin. The new file is the frontmatter block, byte for byte, then the new body.
//!
//! The edit runs through the app-edit seam ([`AppEdit`] with [`Precondition::Held`], in the
//! source's write turn, as [`ChangeSource::LinkRewrite`]): only a file the note's document holds is
//! rewritten, the document takes the new body without keeping the old one as a version, and
//! the shell sends `notes:updated` with `source: external`, as `landSourceRewrite` does, so an
//! editor showing the source reloads; the note index relinks the source, on which the panels
//! refetch.
//!
//! `false` for a mention that is gone, and for a source the seam keeps as it is: not a markdown
//! file, no file, an outside edit not fed yet, a document ahead of its file (an edit the
//! write-back has not written), a body not pulled, a frontmatter that does not parse, or a file
//! that changed while the link was written. `true` once the file holds the link, also when the
//! document did not take it: the watcher then brings the file in as an outside edit. An ordinal
//! is only a count: when the source changed after the panel listed it but still holds that many
//! mentions, the ordinal names whichever mention now sits at that place, and that one is
//! linked. Electron does the same; naming the mention itself (its text and offset) is a change
//! of the `notes:link-mention` contract. A target or source that is not a note is
//! [`NotesError::NotFound`]. Not here yet, stated: the lock check (`assertNoteWritable`,
//! Step 14), and `journal:entry-updated` for a journal-day source (13m).

use memry_core::markdown::frontmatter::split_frontmatter_block;
use memry_core::markdown::shared::mention_mask::link_unlinked_mention;

use super::error::NotesError;
use super::service::NotesService;
use crate::session::OpenVault;
use crate::vault::app_edit::{AppEdit, Edited, Kept, Precondition};
use crate::vault::consumer::ChangeSource;

const SCOPE: &str = "link_mention";

impl NotesService {
    /// `linkUnlinkedMentionInSource`: `true` once the source's `ordinal`-th mention of the
    /// target is a wiki link to it.
    pub fn link_mention(
        &self,
        open: &OpenVault,
        source_id: &str,
        target_id: &str,
        ordinal: usize,
    ) -> Result<bool, NotesError> {
        let names = open.search.mention_names(target_id)?;
        if names.is_empty() {
            return Err(NotesError::NotFound(target_id.to_owned()));
        }
        let edit = AppEdit::new(&self.tier, &self.store, open)?;
        let edited = self.order.run(source_id, |turn| {
            edit.run(
                turn,
                Precondition::Held,
                ChangeSource::LinkRewrite,
                |text| {
                    let split = split_frontmatter_block(text);
                    let body = link_unlinked_mention(split.body, &names, ordinal, &names[0]);
                    Ok::<_, NotesError>(
                        body.map(|body| format!("{}{body}", split.block.unwrap_or(""))),
                    )
                },
            )
        })?;
        match edited {
            Edited::Wrote { held, .. } => {
                if !held {
                    tracing::warn!(
                        scope = SCOPE,
                        note_id = source_id,
                        held,
                        "a linked mention is in the file; the watcher brings it to the note"
                    );
                }
                Ok(true)
            }
            Edited::Unchanged => Ok(false),
            Edited::Kept(Kept::NoRow) => Err(NotesError::NotFound(source_id.to_owned())),
            Edited::Kept(kept) => {
                tracing::info!(
                    scope = SCOPE,
                    note_id = source_id,
                    ?kept,
                    "a mention was not linked: the note's file is kept as it is"
                );
                Ok(false)
            }
        }
    }
}
