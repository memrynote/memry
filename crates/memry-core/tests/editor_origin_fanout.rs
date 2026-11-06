//! The editor host's fan-out on a real `data.db` (Step 14a): an update reaches
//! a document's listeners once it is committed, as the bytes that were sent and
//! with where it came from, so another window converges on the same body.

#![cfg(feature = "markdown")]

use std::sync::{Arc, Mutex};

use memry_core::api::editor::{EditorError, Notice, Origin};
use memry_core::api::errors::StorageError;
use memry_core::crdt::{CrdtError, update_log};

use crate::editor_support::{Fixture, Replica, fixture, local_blobs};

type Heard = Arc<Mutex<Vec<(Vec<u8>, Origin, usize)>>>;

/// A listener on `note` recording each update, its origin, and how many local
/// update rows were committed when it ran.
fn listen(f: &Fixture, note: &str) -> Heard {
    let heard: Heard = Arc::default();
    let sink = Arc::clone(&heard);
    let dir = f.dir.path().to_owned();
    let id = note.to_owned();
    f.editor.subscribe(note, move |notice| {
        if let Notice::Update(bytes, origin) = notice {
            let committed = local_blobs(&dir, &id).len();
            sink.lock()
                .unwrap()
                .push((bytes.to_vec(), origin.clone(), committed));
        }
    });
    heard
}

/// A deferred foreign key fails the next commit that writes a body row, after
/// its rows were written.
fn arm_failing_commit(f: &Fixture) {
    run(
        f,
        "PRAGMA foreign_keys = ON;
         CREATE TEMP TABLE parent (id INTEGER PRIMARY KEY);
         CREATE TEMP TABLE child (p INTEGER REFERENCES parent (id)
           DEFERRABLE INITIALLY DEFERRED);
         CREATE TEMP TRIGGER fail_commit AFTER INSERT ON main.yjs_updates
         BEGIN INSERT INTO child VALUES (42); END;",
    );
}

fn run(f: &Fixture, sql: &str) {
    f.vault
        .db_handle()
        .call_blocking(|conn| {
            conn.execute_batch(sql).map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })
        })
        .expect(sql);
}

/// A merged server row, committed through the vault's database.
fn run_server_row(f: &Fixture, note: &str, update: &[u8]) {
    f.vault
        .db_handle()
        .call_blocking(|conn| {
            update_log::append_server_update(conn, note, 1, update, 1).map_err(|e| {
                StorageError::Failed {
                    what: e.to_string(),
                }
            })
        })
        .expect("a merged server row");
}

#[test]
fn a_window_edit_reaches_the_other_window_after_its_commit_as_sent() {
    let f = fixture();
    let note = f.note();
    let main = Replica::from_state(1, &f.editor.open(&note, "main").expect("main").state);
    let side = Replica::from_state(2, &f.editor.open(&note, "side").expect("side").state);
    let heard = listen(&f, &note);

    let update = main.type_text("typed in main");
    f.editor
        .apply_update(&note, &update, "main")
        .expect("apply");

    let heard = heard.lock().unwrap().clone();
    assert_eq!(
        heard,
        vec![(update.clone(), Origin::Local("main".to_owned()), 1)],
        "the bytes as sent, tagged with the sender, after the row committed"
    );
    side.apply(&heard[0].0);
    assert_eq!(side.text(), main.text());
}

#[test]
fn a_refused_update_reaches_no_listener() {
    let f = fixture();
    let note = f.note();
    f.editor.open(&note, "main").expect("open");
    let heard = listen(&f, &note);

    assert!(f.editor.apply_update(&note, &[0xff; 4], "main").is_err());

    assert!(heard.lock().unwrap().is_empty());
}

