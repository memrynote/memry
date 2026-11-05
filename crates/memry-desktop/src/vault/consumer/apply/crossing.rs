//! The moves that changed what a file is (`Rename::Crossed`): the row of the record the
//! identity deleted goes, and the file is made anew as the item it now is.

use super::super::rows::Lane;
use super::super::{Applied, ChangeSource};
use super::{Applier, SCOPE, Step};
use crate::vault::file_types::{extension, file_type_of_extension};
use crate::vault::watch::reconcile::modified_ms;

impl Applier {
    /// The owed moves that changed what their file is, whose records the identity deleted
    /// (`NoteIdentity::settle_crossings`): each file is made anew. Before the open walk, which
    /// then finds them named.
    pub(in crate::vault::consumer) fn settle_crossings(&self) {
        let crossed = self.identity.settle_crossings(&self.ctx());
        let Ok(mut lane) = self.rows.lane_of(self.session) else {
            return;
        };
        for crossed in crossed {
            self.recreate(&mut lane, &crossed.note_id, &crossed.path, &crossed.path);
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
        // The watcher pairs a later move or edit of the file on what it reported, which names
        // the deleted note.
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
