//! A locked note in the editor host on a real `data.db` (Step 14e-1): it opens
//! read-only, and a window's edit is refused before anything is written, kept
//! in memory or handed to another window.

#![cfg(feature = "markdown")]

use std::sync::{Arc, Mutex};

use memry_core::api::editor::{EditorError, ReadOnly};
use memry_core::domain::vault_locks::TargetKind;

use crate::editor_support::{Replica, fixture};

#[test]
fn a_locked_note_opens_read_only_and_refuses_an_edit_before_anything_is_written() {
    let f = fixture();
    let note = f.note();
    let opened = f.editor.open(&note, "main").expect("open");
    assert_eq!(opened.read_only, None);
    let window = Replica::from_state(1, &opened.state);
    f.editor
        .apply_update(&note, &window.type_text("before"), "main")
        .expect("an unlocked edit")
        .expect("changed");

    f.vault
        .locks()
        .set(TargetKind::Note, &note, true)
        .expect("lock");
    assert_eq!(
        f.editor.open(&note, "main").expect("reopen").read_only,
        Some(ReadOnly::Locked)
    );
    let heard = Arc::new(Mutex::new(0));
    let count = Arc::clone(&heard);
    f.editor
        .subscribe(&note, move |_| *count.lock().unwrap() += 1);

    let refused = window.type_text(" after");
    assert_eq!(
        f.editor.apply_update(&note, &refused, "main"),
        Err(EditorError::Locked {
            note_id: note.clone()
        })
    );
    assert_eq!(f.local_blobs(&note).len(), 1, "no log row");
    assert_eq!(f.queued(&note), 1, "no outbox row");
    assert_eq!(*heard.lock().unwrap(), 0, "no window hears it");
    let side = Replica::from_state(2, &f.editor.open(&note, "side").expect("side").state);
    assert_eq!(side.text(), "before", "the resident document never took it");

    let f = f.relaunch();
    assert_eq!(
        Replica::from_state(3, &f.editor.open(&note, "main").expect("relaunch").state).text(),
        "before"
    );
    f.vault
        .locks()
        .set(TargetKind::Note, &note, false)
        .expect("unlock");
    assert_eq!(f.editor.open(&note, "main").expect("open").read_only, None);
    f.editor
        .apply_update(&note, &refused, "main")
        .expect("unlocked again")
        .expect("changed");
    assert_eq!(
        Replica::from_state(4, &f.editor.open(&note, "side").expect("side").state).text(),
        "before after"
    );
}

#[test]
fn a_folder_lock_makes_the_notes_filed_under_it_read_only() {
    let f = fixture();
    let note = f.note();
    f.file(&note, "Archive/2025/old.md");
    f.vault
        .locks()
        .set(TargetKind::Folder, "Archive", true)
        .expect("lock the folder");

    let opened = f.editor.open(&note, "main").expect("open");
    assert_eq!(opened.read_only, Some(ReadOnly::Locked));
    let window = Replica::from_state(1, &opened.state);
    assert_eq!(
        f.editor
            .apply_update(&note, &window.type_text("no"), "main"),
        Err(EditorError::Locked {
            note_id: note.clone()
        })
    );
    assert!(f.local_blobs(&note).is_empty());
}
