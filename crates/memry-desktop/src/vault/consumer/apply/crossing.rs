//! The moves that changed what a file is (`Rename::Crossed`): the row of the record the
//! identity deleted goes, and the file is made anew as the item it now is. A move out of a
//! place the exclude patterns cover never crosses: the file is new, and the record stays.

use std::collections::BTreeSet;

use super::super::identity::Settled;
use super::super::rows::Lane;
use super::super::{Applied, ChangeSource};
use super::{Applier, SCOPE, Step};
use crate::vault::file_types::{extension, file_type_of_extension};
use crate::vault::watch::reconcile::modified_ms;

impl Applier {
    /// The owed moves that changed what their file is, whose records the identity deleted
    /// (`NoteIdentity::settle_crossings`): each file is made anew. Before the open walk, which
    /// then finds them named. Answers the owed notes whose file is still theirs
    /// ([`Settled::theirs`]).
    pub(in crate::vault::consumer) fn settle_crossings(&self) -> BTreeSet<String> {
        let Settled { crossed, theirs } = self.identity.settle_crossings(&self.ctx());
        if let Ok(mut lane) = self.rows.lane_of(self.session) {
            for crossed in crossed {
                self.recreate(&mut lane, &crossed.note_id, &crossed.path, &crossed.path);
            }
        }
        theirs
    }

    /// Once the queue went quiet after a batch of facts: the journal setting follows a journal folder whose days the
    /// batch held, and the rows' facts say so (`NoteIdentity::follow_held`).
    pub(in crate::vault::consumer) fn follow_held(&self) {
        if !self.identity.follow_held(&self.ctx()) {
            return;
        }
        if let Ok(lane) = self.rows.lane_of(self.session) {
            lane.publish(Applied::JournalFollowed);
        }
    }

    /// The note's record was deleted, since its file, at `new_path` now, is another kind
    /// (`Rename::Crossed`): its row goes from `old_path`, and the file is a new one, as
    /// Electron lists it (`handleMarkdownFileAdd`).
    pub(super) fn recreate(
        &self,
        lane: &mut Lane<'_>,
        note_id: &str,
        old_path: &str,
        new_path: &str,
    ) -> Step {
        if let Err(error) = lane.remove(note_id) {
            // The record's debt stays with the row, so the next open makes the file anew.
            tracing::error!(scope = SCOPE, note_id, "the row was not removed: {error}");
            return Step::Done;
        }
        lane.publish(Applied::Removed {
            note_id: note_id.to_owned(),
            path: old_path.to_owned(),
            source: ChangeSource::Watcher,
        });
        self.report_removed(old_path);
        self.made_anew(lane, new_path)
    }

    /// Whether the move of a note whose file was in a place the exclude patterns cover changes
    /// what the file is, or may (unknown). The rescan pairs such a move ([`Applier::renamed`]),
    /// but crossed, its record would be deleted and the delete synced, which a covered record
    /// never is: the file is a new one instead ([`Self::made_anew`]), and the record stays.
    pub(super) fn crosses_from_cover(&self, note_id: &str, old_path: &str, new_path: &str) -> bool {
        if !self.filter.ignores(old_path) {
            return false;
        }
        match self.identity.keeps_kind(&self.ctx(), note_id, new_path) {
            Ok(keeps) => !keeps,
            Err(error) => {
                tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    "an excluded note's move was taken as a new file: {error}"
                );
                true
            }
        }
    }

    /// The file at `path`, reported as the move of a note that does not follow it, made anew.
    pub(super) fn made_anew(&self, lane: &mut Lane<'_>, new_path: &str) -> Step {
        // The watcher pairs a later move or edit of the file on what it reported, which names
        // the note it moved from.
        if let Some(watch) = &self.watch {
            watch.rehome(new_path.to_owned());
        }
        let Some(file_type) = file_type_of_extension(&extension(new_path)) else {
            return Step::Done;
        };
        match std::fs::metadata(self.root.join(new_path)) {
            Ok(meta) => self.found(
                lane,
                new_path,
                file_type,
                meta.len(),
                modified_ms(&meta),
                None,
            ),
            // Gone again: nothing to make.
            Err(_) => Step::Done,
        }
    }
}
