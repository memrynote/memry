//! The document side of an app edit: whether the document holds the file read, who sets the
//! note's comment marks, and the feed of the new text.

use std::sync::atomic::Ordering;

use memry_core::crdt::errors::CrdtError;
use memry_core::domain::external_feed::{AppRead, FeedInput, FeedOutcome, same_text};
use memry_core::domain::note_files::LogMark;
use memry_core::domain::write_back::BodyRead;
use memry_core::markdown::convert::apply::CriticMarks;
use memry_core::markdown::frontmatter::{YamlValue, split_frontmatter_block};
use memry_core::markdown::shared::writing_tools::writing_of_yaml;

use super::{AppEdit, Kept, Precondition, SCOPE};
use crate::vault::embeds::Resolved;

impl AppEdit {
    /// Who sets the note's comment marks (#4425). An editor window that holds the note writes
    /// them into the document as the user resolves, deletes or undoes one, so its save, which
    /// it serialized before a later such edit may land, leaves them; two writers of the one
    /// array would bring a resolved comment back, or hold a mark twice. Any other edit, and the
    /// save of a note no window holds, sets them from its text.
    pub(super) fn critic_marks(
        &self,
        note_id: &str,
        precondition: Precondition<'_>,
    ) -> CriticMarks {
        let editor_save = matches!(
            precondition,
            Precondition::Save(_, Some(_)) | Precondition::SaveOver(_, Some(_))
        );
        let held = || {
            self.vault
                .built_editor()
                .is_some_and(|editor| editor.is_open(note_id))
        };
        match editor_save && held() {
            true => CriticMarks::Kept,
            false => CriticMarks::FromMarkdown,
        }
    }

    /// How far the document had come when its body was found to be the file's text `read`
    /// (`body_mark`), or why it is not. The mark is taken first: an edit stored after it either
    /// shows in the comparison or makes the feed refuse.
    pub(super) fn document_held(
        &self,
        note_id: &str,
        path: &str,
        read: &str,
        frontmatter: &YamlValue,
    ) -> Result<Result<LogMark, Kept>, CrdtError> {
        let mark = self.vault.write_back().body_mark(note_id)?;
        let body = split_frontmatter_block(read).body;
        // Outside the read: the lookup reads the database the read holds.
        let embeds = Resolved::of_markdown(&self.root, &self.vault.note_files(), body, path);
        let read = self
            .vault
            .write_back()
            .body(&self.converter, note_id, path, body, &embeds)?;
        Ok(match read {
            BodyRead::Body(held)
                if same_text(&held.markdown, body)
                    && held.writing == writing_of_yaml(frontmatter) =>
            {
                Ok(mark)
            }
            BodyRead::Body(_) => Err(Kept::BodyAhead),
            BodyRead::FileAhead => Err(Kept::FileAhead),
            BodyRead::BodyNotPulled => Err(Kept::BodyNotPulled),
            BodyRead::NotRepresentable(_) | BodyRead::Failed(_) => Err(Kept::NotRepresentable),
            BodyRead::NoNote => Err(Kept::NoBody),
        })
    }

    /// Feeds the new text's body over `read`: whether the document now holds it, or why the
    /// file is kept (no such note, a lock taken since the read, or typing stored since the
    /// document was compared).
    pub(super) fn feed_text(
        &self,
        note_id: &str,
        path: &str,
        text: &str,
        frontmatter: Option<&YamlValue>,
        read: AppRead<'_>,
    ) -> Result<bool, Kept> {
        let split = split_frontmatter_block(text);
        let embeds = Resolved::of_markdown(&self.root, &self.vault.note_files(), split.body, path);
        let input = FeedInput {
            note_id,
            markdown: split.body,
            note_path: Some(path),
            writing: frontmatter.map(writing_of_yaml),
            frontmatter: split.block,
            embeds: Some(&embeds),
        };
        let fed = match self.fail_next_feed.swap(false, Ordering::Relaxed) {
            true => Err(CrdtError::Undecodable {
                doc_id: note_id.to_owned(),
                what: "test fault".to_owned(),
            }),
            false => self.feed.feed_app_edit(&self.converter, input, read),
        };
        match fed {
            Ok(FeedOutcome::Fed | FeedOutcome::Unchanged) => Ok(true),
            Ok(FeedOutcome::NoNote) => Err(Kept::NoBody),
            Ok(FeedOutcome::Changed) => Err(Kept::BodyAhead),
            Err(CrdtError::Locked { .. }) => Err(Kept::Locked),
            Ok(outcome) => {
                tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    outcome = ?outcome,
                    "an edited file's text did not reach its note; the watcher brings it in"
                );
                Ok(false)
            }
            Err(error) => {
                tracing::error!(
                    scope = SCOPE,
                    note_id,
                    "an edited file's text did not reach its note; the watcher feeds it again: \
                     {error}"
                );
                Ok(false)
            }
        }
    }
}
