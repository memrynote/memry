//! A file's text into its note's body: the feed the consumer seeds or replaces a document
//! with, and what that came to. Split from `apply`, whose invariants it keeps.

use std::sync::PoisonError;
use std::time::{Duration, Instant};

use memry_core::domain::external_feed::{FeedInput, FeedOutcome};
use memry_core::domain::note_files::LogMark;
use memry_core::domain::note_files::StampMark;
use memry_core::markdown::shared::writing_tools::{WritingFrontmatter, writing_of_yaml};

use super::apply::{Applier, Step};
use super::rows::{Lane, RowStat};
use super::{Applied, ChangeSource, converter_for};
use crate::vault::embeds::Resolved;
use crate::vault::file_types::FileType;
use crate::vault::hash::content_hash;
use crate::vault::note_file::NoteFile;
use crate::vault::writeback::output_over;

const SCOPE: &str = "vault_consumer";

/// How long a note's file stays empty over a row that names other bytes before the consumer
/// takes it ([`Applier::emptying`]).
pub const EMPTIED_SETTLE: Duration = Duration::from_secs(2);

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
pub(super) fn writing_of(file: &NoteFile) -> Option<WritingFrontmatter> {
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
    /// Unless the document took an edit after the mark, which the fact is retried for.
    Replace(LogMark),
}

impl Applier {
    /// Whether the note's file is an outside writer's between its truncate and its write
    /// (`fs.writeFileSync`, an editor saving in place): empty, over a row that names other bytes,
    /// for less than [`EMPTIED_SETTLE`] since the consumer first read it so. The fact is retried
    /// and the row keeps naming the file it named, so no save and no write-back renames over the
    /// file the writer holds open: its write would land in a file no path names (#4289). Taken as
    /// the file, the empty bytes would also reach the record as a frontmatter with no tags, and a
    /// body ahead of them would be written with none. The writer's write is the watcher's next
    /// report; a file that stays empty is the user's, and is taken once it settled.
    pub(super) fn emptying(&self, note_id: &str, row_hash: Option<&str>, file: &NoteFile) -> bool {
        let mut emptied = self.emptied.lock().unwrap_or_else(PoisonError::into_inner);
        let writing = file.raw.is_empty()
            && row_hash.is_some_and(|hash| hash != file.hash)
            && self.own_files.writer(note_id, &file.hash).is_none();
        if !writing {
            emptied.remove(note_id);
            return false;
        }
        let since = *emptied
            .entry(note_id.to_owned())
            .or_insert_with(Instant::now);
        if since.elapsed() < EMPTIED_SETTLE {
            tracing::info!(
                scope = SCOPE,
                note_id,
                "a file read empty waits for its writer"
            );
            return true;
        }
        emptied.remove(note_id);
        false
    }

    /// An outside edit of the note's file, which replaced the file the row named
    /// (`previous`, the row stamped `stamp`). A body ahead of that file (typing, or a merge, the
    /// write-back has not written yet) wins over it, as unsaved typing does in the editor
    /// (#4030): the record takes what the file's frontmatter says, the file is kept as a
    /// version, the row names it as the file the body goes over, with its stamp kept so the
    /// body stays ahead for the next open's reconcile too, and the write-back writes the body
    /// over it. The file is recorded as the outside edit read ([`OwnFiles::read_outside`]), so
    /// that write tells the page (`Outcome::Wrote::replaced_outside`). Otherwise the file is fed:
    /// `Ok` with the mark the feed must still find. Bytes the app wrote are no outside edit, and
    /// are fed.
    pub(super) fn outside_edit(
        &self,
        lane: &mut Lane<'_>,
        (note_id, source): (&str, ChangeSource),
        path: &str,
        (previous, stamp): (&str, i64),
        file: &NoteFile,
    ) -> Result<LogMark, Step> {
        let retry = |what: &str, error: &dyn std::fmt::Display| {
            tracing::error!(scope = SCOPE, note_id, "an outside edit {what}: {error}");
            Step::Retry(path.to_owned())
        };
        // Before the body is compared: an edit stored after it makes the feed refuse.
        let mark = self
            .vault
            .write_back()
            .body_mark(note_id)
            .map_err(|error| retry("met no mark of the body", &error))?;
        let ahead = self
            .vault
            .note_files()
            .behind_body(note_id)
            .map_err(|error| retry("met no body to compare", &error))?;
        if !ahead
            || self.own_files.writer(note_id, &file.hash).is_some()
            || !self.text_moved(note_id, path, previous, file)
        {
            return Ok(mark);
        }
        if !self.told(note_id, previous, file) {
            return Err(Step::Retry(path.to_owned()));
        }
        self.vault
            .write_back()
            .keep_outside_write(note_id, &file.raw, file.split().body)
            .map_err(|error| retry("was not kept as a version", &error))?;
        let stat = RowStat {
            file_type: FileType::Markdown,
            size: file.raw.len() as u64,
            content_hash: Some(file.hash.clone()),
            file_hash: Some(file.hash.clone()),
        };
        lane.put_as_of(note_id, path, stat, (stamp, StampMark::Kept))
            .map_err(|error| retry("kept its row", &error))?;
        if let Some(writeback) = &self.writeback {
            writeback.schedule(note_id);
        }
        tracing::info!(
            scope = SCOPE,
            note_id,
            "an outside edit met a body ahead of its file; the body wins"
        );
        self.own_files.read_outside(note_id, Some(&file.hash));
        // The record took the file's frontmatter.
        lane.publish(Applied::Changed {
            note_id: note_id.to_owned(),
            path: path.to_owned(),
            content_hash: Some(file.hash.clone()),
            source,
        });
        Err(Step::Done)
    }

    /// Whether the body's text changed since the row's stamp: a body that moved without changing
    /// it (a link the editor made a chip of, an edit undone, a fold) holds no typing, and the
    /// outside edit is fed. A change of the file's frontmatter does not count, except for a row
    /// with no mark, compared through the file; a body that cannot be compared does.
    fn text_moved(&self, note_id: &str, path: &str, previous: &str, file: &NoteFile) -> bool {
        let converter = converter_for(self.settings.as_ref());
        let moved = self
            .vault
            .write_back()
            .text_moved_since_stamp(&converter, note_id);
        match moved {
            Ok(Some(moved)) => moved,
            // No mark to read the log at (a row an older build stamped, or a fold took it): the
            // body holds no typing when, written over the outside file, it makes the file the
            // row named.
            Ok(None) => {
                let made = (&*self.vault, self.settings.as_ref(), self.root.as_path());
                !output_over(made, note_id, path, file)
                    .is_ok_and(|output| content_hash(&output) == previous)
            }
            Err(error) => {
                tracing::warn!(scope = SCOPE, note_id, "the body was not compared: {error}");
                true
            }
        }
    }

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
            Write::Replace(mark) => feed.feed_since(&converter, input, mark),
        };
        match outcome {
            // Typing stored since the body was compared: the retry finds the body ahead.
            Ok(FeedOutcome::Changed) => Body::Failed,
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
