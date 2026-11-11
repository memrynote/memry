//! What the write-back did for each note, in the e2e build only (`getWritebackDebugState` of
//! desktop `crdt-writeback.ts`). The `e2e_writeback_debug_state` command reads it, so a spec can
//! wait for a pass that compared the body with the file instead of a file that never moved.

use std::collections::HashMap;

use super::pass::{Keep, Outcome};

/// One note's write-back so far in this vault session.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WriteBackDebug {
    /// Scheduled and not yet passed, or passing now.
    pub pending: bool,
    pub scheduled_count: u32,
    /// Passes that wrote the body or found the file already holding it.
    pub performed_count: u32,
    /// Why the last pass failed, `None` after a schedule or a pass that did not fail.
    pub last_error: Option<String>,
}

#[derive(Default)]
pub(super) struct Book {
    notes: HashMap<String, WriteBackDebug>,
    running: Option<String>,
}

impl Book {
    pub(super) fn scheduled(&mut self, note_id: &str) {
        let note = self.notes.entry(note_id.to_owned()).or_default();
        note.scheduled_count += 1;
        note.last_error = None;
    }

    pub(super) fn started(&mut self, note_id: &str) {
        self.running = Some(note_id.to_owned());
    }

    pub(super) fn finished(&mut self, note_id: &str, outcome: &Outcome) {
        self.running = None;
        let note = self.notes.entry(note_id.to_owned()).or_default();
        match outcome {
            Outcome::Wrote { .. } | Outcome::Unchanged => {
                note.performed_count += 1;
                note.last_error = None;
            }
            Outcome::Failed(reason) | Outcome::FrontmatterUnreadable(reason) => {
                note.last_error = Some(reason.clone());
            }
            Outcome::Kept(Keep::NotRepresentable(what)) => {
                note.last_error = Some(format!("unrepresentable: {}", what.join(",")));
            }
            Outcome::Kept(_) => {}
        }
    }

    /// The note's state, `pending` read from the queue's `due`; `None` before its first
    /// schedule.
    pub(super) fn of(&self, note_id: &str, due: bool) -> Option<WriteBackDebug> {
        self.notes.get(note_id).map(|note| WriteBackDebug {
            pending: due || self.running.as_deref() == Some(note_id),
            ..note.clone()
        })
    }
}