#[test]
fn a_merged_server_update_reaches_the_open_document_and_its_listeners_as_remote() {
    let f = fixture();
    let note = f.note();
    let main = Replica::from_state(1, &f.editor.open(&note, "main").expect("open").state);
    let heard = listen(&f, &note);
    let peer = Replica::new(9).type_text("from a peer");
    run_server_row(&f, &note, &peer);
    run_server_row(&f, &note, &peer);

    let heard = heard.lock().unwrap().clone();
    assert_eq!(
        heard.len(),
        1,
        "one notice, after the commit; a redelivery adds nothing"
    );
    assert_eq!(heard[0].1, Origin::Remote);
    main.apply(&heard[0].0);
    assert_eq!(main.text(), "from a peer");
    let side = Replica::from_state(2, &f.editor.open(&note, "side").expect("side").state);
    assert_eq!(side.text(), "from a peer", "the resident document took it");
}

#[test]
fn a_held_document_dropped_after_a_failed_commit_still_hears_the_next_merge() {
    let f = fixture();
    let note = f.note();
    let main = Replica::from_state(1, &f.editor.open(&note, "main").expect("open").state);
    arm_failing_commit(&f);
    let refused = f
        .editor
        .apply_update(&note, &main.type_text("lost"), "main");
    assert!(
        refused.is_err(),
        "the resident copy is dropped with the edit"
    );
    run(&f, "DROP TRIGGER temp.fail_commit");
    let heard = listen(&f, &note);
    let peer = Replica::new(9).type_text("from a peer");

    run_server_row(&f, &note, &peer);

    let heard = heard.lock().unwrap().clone();
    assert_eq!(
        heard.len(),
        1,
        "the windows of a held document hear the merge"
    );
    let side = Replica::new(2);
    side.apply(&heard[0].0);
    assert_eq!(side.text(), "from a peer");
}

#[test]
fn an_unsubscribed_listener_and_another_documents_listener_hear_nothing() {
    let f = fixture();
    let note = f.note();
    let other = f.note();
    let main = Replica::from_state(1, &f.editor.open(&note, "main").expect("open").state);
    let theirs = listen(&f, &other);
    let gone: Arc<Mutex<usize>> = Arc::default();
    let count = Arc::clone(&gone);
    let id = f
        .editor
        .subscribe(&note, move |_| *count.lock().unwrap() += 1);
    assert!(f.editor.unsubscribe(id));
    assert!(!f.editor.unsubscribe(id));

    f.editor
        .apply_update(&note, &main.type_text("x"), "main")
        .expect("apply");

    assert_eq!(*gone.lock().unwrap(), 0);
    assert!(theirs.lock().unwrap().is_empty());
}

#[test]
fn a_commit_that_fails_leaves_no_row_no_listener_and_no_edit_in_memory() {
    let f = fixture();
    let note = f.note();
    let main = Replica::from_state(1, &f.editor.open(&note, "main").expect("open").state);
    let heard = listen(&f, &note);
    arm_failing_commit(&f);

    let refused = f
        .editor
        .apply_update(&note, &main.type_text("lost at commit"), "main");

    assert!(matches!(
        refused,
        Err(EditorError::Crdt(CrdtError::Storage { .. }))
    ));
    assert!(heard.lock().unwrap().is_empty());
    assert!(f.local_blobs(&note).is_empty());
    assert_eq!(f.queued(&note), 0);
    let side = Replica::from_state(2, &f.editor.open(&note, "side").expect("side").state);
    assert_eq!(
        side.text(),
        "",
        "the resident document let the edit go with its rows"
    );
}

#[test]
fn a_listener_that_panics_takes_neither_the_answer_nor_the_other_listeners_down() {
    let f = fixture();
    let note = f.note();
    let main = Replica::from_state(1, &f.editor.open(&note, "main").expect("open").state);
    f.editor.subscribe(&note, |_| panic!("a broken listener"));
    let heard = listen(&f, &note);

    let applied = f.editor.apply_update(&note, &main.type_text("x"), "main");

    assert!(
        matches!(applied, Ok(Some(_))),
        "the durable edit is answered"
    );
    assert_eq!(
        heard.lock().unwrap().len(),
        1,
        "the next listener still ran"
    );
}
