//! The links to a note follow its rename or move in the app (Step 13g-2, #3530; Electron
//! `rewriteInboundWikiLinks`, `vault/rename-link-rewrite.ts:89`): every `[[Old]]`,
//! `[[Old#Heading|alias]]` and `[[Folder/Old]]` in another note's file names the note by its new
//! title or path, or the next click on it makes a second note (#1711).
//!
//! - **Which files**: the notes and days whose indexed links resolved to the note, or name its
//!   old title or path unresolved, the note's own file included (`getInboundLinkSourceIds`,
//!   [`memry_core::domain::link_reads::rewrite_sources`]).
//! - **Which links**: the core decides, as for iOS's documents
//!   ([`memry_core::domain::notes::link_rewrite::rewrite_text`]), over the whole file,
//!   frontmatter included, as Electron rewrites it.
//! - **How**: through [`AppEdit`], in each source's own write turn: the file, then its
//!   document, then its row, then a note event the renderer takes as an outside edit
//!   (`ChangeSource::AppEdit`), so an open editor shows the new link.
//!
//! The rename already happened, so nothing here fails it: a source that cannot be read, holds
//! an outside edit not fed yet, or whose document is ahead of its file, keeps its links, and
//! the log says why. Repairing nine links of ten beats unwinding a rename.
//!
//! Divergences from Electron, stated: a path link names a note's folder and title, as Tauri
//! resolves it (`wiki_target`), where Electron used the file's path (they differ only for a
//! file named other than its title); `[[Folder/Old.md]]` follows too (the core's rule). Not
//! here: the journal page's own event for a rewritten day (Step 13m), and the lock check
//! (Step 14).

use memry_core::api::errors::StorageError;
use memry_core::domain::notes::link_rewrite::{LinkNames, rewrite_text};

use super::error::{NotesError, SCOPE};
use super::service::NotesService;
use crate::session::OpenVault;
use crate::vault::app_edit::{AppEdit, Edited};
use crate::vault::consumer::ChangeSource;

impl NotesService {
    /// Re-points the links to `note_id`, which was named `from` and is named `to` now. Never
    /// fails: see the module comment.
    pub(super) fn rewrite_inbound(
        &self,
        open: &OpenVault,
        note_id: &str,
        from: &LinkNames,
        to: &LinkNames,
    ) {
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
            let rewritten = self.order.run(&source, || {
                edit.run(&source, ChangeSource::AppEdit, |file| {
                    rewrite_text(&file.raw, note_id, from, to, claimed).map_err(NotesError::from)
                })
            });
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
