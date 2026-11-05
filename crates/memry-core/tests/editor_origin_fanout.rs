//! The editor host's fan-out on a real `data.db` (Step 14a): an update reaches
//! a document's listeners once it is committed, as the bytes that were sent and
//! with where it came from, so another window converges on the same body.

#![cfg(feature = "markdown")]

use std::sync::{Arc, Mutex};

use memry_core::api::editor::Origin;
use memry_core::crdt::update_log;

use crate::editor_support::{Fixture, Replica, fixture, local_blobs};

type Heard = Arc<Mutex<Vec<(Vec<u8>, Origin, usize)>>>;

/// A listener on `note` recording each update, its origin, and how many local
/// update rows were committed when it ran.
fn listen(f: &Fixture, note: &str) -> Heard {
    let heard: Heard = Arc::default();
    let sink = Arc::clone(&heard);
    let dir = f.dir.path().to_owned();
    let id = note.to_owned();
    f.editor.subscribe(note, move |bytes, origin| {
        let committed = local_blobs(&dir, &id).len();
        sink.lock()
            .unwrap()
            .push((bytes.to_vec(), origin.clone(), committed));
    });
    heard
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
fn bytes_committed_elsewhere_reach_the_open_document_and_its_listeners() {
    let f = fixture();
    let note = f.note();
    f.editor.open(&note, "main").expect("open");
    let heard = listen(&f, &note);
    let peer = Replica::new(9).type_text("from a peer");
    f.vault
        .db_handle()
        .call_blocking(|conn| {
            update_log::append_server_update(conn, &note, 1, &peer, 1).map_err(|e| {
                memry_core::api::errors::StorageError::Failed {
                    what: e.to_string(),
                }
            })
        })
        .expect("a merged server row");

    f.editor
        .absorb(&note, &peer, Origin::Remote)
        .expect("absorb");

    assert_eq!(
        heard.lock().unwrap().clone(),
        vec![(peer.clone(), Origin::Remote, 0)]
    );
    let side = Replica::from_state(2, &f.editor.open(&note, "side").expect("side").state);
    assert_eq!(side.text(), "from a peer", "the resident document took it");
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
        .subscribe(&note, move |_, _| *count.lock().unwrap() += 1);
    assert!(f.editor.unsubscribe(id));
    assert!(!f.editor.unsubscribe(id));

    f.editor
        .apply_update(&note, &main.type_text("x"), "main")
        .expect("apply");

    assert_eq!(*gone.lock().unwrap(), 0);
    assert!(theirs.lock().unwrap().is_empty());
}
