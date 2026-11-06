//! Local compaction of the editor's documents on a real `data.db` (Step 14i):
//! the fold keeps every committed update, a window's edit racing it, the
//! pending outbox rows as queued, and a peer's edit made before it.

#![cfg(feature = "markdown")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use memry_core::api::editor::{COMPACTION_GROWTH_BYTES, Notice, Origin};
use memry_core::crdt::BODY_FRAGMENT;
use memry_core::crdt::body_writes::{BodyObserver as _, BodyWrite, LogRow};
use memry_core::crdt::update_log::{self, Namespace};
use memry_core::domain::note_files;
use rusqlite::{Connection, params};
use yrs::updates::decoder::Decode as _;
use yrs::{
    Doc, ReadTxn as _, StateVector, Transact as _, Update, XmlFragment as _, XmlFragmentRef,
    XmlTextPrelim,
};

use crate::editor_support::{Fixture, Replica, fixture};

/// A window that rewrites the whole body on each edit: the log grows by the
/// text each time while the body stays one paragraph, as a long typing session's
/// deletes leave it.
struct Rewriter {
    doc: Doc,
    body: XmlFragmentRef,
}

impl Rewriter {
    fn from_state(client_id: u64, state: &[u8]) -> Self {
        let doc = Doc::with_client_id(client_id);
        let body = doc.get_or_insert_xml_fragment(BODY_FRAGMENT);
        doc.transact_mut()
            .apply_update(Update::decode_v1(state).unwrap())
            .unwrap();
        Self { doc, body }
    }

    fn rewrite(&self, text: &str) -> Vec<u8> {
        let before: StateVector = self.doc.transact().state_vector();
        {
            let mut txn = self.doc.transact_mut();
            let len = self.body.len(&txn);
            self.body.remove_range(&mut txn, 0, len);
            self.body.insert(&mut txn, 0, XmlTextPrelim::new(text));
        }
        self.doc.transact().encode_diff_v1(&before)
    }
}

fn kib(n: usize) -> String {
    format!("{n:04}").repeat(256)
}

fn raw(f: &Fixture) -> Connection {
    Connection::open(f.dir.path().join("data.db")).expect("a connection of its own")
}

