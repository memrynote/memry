//! The files of deleted notes (module invariants, "A deleted note's file goes to the OS
//! trash"), through a trash that is a folder of the test: the real OS trash is the crash
//! test's (`tests/writeback_crash.rs`).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::*;
use crate::vault::writeback::Leftover;

/// A trash that moves what it is given into a folder of its own, or refuses everything.
struct Bin {
    dir: tempfile::TempDir,
    refuse: bool,
    got: Mutex<Vec<PathBuf>>,
}

impl Bin {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
            refuse: false,
            got: Mutex::default(),
        }
    }

    fn take(&self, path: &Path) -> Result<(), String> {
        self.got.lock().unwrap().push(path.to_owned());
        if self.refuse {
            return Err("no".into());
        }
        let to = self.dir.path().join(path.file_name().unwrap());
        std::fs::rename(path, to).map_err(|error| error.to_string())
    }

    fn holds(&self, name: &str) -> Option<String> {
        std::fs::read_to_string(self.dir.path().join(name)).ok()
    }
}

fn trash(f: &Fixture, bin: &Bin) -> Vec<(String, Leftover)> {
    f.pass.trash_deleted(&|path| bin.take(path))
}

#[test]
fn a_deleted_notes_file_goes_to_the_trash_and_its_row_with_it() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    let live = f.adopt("live.md", "still here\n");
    f.writer.delete(id.clone()).unwrap();
    let bin = Bin::new();
    assert_eq!(trash(&f, &bin), [(id.clone(), Leftover::Trashed)]);
    assert_eq!(bin.holds("n.md").as_deref(), Some("first words\n"));
    assert!(!f.root.join("n.md").exists());
    assert!(f.vault.note_files().by_id(&id).unwrap().is_none());
    assert!(
        f.echo.absorbs_removal("n.md"),
        "the move came back as an outside removal"
    );
    let facts = f.facts();
    assert!(
        facts.iter().any(|fact| matches!(fact, Applied::Removed { note_id, path } if *note_id == id && path == "n.md")),
        "{facts:?}"
    );
    assert_eq!(f.read("live.md"), "still here\n");
    assert!(f.vault.note_files().by_id(&live).unwrap().is_some());
    assert!(trash(&f, &bin).is_empty(), "a second open trashes again");
}

/// The file was edited after its row read it, or its document never took it: it holds bytes
/// the note did not, and stays where it is, with its row.
#[test]
fn a_deleted_notes_file_with_bytes_the_note_did_not_hold_stays_with_its_row() {
    let mut f = fixture();
    let edited = f.adopt("edited.md", "first words\n");
    f.write("edited.md", "edited after the read\n");
    let unread = f.adopt("unread.md", "never taken\n");
    f.record(&unread, "unread.md", None);
    f.writer.delete(edited.clone()).unwrap();
    f.writer.delete(unread.clone()).unwrap();
    let bin = Bin::new();
    assert_eq!(
        trash(&f, &bin),
        [
            (edited.clone(), Leftover::Kept),
            (unread.clone(), Leftover::Kept)
        ]
    );
    assert!(bin.got.lock().unwrap().is_empty());
    assert_eq!(f.read("edited.md"), "edited after the read\n");
    assert_eq!(f.read("unread.md"), "never taken\n");
    assert!(f.vault.note_files().by_id(&edited).unwrap().is_some());
    assert!(f.vault.note_files().by_id(&unread).unwrap().is_some());
}

#[test]
fn a_deleted_notes_row_whose_file_is_gone_is_removed() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    std::fs::remove_file(f.root.join("n.md")).unwrap();
    f.writer.delete(id.clone()).unwrap();
    let bin = Bin::new();
    assert_eq!(trash(&f, &bin), [(id.clone(), Leftover::Gone)]);
    assert!(bin.got.lock().unwrap().is_empty());
    assert!(f.vault.note_files().by_id(&id).unwrap().is_none());
}

#[test]
fn a_file_the_trash_refuses_stays_with_its_row_for_the_next_open() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    f.writer.delete(id.clone()).unwrap();
    let mut bin = Bin::new();
    bin.refuse = true;
    let done = trash(&f, &bin);
    assert!(
        matches!(done.as_slice(), [(n, Leftover::Failed(_))] if *n == id),
        "{done:?}"
    );
    assert_eq!(f.read("n.md"), "first words\n");
    assert!(f.vault.note_files().by_id(&id).unwrap().is_some());
    bin.refuse = false;
    assert_eq!(trash(&f, &bin), [(id, Leftover::Trashed)]);
}
