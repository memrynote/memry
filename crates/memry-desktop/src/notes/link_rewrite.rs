//! The links to a note follow its rename or move in the app (Step 13g-2, #3530; Electron
//! `rewriteInboundWikiLinks`, `vault/rename-link-rewrite.ts:89`): every `[[Old]]`,
//! `[[Old#Heading|alias]]` and `[[Folder/Old]]` in another note's file names the note by its new
//! title or path, or the next click on it makes a second note (#1711).
//!
//! - **Which files**: the notes and days whose indexed links resolved to the note, or name its
//!   old title or path unresolved, the note's own file included (`getInboundLinkSourceIds`,
//!   [`memry_core::domain::link_reads::rewrite_sources`]).
//! - **Which links**: the core decides, as for iOS's documents
//!   ([`memry_core::domain::notes::link_rewrite::rewrite_file`]), over the whole file,
//!   frontmatter included, as Electron rewrites it; a frontmatter value is written as YAML
//!   writes it where Electron's raw rewrite would break the block. A link the new name would
//!   turn into another link (a `|`, `]` or `#` in it) is left, and the log says so.
//! - **How**: through [`AppEdit`] with [`Precondition::Held`], in each source's own write turn:
//!   its document, then its file, then its row, then a note event the renderer takes as an
//!   outside edit (`ChangeSource::AppEdit`), so an open editor shows the new link.
//!
//! The rename already happened, so nothing here fails it: a source that cannot be read, holds
//! an outside edit not fed yet, or whose document is ahead of its file, keeps its links, and
//! the log says why. So does a source the large-file class keeps out of its document (the
//! index holds no links of it) or whose server body is not pulled. Repairing nine links of ten
//! beats unwinding a rename. A crash between two sources leaves the rest stale, with no record
//! to finish them (as in Electron; a replayed record is a follow-up).
//!
//! **The moved note's own refs** (`rewriteNoteRefsForMove`, `vault/notes-rename.ts:226`): a
//! markdown note moved to another folder has every relative `![](ref)` and file block `url`
//! re-pointed from its new folder at the file it named
//! ([`memry_core::markdown::schema::blocks::note_refs`]), in its own next write turn, through
//! the same [`AppEdit`] with [`Precondition::Held`], before the links to it are repaired. Its
//! mobile vault-root refs (`attachments/<id>/...`) stay. A note whose document is ahead of its
//! file keeps its refs, and the log says so; until Step 14 only a sync merge makes one.
//!
//! Divergences from Electron, stated: a path link names a note's folder and title, as Tauri
//! resolves it (`wiki_target`), where Electron used the file's path (they differ only for a
//! file named other than its title); `[[Folder/Old.md]]` follows too (the core's rule). Not
//! here: the journal page's own event for a rewritten day (Step 13m), and the lock check
//! (Step 14).

use memry_core::api::errors::StorageError;
use memry_core::domain::notes::link_rewrite::{FileRewrite, rewrite_file};
use memry_core::markdown::schema::blocks::note_refs::{
    NoteRefsOptions, rewrite_note_refs_for_move,
};

use super::error::{NotesError, SCOPE};
use super::moves::Named;
use super::service::NotesService;
use crate::session::OpenVault;
use crate::vault::app_edit::{AppEdit, Edited, Precondition};
use crate::vault::consumer::ChangeSource;

impl NotesService {
    /// Re-points the relative refs of `note_id`, a markdown note moved from `from` to `to`.
    /// Never fails: see the module comment.
    pub(super) fn rewrite_own_refs(
        &self,
        open: &OpenVault,
        note_id: &str,
        from: &Named,
        to: &Named,
    ) {
        if !from.link.markdown || from.link.folder == to.link.folder {
            return;
        }
        let options = NoteRefsOptions {
            source_note_id: Some(note_id),
            preserve_root_relative_attachments: true,
        };
        let rewritten = AppEdit::new(&self.tier, &self.store, open)
            .map_err(NotesError::from)
            .and_then(|edit| {
                self.order.run(note_id, |turn| {
                    edit.run(turn, Precondition::Held, ChangeSource::AppEdit, |text| {
                        Ok::<_, NotesError>(rewrite_note_refs_for_move(
                            text, &from.path, &to.path, options,
                        ))
                    })
                })
            });
        match rewritten {
            Ok(Edited::Wrote { held: true, .. } | Edited::Unchanged) => {}
            Ok(outcome) => tracing::warn!(
                scope = SCOPE,
                note_id,
                outcome = ?outcome,
                "a moved note's relative embeds were not re-pointed"
            ),
            Err(error) => tracing::warn!(
                scope = SCOPE,
                note_id,
                "a moved note's relative embeds were not re-pointed: {error}"
            ),
        }
    }

    /// Re-points the links to `note_id`, which was named `from` and is named `to` now. Never
    /// fails: see the module comment.
    pub(super) fn rewrite_inbound(
        &self,
        open: &OpenVault,
        note_id: &str,
        from: &Named,
        to: &Named,
    ) {
        let (from, to) = (&from.link, &to.link);
        let sources = match open.search.link_rewrite_sources(note_id, from) {
            Ok(sources) => sources,
            Err(error) => {
                return tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    "the links to a renamed note were not repaired: {error}"
                );
            }
        };
        if sources.is_empty() {
            return;
        }
        let edit = match AppEdit::new(&self.tier, &self.store, open) {
            Ok(edit) => edit,
            Err(error) => {
                return tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    "the links to a renamed note were not repaired: {error}"
                );
            }
        };
        // Electron's `otherNoteWithTitleExists`: `[[Sprint #4]]` named `Sprint` all along when
        // another note holds that title.
        let claimed = |title: &str| -> Result<bool, StorageError> {
            let found = open.search.resolve_link_titles(vec![title.to_owned()])?;
            Ok(found
                .into_iter()
                .flatten()
                .any(|target| target.id != note_id))
        };
        for source in sources {
            let mut found = FileRewrite::default();
            let rewritten = self.order.run(&source, |turn| {
                edit.run(turn, Precondition::Held, ChangeSource::AppEdit, |text| {
                    found = rewrite_file(text, note_id, from, to, claimed)?;
                    Ok::<_, NotesError>(found.text.take())
                })
            });
            if found.skipped > 0 || found.frontmatter_kept {
                tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    source,
                    skipped = found.skipped,
                    frontmatter_kept = found.frontmatter_kept,
                    "links to a renamed note were left: the new name would spell another \
                     link, or the frontmatter cannot be edited key by key"
                );
            }
            match rewritten {
                Ok(Edited::Wrote { held: true, .. } | Edited::Unchanged) => {}
                Ok(outcome) => tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    source,
                    outcome = ?outcome,
                    "a file's links to a renamed note were not all repaired"
                ),
                Err(error) => tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    source,
                    "a file's links to a renamed note were not repaired: {error}"
                ),
            }
        }
    }
}
