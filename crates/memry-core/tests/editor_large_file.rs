//! A large-file-class note in the editor host on a real `data.db` (Step 14c-2): it opens
//! read-only from the class its file's last read recorded, and a window's edit is refused
//! before anything is written, kept in memory or handed to another window.

#![cfg(feature = "markdown")]

use std::sync::{Arc, Mutex};

use memry_core::api::editor::{EditorError, ReadOnly};

use crate::editor_support::{Fixture, Replica, fixture};

fn heard(f: &Fixture, note: &str) -> Arc<Mutex<usize>> {
    let heard = Arc::new(Mutex::new(0));
    let count = Arc::clone(&heard);
    f.editor
        .subscribe(note, move |_| *count.lock().unwrap() += 1);
    heard
}

fn record(f: &Fixture, note: &str, large: bool) {
    f.vault
        .note_files()
        .record_large_file(note, large)
        .expect("record the class");
}

#[test]
fn a_large_file_note_opens_read_only_and_refuses_an_edit_before_anything_is_written() {
    let f = fixture();
    let note = f.note();
    record(&f, &note, true);

    let opened = f.editor.open(&note, "main").expect("open");
    assert_eq!(opened.read_only, Some(ReadOnly::LargeFile));
    assert!(
        !opened.needs_seed,
        "a large file's text never seeds the body"
    );
    let heard = heard(&f, &note);
    let window = Replica::from_state(1, &opened.state);

    assert_eq!(
        f.editor
            .apply_update(&note, &window.type_text("typed"), "main"),
        Err(EditorError::LargeFile {
            note_id: note.clone()
        })
    );
    assert!(f.local_blobs(&note).is_empty(), "no log row");
    assert_eq!(f.queued(&note), 0, "no outbox row");
    assert_eq!(*heard.lock().unwrap(), 0, "no window hears it");
    let side = Replica::from_state(2, &f.editor.open(&note, "side").expect("side").state);
    assert_eq!(side.text(), "", "the resident document never took it");
}

/// The class moves with the file: a note whose file grew past the threshold while a window
/// held it refuses that window's next edit, stays read-only across a relaunch, and takes edits
/// again once its file shrank back.
#[test]
fn a_file_that_grows_and_shrinks_turns_edits_off_and_on_while_open_and_across_a_relaunch() {
    let f = fixture();
    let note = f.note();
    let opened = f.editor.open(&note, "main").expect("open");
    assert_eq!(opened.read_only, None);
    let window = Replica::from_state(1, &opened.state);
    f.editor
        .apply_update(&note, &window.type_text("before"), "main")
        .expect("a note-class edit")
        .expect("changed");

    record(&f, &note, true);
    let refused = window.type_text(" grown");
    assert_eq!(
        f.editor.apply_update(&note, &refused, "main"),
        Err(EditorError::LargeFile {
            note_id: note.clone()
        })
    );
    assert_eq!(
        f.editor.open(&note, "main").expect("reopen").read_only,
        Some(ReadOnly::LargeFile)
    );

    let f = f.relaunch();
    let opened = f.editor.open(&note, "main").expect("relaunch");
    assert_eq!(opened.read_only, Some(ReadOnly::LargeFile));
    assert_eq!(Replica::from_state(3, &opened.state).text(), "before");
    assert!(f.editor.apply_update(&note, &refused, "main").is_err());
    assert_eq!(f.local_blobs(&note).len(), 1, "only the note-class edit");

    record(&f, &note, false);
    assert_eq!(f.editor.open(&note, "main").expect("open").read_only, None);
    f.editor
        .apply_update(&note, &refused, "main")
        .expect("note class again")
        .expect("changed");
    assert_eq!(
        Replica::from_state(4, &f.editor.open(&note, "side").expect("side").state).text(),
        "before grown"
    );
}
