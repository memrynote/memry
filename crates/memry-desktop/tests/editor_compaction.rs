//! The editor host's compaction pass over a real session and `data.db` (Step 14i): the documents
//! that grew past the threshold are folded, an open window keeps typing through it and hears
//! nothing of it, and the body and the pending outbox rows are as before.

use std::fs;
use std::sync::{Arc, Mutex};

use memry_core::api::editor::COMPACTION_GROWTH_BYTES;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::editor::{EditorHost, Subscriber, compact_due};
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::projection::CancelToken;
use memry_desktop::session::{OpenSource, Session};
use rusqlite::{Connection, params};
use yrs::updates::decoder::Decode as _;
use yrs::{Doc, GetString as _, ReadTxn as _, Text as _, TextRef, Transact as _, Update};

use crate::device_key;

type Frames = Arc<Mutex<Vec<Vec<u8>>>>;

/// A window that rewrites its text on each edit, as a long session's deletes leave it.
struct Window {
    doc: Doc,
    text: TextRef,
}

impl Window {
    fn from_state(state: &[u8]) -> Self {
        let doc = Doc::new();
        let text = doc.get_or_insert_text("t");
        let window = Self { doc, text };
        window.apply(state);
        window
    }

    fn apply(&self, update: &[u8]) {
        self.doc
            .transact_mut()
            .apply_update(Update::decode_v1(update).unwrap())
            .unwrap();
    }

    fn rewrite(&self, value: &str) -> Vec<u8> {
        let before = self.doc.transact().state_vector();
        {
            let mut txn = self.doc.transact_mut();
            let len = self.text.len(&txn);
            self.text.remove_range(&mut txn, 0, len);
            self.text.insert(&mut txn, 0, value);
        }
        self.doc.transact().encode_diff_v1(&before)
    }

    fn value(&self) -> String {
        self.text.get_string(&self.doc.transact())
    }
}

fn recording(window: &str) -> (Subscriber, Frames) {
    let frames: Frames = Arc::default();
    let sink = Arc::clone(&frames);
    let subscriber = Subscriber {
        window_label: window.to_owned(),
        channel: Arc::new(move |frame| {
            sink.lock().unwrap().push(frame);
            true
        }),
    };
    (subscriber, frames)
}

fn count(db: &Connection, sql: &str, note: &str) -> i64 {
    db.query_row(sql, params![note], |row| row.get(0)).unwrap()
}

#[test]
fn a_document_grown_past_the_threshold_is_compacted_while_its_windows_keep_typing() {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    fs::create_dir_all(&vault).unwrap();
    let registry = VaultRegistry::new(Arc::new(AppConfig::load(
        dir.path().join("app/memry-config.json"),
    )));
    let session = Session::new(registry);
    let store: Arc<dyn SecureStore> = device_key::with_device_key();
    let host = EditorHost::new(store.clone(), |_| {});
    host.register(&session);
    session.open(&vault, OpenSource::Select).unwrap();
    let core = session.current().unwrap().vault;
    let note = core
        .notes_writer(store.clone())
        .unwrap()
        .create("A note".into(), None)
        .unwrap();
    let editor = core.editor(store.clone()).unwrap();

    let (main_sub, _) = recording("main");
    let main = Window::from_state(&host.open(&note, Some(&vault), main_sub).unwrap().state);
    let (side_sub, side_frames) = recording("side");
    let side = Window::from_state(&host.open(&note, Some(&vault), side_sub).unwrap().state);
    let mut typed = 0usize;
    let mut n = 0;
    while typed < COMPACTION_GROWTH_BYTES {
        assert!(
            n < 2 * COMPACTION_GROWTH_BYTES / 1024,
            "never reached the threshold"
        );
        let update = main.rewrite(&format!("{n:04}").repeat(256));
        typed += update.len();
        host.apply_update(&note, &update, "main").unwrap();
        n += 1;
    }
    let db = Connection::open(vault.join(".memry/core/data.db")).unwrap();
    let queued_sql = "SELECT COUNT(*) FROM outbox WHERE item_id = ?1 AND op = 'crdt-update'";
    let rows_sql = "SELECT COUNT(*) FROM yjs_updates WHERE doc_id = 'local.' || ?1";
    let queued = count(&db, queued_sql, &note);
    let heard = side_frames.lock().unwrap().len();

    let closing = CancelToken::default();
    closing.cancel();
    assert!(
        compact_due(&editor, &closing).is_empty(),
        "a closing vault folds nothing"
    );
    assert_eq!(editor.compaction_due(), vec![note.clone()]);

    let open = CancelToken::default();
    assert_eq!(compact_due(&editor, &open), vec![note.clone()]);

    assert_eq!(count(&db, rows_sql, &note), 0, "the log was folded");
    assert_eq!(
        count(&db, queued_sql, &note),
        queued,
        "pending rows untouched"
    );
    assert_eq!(
        side_frames.lock().unwrap().len(),
        heard,
        "windows hear nothing"
    );
    assert!(
        compact_due(&editor, &open).is_empty(),
        "the count starts over"
    );

    let update = main.rewrite("after the fold");
    host.apply_update(&note, &update, "main").unwrap();
    for frame in side_frames.lock().unwrap().iter() {
        side.apply(&frame[1..]);
    }
    assert_eq!(side.value(), "after the fold");
    host.close(&note, "main");
    host.close(&note, "side");
    let (again, _) = recording("main");
    let reopened = Window::from_state(&host.open(&note, Some(&vault), again).unwrap().state);
    assert_eq!(reopened.value(), "after the fold");
}
