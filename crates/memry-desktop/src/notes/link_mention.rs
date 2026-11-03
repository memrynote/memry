//! "Link" on an unlinked mention (#3320 on Electron, #3530 13i-5): `notes:link-mention` of
//! desktop `ipc/notes-handlers.ts`, the port of `linkUnlinkedMentionInSource`
//! (`vault/unlinked-mentions.ts`) and of the part of `landSourceRewrite` it lands with.
//!
//! The source's `ordinal`-th mention of the target becomes `[[Title]]`, or `[[Title|text]]`
//! when the text is an alias or another spelling. Mentions are counted in the body after the
//! frontmatter block, with the target's title and aliases, as [`super::mentions`] lists them,
//! so an ordinal from the panel names the mention it showed; the rewrite is
//! `mention_mask::link_unlinked_mention`, which the `markdown` cases of the `unlinked-mentions`
//! vectors pin. In the source's write order, and under the rows' lane for the whole step, so
//! neither the write-back nor the consumer lands between the read and the write:
//! 1. the file read; the new file is its frontmatter block, byte for byte, then the new body;
//! 2. the own-write record told, then the file replaced only while it still holds the bytes
//!    read (`write_note_over`): an edit that lands meanwhile is kept, and the answer is `false`,
//!    as for a mention that is gone;
//! 3. the new body fed as the app's own edit (`ExternalFeed::feed_app_edit`), which keeps no
//!    version of the body the user saw;
//! 4. the row: both hashes when the document took the text, else only the file's, the
//!    consumer's rule (`vault::consumer`), so the write-back never writes over the link;
//! 5. [`Applied::Changed`] with [`ChangeSource::Rewrite`]: the note index relinks the source and
//!    announces the link, on which the panels refetch, and the shell sends `notes:updated` with
//!    `source: external`, as `landSourceRewrite` does, so an editor showing the source reloads.
//!
//! `false` for a mention that is gone, a source that is not a markdown file or has no file, and
//! a file that changed while the link was written; a target or source that is not a note is
//! [`NotesError::NotFound`]. A body the feed fails on is an error once the file and row are
//! written, as Electron's feed failure fails the call after its file write. Not here yet,
//! stated: the lock check (`assertNoteWritable`, Step 14), and `journal:entry-updated` for a
//! journal-day source (13m).

use memry_core::domain::external_feed::{FeedInput, FeedOutcome};
use memry_core::markdown::shared::mention_mask::link_unlinked_mention;

use super::error::NotesError;
use super::service::NotesService;
use crate::session::OpenVault;
use crate::vault::consumer::rows::{Lane, RowStat};
use crate::vault::consumer::{Applied, ChangeSource, converter_for, writing_of};
use crate::vault::embeds::Resolved;
use crate::vault::file_types::{FileType, extension, file_type_of_extension};
use crate::vault::hash::content_hash;
use crate::vault::note_file::{NoteFile, NoteFileError, read_note, write_note_over_checked};

