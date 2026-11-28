//! A note owed its server body opens read-only while its body is empty (#2536): typed text
//! would start a root beside the server body's once that merges. A window's edit is refused
//! before anything is written, and the note takes edits again once the pulled body lands.

#![cfg(feature = "markdown")]

use memry_core::api::editor::{EditorError, ReadOnly};
use memry_core::api::errors::StorageError;
use memry_core::crdt::epoch::HeldBody;
use memry_core::sync::body_debt;

use crate::editor_support::{Fixture, Replica, fixture};

fn owe(f: &Fixture, note: &str) {
    f.vault
        .db_handle()
        .call_blocking(|conn| body_debt::owe(conn, note))
        .expect("owe");
}

/// The server body, stored as a body pull stores it.
fn pull(f: &Fixture, note: &str, text: &str) {
    let update = Replica::new(9).type_text(text);
    f.vault
        .db_handle()
        .call_blocking(|conn| {
            HeldBody::never_purged(conn, note)
                .and_then(|held| held.append_server_update(1, &update, 1))
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .expect("pull");
}

#[test]
fn an_owed_note_with_an_empty_body_opens_read_only_and_refuses_an_edit() {
    let f = fixture();
    let note = f.note();
    owe(&f, &note);

    let opened = f.editor.open(&note, "main").expect("open");
    assert_eq!(opened.read_only, Some(ReadOnly::BodyNotPulled));
    assert!(!opened.needs_seed, "an owed body is never seeded");
    let window = Replica::from_state(1, &opened.state);
    assert_eq!(
        f.editor
            .apply_update(&note, &window.type_text("typed"), "main"),
        Err(EditorError::BodyNotPulled {
            note_id: note.clone()
        })
    );
    assert!(f.local_blobs(&note).is_empty(), "no log row");
    assert_eq!(f.queued(&note), 0, "no outbox row");
    let side = Replica::from_state(2, &f.editor.open(&note, "side").expect("side").state);
    assert_eq!(side.text(), "", "the resident document never took it");
}

/// The pulled body lands while the window holds the note, before the debt settles: the next
/// open takes edits, and so does the window's edit on top of the pulled body.
#[test]
fn the_pulled_body_lifts_the_wait_before_the_debt_settles() {
    let f = fixture();
    let note = f.note();
    owe(&f, &note);
    let opened = f.editor.open(&note, "main").expect("open");
    assert_eq!(opened.read_only, Some(ReadOnly::BodyNotPulled));

    pull(&f, &note, "from the server");

    let reopened = f.editor.open(&note, "main").expect("reopen");
    assert_eq!(reopened.read_only, None);
    let window = Replica::from_state(1, &reopened.state);
    assert_eq!(window.text(), "from the server");
    f.editor
        .apply_update(&note, &window.type_text(", typed"), "main")
        .expect("an edit over the pulled body")
        .expect("changed");
}
