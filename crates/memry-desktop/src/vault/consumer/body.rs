//! A file's text into its note's body: the feed the consumer seeds or replaces a document
//! with, and what that came to. Split from `apply`, whose invariants it keeps.

use memry_core::domain::external_feed::{FeedInput, FeedOutcome};
use memry_core::markdown::shared::writing_tools::{WritingFrontmatter, writing_of_yaml};

use super::apply::Applier;
use super::converter_for;
use crate::vault::embeds::Resolved;
use crate::vault::note_file::NoteFile;

const SCOPE: &str = "vault_consumer";

/// Whether the note's document now holds the file's text: only then does the row record the
/// file's hash. `BodyPresent` is not: a seed answers it before it compares any text, so the
/// body it left alone can differ from the file. A file whose frontmatter does not parse is
/// (#3750): its body is the document's now, and the next read of the same bytes must not
/// replace the edits made in the app since. Its block is never written over: the write-back
/// cannot read the file back, fails, and tells the user.
fn holds_file(outcome: FeedOutcome) -> bool {
    matches!(outcome, FeedOutcome::Fed | FeedOutcome::Unchanged)
}

/// The writing tools data the whole file says (none without the key, or with the author's
/// own), or `None` when its frontmatter does not parse and may hold some.
fn writing_of(file: &NoteFile) -> Option<WritingFrontmatter> {
    if file.split().block.is_none() {
        return Some(WritingFrontmatter::default());
    }
    file.parse()
        .ok()
        .map(|parsed| writing_of_yaml(&parsed.frontmatter))
}

/// What a body write came to.
pub(super) enum Body {
    /// The feed answered; `holds_file` when the document now holds the file's text.
    Wrote { holds_file: bool },
    /// This device has no signing key: nothing was written (the tier said so once).
    NoKey,
    /// The write failed; the fact is retried.
    Failed,
}

#[derive(Clone, Copy)]
pub(super) enum Write {
    Seed,
    Replace,
}

impl Applier {
    /// Seeds or replaces the note's body with the file's text.
    pub(super) fn write_body(
        &self,
        note_id: &str,
        path: &str,
        file: &NoteFile,
        write: Write,
    ) -> Body {
        let Some(feed) = &self.feed else {
            return Body::NoKey;
        };
        let split = file.split();
        // Outside the feed's write: the lookup reads the database the feed holds.
        let embeds = Resolved::of_markdown(&self.root, &self.vault.note_files(), split.body, path);
        let input = FeedInput {
            note_id,
            markdown: split.body,
            note_path: Some(path),
            // `None` for a frontmatter that does not parse says nothing about the writing
            // state, so the document keeps what it holds.
            writing: writing_of(file),
            frontmatter: split.block,
            embeds: Some(&embeds),
        };
        let converter = converter_for(self.settings.as_ref());
        let outcome = match write {
            Write::Seed => feed.seed_body_if_empty(&converter, input),
            Write::Replace => feed.feed(&converter, input),
        };
        match outcome {
            Ok(outcome) => {
                if !matches!(outcome, FeedOutcome::Fed | FeedOutcome::Unchanged) {
                    tracing::warn!(
                        scope = SCOPE,
                        note_id,
                        outcome = ?outcome,
                        "a file's text did not reach its note"
                    );
                }
                Body::Wrote {
                    holds_file: holds_file(outcome),
                }
            }
            Err(error) => {
                tracing::error!(
                    scope = SCOPE,
                    note_id,
                    "a file's text did not reach its note: {error}"
                );
                Body::Failed
            }
        }
    }
}
