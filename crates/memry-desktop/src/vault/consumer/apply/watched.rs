//! A watcher's change of a note's file, and the typing of the windows that have the note open
//! (`editor::typing`).

use super::super::rows::{Lane, RowStat};
use super::{Applier, SCOPE, Step};
use crate::editor::BARRIER_WAIT;
use crate::vault::file_types::{FileType, extension, file_type_of_extension};
use crate::vault::note_file::{NoteFile, large_file_class, record_large_file};

/// What [`Applier::read_back`] found at the file's path.
enum ReadBack {
    /// The text the row names: recorded as read.
    Recorded,
    /// Other text, read once: `changed` takes it as it is.
    Differs(NoteFile),
    /// No row, or no file read: `changed` looks for itself.
    Unread,
}

impl Applier {
    /// A change that feeds the note's document waits for the typing of its windows first
    /// (`hold_typing`): before the lane, so a window that does not answer holds up no write of
    /// the rows, and dropped after the change applied, so a window hears the release after the
    /// edit. A window refuses what is typed while it holds, so a file that is already the text
    /// its row names asks no window: the app's own write, which the watcher reads as a change
    /// once the next save's record replaced its echo, or a change applied already. Asked for
    /// those, a window refused the typing of every save of a note with an inline tag (#3967).
    /// The file read here is the one `changed` applies, read once (#4222): a change the file
    /// made during the wait is a new watcher event.
    pub(super) fn watched_change(
        &self,
        mut lane: Lane<'_>,
        note_id: &str,
        path: &str,
        size: u64,
        modified_ms: i64,
    ) -> Step {
        let read = match self.read_back(&mut lane, note_id, path, size) {
            ReadBack::Recorded => return Step::Done,
            ReadBack::Differs(file) => Some(file),
            ReadBack::Unread => None,
        };
        drop(lane);
        let _typing = self
            .editor
            .upgrade()
            .and_then(|editor| editor.hold_typing(note_id, BARRIER_WAIT));
        let Ok(mut lane) = self.rows.lane_of(self.session) else {
            return Step::Done;
        };
        self.changed(&mut lane, note_id, path, (size, modified_ms), None, read)
    }

    /// Whether the markdown file at `path` is the text the note's row names, as `changed` reads
    /// it back; the row then records the read.
    fn read_back(&self, lane: &mut Lane<'_>, note_id: &str, path: &str, size: u64) -> ReadBack {
        let Ok(Some(row)) = lane.files().by_id(note_id) else {
            return ReadBack::Unread;
        };
        let Some(file_type) = file_type_of_extension(&extension(path)) else {
            return ReadBack::Unread;
        };
        let Ok(Some(file)) = self.read(path, file_type) else {
            return ReadBack::Unread;
        };
        if row.content_hash.as_deref() != Some(file.hash.as_str()) {
            return ReadBack::Differs(file);
        }
        record_large_file(lane.files(), note_id, large_file_class(&file.raw).is_some());
        refresh_read_back(lane, note_id, path, size, file.hash);
        ReadBack::Recorded
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
