//! A locked note in the editor host on a real `data.db` (Step 14e-1): it opens
//! read-only, and a window's edit is refused before anything is written, kept
//! in memory or handed to another window.

#![cfg(feature = "markdown")]

use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use memry_core::api::editor::{EditorError, Notice, Origin, ReadOnly};
use memry_core::api::errors::StorageError;
use memry_core::domain::vault_locks::{self, TargetKind};
use memry_core::protocol::types::Declaration;
use memry_core::sync::body_pull::BodyPull;
use serde_json::json;

use crate::editor_every_writer::{PassThrough, http};
use crate::editor_support::{Replica, fixture};
use crate::http_fakes::{FakeTransport, response};

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

/// The check runs on the writer, inside the edit's turn: a lock committed while
/// the edit waited for the writer refuses it.
#[test]
fn a_lock_taken_while_an_edit_waits_for_the_writer_refuses_it() {
    let f = fixture();
    let note = f.note();
    let window = Replica::from_state(1, &f.editor.open(&note, "main").expect("open").state);
    let edit = window.type_text("typed");
    let (holding, held) = mpsc::channel();
    let (db, id) = (f.vault.db_handle(), note.clone());
    let locker = std::thread::spawn(move || {
        db.call_blocking(|conn| {
            holding.send(()).expect("signal");
            // The edit asks for the writer while this closure holds it.
            std::thread::sleep(Duration::from_millis(300));
            vault_locks::set(conn, TargetKind::Note, &id, true, 1)?;
            Ok::<_, StorageError>(())
        })
        .expect("the lock");
    });
    held.recv().expect("the locker holds the writer");

    let refused = f.editor.apply_update(&note, &edit, "main");
    locker.join().expect("the locker thread");

    assert_eq!(
        refused,
        Err(EditorError::Locked {
            note_id: note.clone()
        })
    );
    assert!(f.local_blobs(&note).is_empty(), "no log row");
    assert_eq!(f.queued(&note), 0, "no outbox row");
}

/// Each update a listener heard, with its origin.
type Heard = Arc<Mutex<Vec<(Vec<u8>, Origin)>>>;

/// A lock stops this device's edits only: another device's body still reaches
/// a locked open note, as in Electron (`vault-locks/registry.ts`).
#[tokio::test]
async fn a_pulled_snapshot_still_reaches_a_locked_open_note_as_remote() {
    let f = fixture();
    let note = f.note();
    f.vault
        .locks()
        .set(TargetKind::Note, &note, true)
        .expect("lock");
    let opened = f.editor.open(&note, "main").expect("open");
    assert_eq!(opened.read_only, Some(ReadOnly::Locked));
    let main = Replica::from_state(1, &opened.state);
    let heard: Heard = Arc::default();
    let sink = Arc::clone(&heard);
    f.editor.subscribe(&note, move |notice| {
        if let Notice::Update(bytes, origin) = notice {
            sink.lock().unwrap().push((bytes.to_vec(), origin.clone()));
        }
    });
    let peer = Replica::new(9);
    peer.type_text("from another device");
    let snapshot = json!({
        "snapshot": BASE64.encode(peer.full_state()), "sequenceNum": 3,
        "signerDeviceId": "device-b", "revision": "r1",
    });
    let transport = FakeTransport::new(vec![
        response(200, &snapshot.to_string()),
        response(200, &json!({ "updates": [], "hasMore": false }).to_string()),
    ]);
    let pull = BodyPull::new(
        http(transport),
        f.vault.db_handle(),
        Declaration::subscribed(),
        Arc::new(PassThrough),
    );

    assert_eq!(
        pull.pull_document(&note).await.expect("the pull").baselines,
        1
    );

    let heard = heard.lock().unwrap().clone();
    let [(update, origin)] = heard.as_slice() else {
        panic!("expected one update, heard {heard:?}");
    };
    assert_eq!(origin, &Origin::Remote);
    main.apply(update);
    assert!(main.text().contains("from another device"));
    let side = Replica::from_state(2, &f.editor.open(&note, "side").expect("side").state);
    assert!(side.text().contains("from another device"));
}
