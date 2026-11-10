//! A note whose file the vault's exclude patterns cover, in the editor host on a real
//! `data.db` (#3530 13m-7b-3b): it opens read-only, and a window's edit is refused before
//! anything is written, also when the pattern came while the note was open. Dropping it takes
//! the edit again.

#![cfg(feature = "markdown")]

use memry_core::api::editor::{EditorError, ReadOnly};

use crate::editor_support::{Replica, fixture};

#[test]
fn an_excluded_note_opens_read_only_and_refuses_an_edit_set_while_it_was_open() {
    let f = fixture();
    let note = f.note();
    f.file(&note, "archive/old.md");
    let opened = f.editor.open(&note, "main").expect("open");
    assert_eq!(opened.read_only, None);
    let window = Replica::from_state(1, &opened.state);
    f.editor
        .apply_update(&note, &window.type_text("before"), "main")
        .expect("an edit")
        .expect("changed");

    f.vault
        .excluded()
        .set(|path| path.split('/').any(|segment| segment == "archive"));
    let refused = window.type_text(" after");
    assert_eq!(
        f.editor.apply_update(&note, &refused, "main"),
        Err(EditorError::Excluded {
            note_id: note.clone()
        })
    );
    assert_eq!(f.local_blobs(&note).len(), 1, "no log row");
    assert_eq!(f.queued(&note), 1, "no outbox row");
    assert_eq!(
        f.editor.open(&note, "main").expect("reopen").read_only,
        Some(ReadOnly::Excluded)
    );
    let side = Replica::from_state(2, &f.editor.open(&note, "side").expect("side").state);
    assert_eq!(side.text(), "before", "the resident document never took it");

    f.vault.excluded().set(|_| false);
    assert_eq!(f.editor.open(&note, "main").expect("open").read_only, None);
    f.editor
        .apply_update(&note, &refused, "main")
        .expect("no longer excluded")
        .expect("changed");
}

/// A note the patterns do not cover is not read-only for them.
#[test]
fn a_note_outside_the_patterns_takes_its_edits() {
    let f = fixture();
    let note = f.note();
    f.file(&note, "notes/archive.md");
    f.vault
        .excluded()
        .set(|path| path.split('/').next() == Some("archive"));
    let opened = f.editor.open(&note, "main").expect("open");
    assert_eq!(opened.read_only, None);
    let window = Replica::from_state(1, &opened.state);
    f.editor
        .apply_update(&note, &window.type_text("typed"), "main")
        .expect("an edit")
        .expect("changed");
}
