//! A watcher's change of a note's file, and the typing of the windows that have the note open
//! (`editor::typing`).

use super::super::rows::{Lane, RowStat};
use super::{Applier, SCOPE, Step};
use crate::editor::BARRIER_WAIT;
use crate::vault::file_types::{FileType, extension, file_type_of_extension};
use crate::vault::note_file::{large_file_class, record_large_file};

impl Applier {
    /// A change that feeds the note's document waits for the typing of its windows first
    /// (`hold_typing`): before the lane, so a window that does not answer holds up no write of
    /// the rows, and dropped after the change applied, so a window hears the release after the
    /// edit. A window refuses what is typed while it holds, so a file that is already the text
    /// its row names asks no window: the app's own write, which the watcher reads as a change
    /// once its echo's record is gone, or a change applied already. Asked for
    /// those, a window refused the typing of every save of a note with an inline tag (#3967).
    pub(super) fn watched_change(
        &self,
        mut lane: Lane<'_>,
        note_id: &str,
        path: &str,
        size: u64,
        modified_ms: i64,
    ) -> Step {
        if self.read_back(&mut lane, note_id, path, size) {
            return Step::Done;
        }
        drop(lane);
        let _typing = self
            .editor
            .upgrade()
            .and_then(|editor| editor.hold_typing(note_id, BARRIER_WAIT));
        let Ok(mut lane) = self.rows.lane_of(self.session) else {
            return Step::Done;
        };
        self.changed(&mut lane, note_id, path, size, modified_ms, None)
    }

    /// Whether the markdown file at `path` is the text the note's row names, as `changed` reads
    /// it back; the row then records the read.
    fn read_back(&self, lane: &mut Lane<'_>, note_id: &str, path: &str, size: u64) -> bool {
        let Ok(Some(row)) = lane.files().by_id(note_id) else {
            return false;
        };
        let Some(file_type) = file_type_of_extension(&extension(path)) else {
            return false;
        };
        let Ok(Some(file)) = self.read(path, file_type) else {
            return false;
        };
        if row.content_hash.as_deref() != Some(file.hash.as_str()) {
            return false;
        }
        record_large_file(lane.files(), note_id, large_file_class(&file.raw).is_some());
        refresh_read_back(lane, note_id, path, size, file.hash);
        true
    }
}

/// A file read back as recorded: the row's time moves on, so the walk does not read it again,
/// unless the body moved since (a pass a crash cut short): then the note stays behind its body
/// for the reconcile.
pub(super) fn refresh_read_back(
    lane: &mut Lane<'_>,
    note_id: &str,
    path: &str,
    size: u64,
    hash: String,
) {
    let stat = RowStat {
        file_type: FileType::Markdown,
        size,
        content_hash: Some(hash.clone()),
        file_hash: Some(hash),
    };
    if let Err(error) = lane.refresh(note_id, path, stat) {
        tracing::warn!(scope = SCOPE, note_id, "the row was not refreshed: {error}");
    }
}