const SCOPE: &str = "link_mention";
const BOM: char = '\u{feff}';

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
        self.link_mention_checked(open, source_id, target_id, ordinal, &mut || {})
    }

    /// [`Self::link_mention`] with a hook that runs after the new file is written beside the
    /// source and before it replaces it, so a test can edit the file in that window.
    #[doc(hidden)]
    pub fn link_mention_checked(
        &self,
        open: &OpenVault,
        source_id: &str,
        target_id: &str,
        ordinal: usize,
        between: &mut dyn FnMut(),
    ) -> Result<bool, NotesError> {
        let names = open.search.mention_names(target_id)?;
        if names.is_empty() {
            return Err(NotesError::NotFound(target_id.to_owned()));
        }
        let link = Link {
            open,
            source_id,
            names: &names,
            ordinal,
        };
        self.order.run(source_id, || self.link_now(&link, between))
    }

    fn link_now(&self, link: &Link<'_>, between: &mut dyn FnMut()) -> Result<bool, NotesError> {
        let Link {
            open, source_id, ..
        } = *link;
        let root = open.path.as_path();
        let rows = self.tier.rows();
        let session = rows.session_for(&open.vault)?;
        let feed = open.vault.external_feed(self.store.clone())?;
        let mut lane = rows.lane_of(session)?;
        let path = lane
            .files()
            .by_id(source_id)?
            .ok_or_else(|| NotesError::NotFound(source_id.to_owned()))?
            .path;
        // Electron reads no binary note's text; a file type this build does not know is left
        // out with it, as the mentions list leaves it out.
        if file_type_of_extension(&extension(&path)) != Some(FileType::Markdown) {
            return Ok(false);
        }
        let Some(read) = read_note(root, &path)? else {
            return Ok(false);
        };
        let split = read.split();
        let Some(body) = link.rewrite(split.body) else {
            return Ok(false);
        };
        let raw = format!("{}{body}", split.block.unwrap_or(""));
        let file = NoteFile {
            hash: content_hash(&raw),
            raw,
        };
        let echo = self.tier.echo();
        echo.will_write(&path, &file.hash);
        match write_note_over_checked(root, &path, &file.raw, &read.hash, between) {
            Ok(()) => {}
            Err(NoteFileError::ChangedUnderWrite) => {
                echo.cancel_write(&path);
                return Ok(false);
            }
            Err(error) => {
                echo.cancel_write(&path);
                return Err(error.into());
            }
        }
        let embeds = Resolved::of_markdown(root, &open.vault.note_files(), &body, &path);
        let settings = open.vault.app_settings(self.store.clone()).ok();
        let input = FeedInput {
            note_id: source_id,
            markdown: &body,
            note_path: Some(&path),
            writing: writing_of(&file),
            frontmatter: split.block,
            embeds: Some(&embeds),
        };
        let was = split.body.strip_prefix(BOM).unwrap_or(split.body);
        let fed = feed.feed_app_edit(&converter_for(settings.as_ref()), input, was);
        let holds = match &fed {
            Ok(FeedOutcome::Fed | FeedOutcome::Unchanged) => true,
            Ok(outcome) => {
                tracing::warn!(
                    scope = SCOPE,
                    note_id = source_id,
                    ?outcome,
                    "a linked mention did not reach the note's document"
                );
                false
            }
            Err(error) => {
                tracing::error!(
                    scope = SCOPE,
                    note_id = source_id,
                    "a linked mention did not reach the note's document: {error}"
                );
                false
            }
        };
        record_row(&mut lane, source_id, &path, &file, holds);
        lane.publish(Applied::Changed {
            note_id: source_id.to_owned(),
            path,
            content_hash: holds.then_some(file.hash),
            source: ChangeSource::Rewrite,
        });
        fed?;
        Ok(true)
    }
}

/// One mention to link: the source note, the target's names (its title first), and which of
/// the source's mentions.
#[derive(Clone, Copy)]
struct Link<'a> {
    open: &'a OpenVault,
    source_id: &'a str,
    names: &'a [String],
    ordinal: usize,
}

impl Link<'_> {
    fn rewrite(&self, body: &str) -> Option<String> {
        link_unlinked_mention(body, self.names, self.ordinal, &self.names[0])
    }
}

/// The row after the write: it names the new file's text only when the document took it. A
/// row that is not written leaves the file ahead of it, which the write-back keeps and the next
/// open's walk feeds again.
fn record_row(lane: &mut Lane<'_>, note_id: &str, path: &str, file: &NoteFile, holds: bool) {
    let recorded = if holds {
        let stat = RowStat {
            file_type: FileType::Markdown,
            size: file.raw.len() as u64,
            content_hash: Some(file.hash.clone()),
            file_hash: Some(file.hash.clone()),
        };
        lane.put(note_id, path, stat)
            .map_err(|error| error.to_string())
    } else {
        lane.record_file_hash(note_id, Some(&file.hash))
            .map_err(|error| error.to_string())
    };
    if let Err(error) = recorded {
        tracing::warn!(
            scope = SCOPE,
            note_id,
            "a linked mention's row was not recorded: {error}"
        );
    }
}
