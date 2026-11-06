//! The files a run of the app wrote itself (`OwnFiles`), which a save replaces with no version.
//! Split from `app_edit`, which reads and keeps them.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::vault::consumer::ChangeSource;

/// By note id, the hash of the file this run wrote for the note, and who wrote it: set by its
/// create and by a save that moved its body, carried by a save that did not only while that
/// file was still on disk, dropped when such a save lands on another or an outside edit
/// replaces it. A save replaces the run's own file, the row naming it, with no version: the
/// user saw it. Any other file may hold an outside edit the editor never showed (canvas,
/// project overview), fed or not, so it is kept first. The consumer reports the watcher's read
/// of the run's own file as its writer's (a save whose document did not take it).
#[derive(Debug, Default)]
pub struct OwnFiles(Mutex<HashMap<String, (String, ChangeSource)>>);

impl OwnFiles {
    /// This run wrote `hash` as the note's text, as `source`.
    pub fn wrote(&self, note_id: &str, hash: &str, source: ChangeSource) {
        self.marks()
            .insert(note_id.to_owned(), (hash.to_owned(), source));
    }

    /// Who wrote `hash` as the note's text, when it is the text this run wrote last for it.
    pub(crate) fn writer(&self, note_id: &str, hash: &str) -> Option<ChangeSource> {
        self.marks()
            .get(note_id)
            .filter(|(own, _)| own == hash)
            .map(|(_, source)| *source)
    }

    pub(super) fn is(&self, note_id: &str, hash: &str) -> bool {
        self.writer(note_id, hash).is_some()
    }

    /// An outside edit replaced the note's file: bytes equal to the run's put back later are
    /// the outside's too.
    pub(crate) fn forget(&self, note_id: &str) {
        self.marks().remove(note_id);
    }

    /// A vault opens: what the run wrote in another is not its own here, though a day's id is.
    pub(crate) fn clear(&self) {
        self.marks().clear();
    }

    /// A save that left the body: `to` is the run's own only if `from`, the file it replaced,
    /// was.
    pub(super) fn carried(&self, note_id: &str, from: &str, to: &str) {
        let mut marks = self.marks();
        match marks.get_mut(note_id) {
            Some((own, _)) if own == from => *own = to.to_owned(),
            _ => {
                marks.remove(note_id);
            }
        }
    }

    fn marks(&self) -> MutexGuard<'_, HashMap<String, (String, ChangeSource)>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
