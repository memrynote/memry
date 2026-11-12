//! The files a run of the app wrote itself (`OwnFiles`), which a save replaces with no version.
//! Split from `app_edit`, which reads and keeps them.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::vault::consumer::ChangeSource;

/// By note id, the hash of the file this run wrote for the note, who wrote it, and from which
/// editor: set by its create and by a save that moved its body, carried by a save that did not
/// only while that file was still on disk, dropped when such a save lands on another or an
/// outside edit replaces it. A save replaces the run's own file, the row naming it, with no
/// version: the user saw it. Only the editor that wrote it saw it, though: two editors of one
/// note (a note tab and a canvas card) save in turn, and one's small save over the other's
/// would leave the other's text nowhere (#4137). So a file an editor saved is the run's own to
/// that editor's saves only ([`Self::is_own_to`]); one the app wrote for no editor (a create, a
/// restore, a journal day's save) is every save's. Any other file may hold an outside edit the
/// editor never showed (canvas, project overview), fed or not, so it is kept first. The
/// consumer reports the watcher's read of the run's own file as its writer's (a save whose
/// document did not take it).
///
/// Apart, by note id, the hash of the outside edit the consumer read last (watcher or open
/// walk) and the body did not take (typing won over it), while the file still holds it: what a
/// write-back that replaces it tells as an outside text replaced
/// (`Outcome::Wrote::replaced_outside`). An outside edit the body took is not in it: the body
/// holds its text, so nothing of it is replaced (#4124). A file the app wrote, in this run or
/// an earlier one, is never in it; an outside edit read in an earlier run and not replaced
/// since is not either, and goes untold.
///
/// Apart again, by note id, the hash of the bytes the write-back wrote last: the run's bytes too
/// ([`Self::ours`]), though a save does not replace them with no version, since no editor showed
/// them.
#[derive(Debug, Default)]
pub struct OwnFiles {
    marks: Mutex<HashMap<String, Mark>>,
    outside: Mutex<HashMap<String, String>>,
    written_back: Mutex<HashMap<String, String>>,
}

#[derive(Debug)]
struct Mark {
    hash: String,
    source: ChangeSource,
    /// The editor whose save wrote it; `None` for the app's write for no editor.
    editor: Option<String>,
}

impl OwnFiles {
    /// This run wrote `hash` as the note's text, as `source`, from `editor` when an editor's
    /// save wrote it.
    pub fn wrote(&self, note_id: &str, hash: &str, source: ChangeSource, editor: Option<&str>) {
        let mark = Mark {
            hash: hash.to_owned(),
            source,
            editor: editor.map(str::to_owned),
        };
        self.marks().insert(note_id.to_owned(), mark);
    }

    /// Who wrote `hash` as the note's text, when it is the text this run wrote last for it.
    pub(crate) fn writer(&self, note_id: &str, hash: &str) -> Option<ChangeSource> {
        self.marks()
            .get(note_id)
            .filter(|mark| mark.hash == hash)
            .map(|mark| mark.source)
    }

    /// Whether `hash` is the run's bytes for the note, whoever wrote them: no outside edit.
    pub(super) fn is(&self, note_id: &str, hash: &str) -> bool {
        self.writer(note_id, hash).is_some()
    }

    /// The write-back wrote `hash` as the note's text.
    pub(crate) fn wrote_back(&self, note_id: &str, hash: &str) {
        lock(&self.written_back).insert(note_id.to_owned(), hash.to_owned());
    }

    /// Whether `hash` is the bytes this run wrote last for the note: the write-back's, or another
    /// writer's of the app.
    pub(crate) fn ours(&self, note_id: &str, hash: &str) -> bool {
        lock(&self.written_back)
            .get(note_id)
            .is_some_and(|last| last == hash)
            || self.is(note_id, hash)
    }

    /// Whether `hash` is the run's own file to a save from `editor`: the run's bytes, written by
    /// that editor or for none (see the type's comment).
    pub(super) fn is_own_to(&self, note_id: &str, hash: &str, editor: Option<&str>) -> bool {
        self.marks().get(note_id).is_some_and(|mark| {
            mark.hash == hash && (mark.editor.is_none() || mark.editor.as_deref() == editor)
        })
    }

    /// An outside edit replaced the note's file with `hash`, which the body did not take
    /// (`None`: it took them, or the bytes were not read): bytes equal to the run's put back
    /// later are the outside's too.
    pub(crate) fn read_outside(&self, note_id: &str, hash: Option<&str>) {
        self.marks().remove(note_id);
        let mut outside = lock(&self.outside);
        match hash {
            Some(hash) => outside.insert(note_id.to_owned(), hash.to_owned()),
            None => outside.remove(note_id),
        };
    }

    /// Whether `hash` is the outside edit the consumer read last for the note.
    pub(crate) fn is_outside(&self, note_id: &str, hash: &str) -> bool {
        lock(&self.outside)
            .get(note_id)
            .is_some_and(|read| read == hash)
    }

    /// A vault opens: what the run wrote in another is not its own here, though a day's id is.
    pub(crate) fn clear(&self) {
        self.marks().clear();
        lock(&self.outside).clear();
        lock(&self.written_back).clear();
    }

    /// A save that left the body: `to` is the run's own only if `from`, the file it replaced,
    /// was.
    pub(super) fn carried(&self, note_id: &str, from: &str, to: &str) {
        let mut marks = self.marks();
        match marks.get_mut(note_id) {
            Some(mark) if mark.hash == from => mark.hash = to.to_owned(),
            _ => {
                marks.remove(note_id);
            }
        }
    }

    fn marks(&self) -> MutexGuard<'_, HashMap<String, Mark>> {
        lock(&self.marks)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The write-back's bytes are the run's: an app edit over them starts no late-write watch
    /// (`late_writes`), and they are not the run's own to a save, which keeps a version first.
    #[test]
    fn the_write_backs_bytes_are_the_runs_until_a_vault_opens() {
        let own = OwnFiles::default();
        own.wrote_back("n", "h1");
        assert!(own.ours("n", "h1"));
        assert!(!own.ours("n", "h0"));
        assert!(!own.is_own_to("n", "h1", None));
        own.clear();
        assert!(!own.ours("n", "h1"));
    }
}