/// Every `crdt-update` outbox row of `note`, as `(id, payload)`.
fn outbox(f: &Fixture, note: &str) -> Vec<(i64, String)> {
    let conn = raw(f);
    let mut statement = conn
        .prepare(
            "SELECT id, hex(payload) FROM outbox
              WHERE item_id = ?1 AND op = 'crdt-update' ORDER BY id",
        )
        .unwrap();
    statement
        .query_map(params![note], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn local_rows(f: &Fixture, note: &str) -> usize {
    let conn = raw(f);
    update_log::updates_after(&conn, Namespace::Local, note, 0)
        .unwrap()
        .len()
}

/// The body as a relaunched vault replays it from the log.
fn body_after_relaunch(f: Fixture, note: &str) -> String {
    let f = f.relaunch();
    let state = f.editor.open(note, "main").expect("reopen").state;
    Replica::from_state(99, &state).text()
}

#[test]
fn a_document_grown_past_the_threshold_is_due_and_its_fold_keeps_the_body_and_the_outbox() {
    let f = fixture();
    let note = f.note();
    let window = Rewriter::from_state(1, &f.editor.open(&note, "main").unwrap().state);
    let mut last = String::new();
    let mut n = 0;
    while !f.editor.compaction_due().contains(&note) {
        assert!(n < 2 * COMPACTION_GROWTH_BYTES / 1024, "never due");
        last = kib(n);
        let update = window.rewrite(&last);
        f.editor.apply_update(&note, &update, "main").unwrap();
        n += 1;
    }
    let queued = outbox(&f, &note);
    assert_eq!(queued.len(), n, "one pending outbox row per edit");

    let folded = f.editor.compact(&note).unwrap().expect("a fold");

    assert!(folded.saved_bytes > COMPACTION_GROWTH_BYTES / 2);
    assert_eq!(
        local_rows(&f, &note),
        0,
        "the fold deleted the rows it holds"
    );
    assert_eq!(
        outbox(&f, &note),
        queued,
        "pending outbox rows are untouched"
    );
    assert!(!f.editor.compaction_due().contains(&note));
    assert_eq!(
        f.editor.compact(&note).unwrap(),
        None,
        "nothing left to fold"
    );
    assert_eq!(body_after_relaunch(f, &note), last);
}

/// Probabilistic: a compaction loop races the edits, so how they interleave
/// varies from run to run. The guards are structural (the read, the encode
/// and the fold are one transaction, and `fold_local_in` refuses autocommit,
/// `update_log_tests.rs`); with the read and the fold split into two writer
/// turns this went red in 2 runs of 3.
#[test]
fn a_window_typing_while_the_log_is_compacted_loses_no_edit() {
    let f = fixture();
    let note = f.note();
    let window = Rewriter::from_state(1, &f.editor.open(&note, "main").unwrap().state);
    let stop = Arc::new(AtomicBool::new(false));
    let compactor = {
        let editor = Arc::clone(&f.editor);
        let note = note.clone();
        let stop = Arc::clone(&stop);
        thread::spawn(move || {
            let mut folds = 0usize;
            while !stop.load(Ordering::Relaxed) {
                if editor.compact(&note).expect("a compaction").is_some() {
                    folds += 1;
                }
                thread::yield_now();
            }
            folds
        })
    };

    let edits = 600;
    let mut last = String::new();
    for n in 0..edits {
        last = kib(n);
        let update = window.rewrite(&last);
        if let Err(error) = f.editor.apply_update(&note, &update, "main") {
            stop.store(true, Ordering::Relaxed);
            panic!("edit {n} was refused: {error}");
        }
    }
    stop.store(true, Ordering::Relaxed);
    let folds = compactor.join().expect("the compactor never failed");

    assert!(folds > 0, "the race ran: some compaction folded");
    assert_eq!(outbox(&f, &note).len(), edits, "every edit is still queued");
    assert_eq!(body_after_relaunch(f, &note), last);
}

#[test]
fn an_edit_made_against_the_body_before_its_fold_merges_after_it() {
    let f = fixture();
    let note = f.note();
    let opened = f.editor.open(&note, "main").unwrap().state;
    let writer = Rewriter::from_state(1, &opened);
    let mut churned = Vec::new();
    for n in 0..40 {
        churned.push(writer.rewrite(&kib(n)));
    }
    // A second window, or a peer, types against the body as it was halfway:
    // its paragraph follows one the later rewrites delete.
    let typed = Replica::new(2);
    typed.apply(&opened);
    for update in &churned[..20] {
        typed.apply(update);
    }
    let peer = typed.type_text("from the other window");
    for update in &churned {
        f.editor.apply_update(&note, update, "main").unwrap();
    }

    f.editor.compact(&note).unwrap().expect("a fold");
    f.editor.open(&note, "second").unwrap();
    assert!(
        f.editor
            .apply_update(&note, &peer, "second")
            .unwrap()
            .is_some()
    );

    let body = body_after_relaunch(f, &note);
    assert_eq!(body.len(), 1024 + "from the other window".len(), "{body}");
    assert!(body.contains(&kib(39)), "{body}");
    assert!(body.contains("from the other window"), "{body}");
}

/// A writer's row can be folded away between its commit and the moment its
/// observer reads it back (`catch_up` reads on a pool connection after the
/// writer is released). The open document still takes it, from the snapshot.
#[test]
fn a_row_folded_before_its_writer_was_heard_still_reaches_the_open_document() {
    let f = fixture();
    let note = f.note();
    let opened = f.editor.open(&note, "main").unwrap().state;
    let window = Rewriter::from_state(1, &opened);
    for n in 0..40 {
        let update = window.rewrite(&kib(n));
        f.editor.apply_update(&note, &update, "main").unwrap();
    }
    let heard: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
    let sink = Arc::clone(&heard);
    f.editor.subscribe(&note, move |notice| {
        if let Notice::Update(bytes, _) = notice {
            sink.lock().unwrap().push(bytes.to_vec());
        }
    });

    // Another writer commits an outside edit; before its observer runs, the
    // log is compacted.
    let state = window
        .doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let outside = Replica::from_state(3, &state);
    let update = outside.type_text(" and an outside edit");
    let seq = {
        let mut conn = raw(&f);
        let tx = conn.transaction().unwrap();
        let seq = update_log::append_local_update_in(&tx, &note, &update, 5).unwrap();
        tx.commit().unwrap();
        seq
    };
    f.editor.compact(&note).unwrap().expect("a fold");
    assert_eq!(local_rows(&f, &note), 0, "the outside row was folded");
    f.editor.bodies_written(&[BodyWrite {
        doc_id: note.clone(),
        origin: Origin::External,
        rows: vec![LogRow::Local(seq)],
        purged: false,
    }]);

    assert_eq!(heard.lock().unwrap().len(), 1, "the window heard the edit");
    let after = Replica::from_state(4, &f.editor.open(&note, "main").unwrap().state);
    assert!(
        after.text().ends_with(" and an outside edit"),
        "{}",
        after.text()
    );
}

/// The same for a server row a pushed snapshot pruned before its observer ran.
#[test]
fn a_server_row_pruned_before_its_writer_was_heard_reaches_the_open_document_from_the_snapshot() {
    let f = fixture();
    let note = f.note();
    let opened = f.editor.open(&note, "main").unwrap().state;
    let heard: Arc<Mutex<usize>> = Arc::default();
    let sink = Arc::clone(&heard);
    f.editor.subscribe(&note, move |notice| {
        if let Notice::Update(..) = notice {
            *sink.lock().unwrap() += 1;
        }
    });
    let peer = Replica::from_state(5, &opened);
    let update = peer.type_text("merged from the server");
    {
        let conn = raw(&f);
        update_log::append_server_update(&conn, &note, 7, &update, 5).unwrap();
        update_log::put_server_snapshot(&conn, &note, &peer.full_state(), 7, None, 6).unwrap();
        conn.execute(
            "DELETE FROM yjs_updates WHERE doc_id = ?1 AND seq <= 7",
            params![note],
        )
        .unwrap();
    }
    f.editor.bodies_written(&[BodyWrite {
        doc_id: note.clone(),
        origin: Origin::Remote,
        rows: vec![LogRow::Server(7)],
        purged: false,
    }]);

    assert_eq!(*heard.lock().unwrap(), 1);
    let after = Replica::from_state(4, &f.editor.open(&note, "main").unwrap().state);
    assert_eq!(after.text(), "merged from the server");
}

/// The fold changes how the log stores the body, not the body: a note whose
/// file was written with every edit is not behind its body after it.
#[test]
fn a_fold_leaves_a_written_file_current() {
    let f = fixture();
    let note = f.note();
    f.file(&note, "a-note.md");
    let window = Rewriter::from_state(1, &f.editor.open(&note, "main").unwrap().state);
    for n in 0..40 {
        let update = window.rewrite(&kib(n));
        f.editor.apply_update(&note, &update, "main").unwrap();
    }
    let conn = raw(&f);
    // The write-back wrote the file with the newest edit.
    conn.execute(
        "UPDATE note_files SET content_hash = 'h', indexed_at =
           (SELECT MAX(created_at) FROM yjs_updates WHERE doc_id = 'local.' || ?1)
         WHERE note_id = ?1",
        params![note],
    )
    .unwrap();
    assert!(!note_files::behind_body(&conn, &note).unwrap());

    f.editor.compact(&note).unwrap().expect("a fold");

    assert!(!note_files::behind_body(&conn, &note).unwrap());
}

/// A note edited a little each launch: the log the earlier launches left
/// counts toward the next compaction.
#[test]
fn a_log_grown_a_little_in_each_of_several_launches_is_due() {
    let mut f = fixture();
    let note = f.note();
    let mut n = 0;
    for launch in 0..3 {
        let window = Rewriter::from_state(1, &f.editor.open(&note, "main").unwrap().state);
        for _ in 0..200 {
            let update = window.rewrite(&kib(n));
            f.editor.apply_update(&note, &update, "main").unwrap();
            n += 1;
        }
        if launch < 2 {
            assert!(
                !f.editor.compaction_due().contains(&note),
                "two launches' edits stay below the threshold"
            );
        }
        f = f.relaunch();
    }
    f.editor.open(&note, "main").unwrap();

    assert_eq!(f.editor.compaction_due(), vec![note.clone()]);
    f.editor.compact(&note).unwrap().expect("a fold");
    assert_eq!(body_after_relaunch(f, &note), kib(n - 1));
}

/// Remote bytes cannot shrink by a local fold, so they do not count.
#[test]
fn bytes_merged_from_the_server_do_not_make_a_document_due() {
    let f = fixture();
    let note = f.note();
    let opened = f.editor.open(&note, "main").unwrap().state;
    let peer = Rewriter::from_state(6, &opened);
    let conn = raw(&f);
    for n in 0..600 {
        let update = peer.rewrite(&kib(n));
        let seq = i64::try_from(n).unwrap() + 1;
        update_log::append_server_update(&conn, &note, seq, &update, 5).unwrap();
        f.editor.bodies_written(&[BodyWrite {
            doc_id: note.clone(),
            origin: Origin::Remote,
            rows: vec![LogRow::Server(seq)],
            purged: false,
        }]);
    }
    assert!(f.editor.compaction_due().is_empty());
}
