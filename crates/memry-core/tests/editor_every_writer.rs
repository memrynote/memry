//! Every writer of a body log reaches the editor host's open documents on a real
//! `data.db` (Step 14c-1): a note or journal command, an outside edit fed from
//! the file, a server merge, a delete's purge. Each reaches the windows after
//! its commit, with where it came from; a write that rolled back reaches none.

#![cfg(feature = "markdown")]

use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;

use memry_core::api::editor::{EditorError, Notice, Origin};
use memry_core::api::errors::StorageError;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::crdt::update_log;
use memry_core::domain::external_feed::{AppRead, FeedInput, FeedOutcome};
use memry_core::markdown::convert::api::Converter;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::sync::body_pull::{BodyPull, CrdtCipher, PackedUpdate};
use memry_core::sync::pull::{PullLoop, RecordCipher};
use serde_json::json;

use crate::editor_support::{Fixture, Replica, fixture};
use crate::http_fakes::{FakeTransport, response};

const DATE: &str = "2026-04-16";

#[derive(Debug, Clone, PartialEq, Eq)]
enum Heard {
    Update(Vec<u8>, Origin),
    Purged,
}

fn listen(f: &Fixture, id: &str) -> Arc<Mutex<Vec<Heard>>> {
    let heard: Arc<Mutex<Vec<Heard>>> = Arc::default();
    let sink = Arc::clone(&heard);
    f.editor.subscribe(id, move |notice| {
        sink.lock().unwrap().push(match notice {
            Notice::Update(bytes, origin) => Heard::Update(bytes.to_vec(), origin.clone()),
            Notice::Purged => Heard::Purged,
        });
    });
    heard
}

/// The one update `heard` holds, with its origin.
fn one_update(heard: &Arc<Mutex<Vec<Heard>>>) -> (Vec<u8>, Origin) {
    match heard.lock().unwrap().as_slice() {
        [Heard::Update(bytes, origin)] => (bytes.clone(), origin.clone()),
        other => panic!("expected one update, heard {other:?}"),
    }
}

fn paragraph(text: &str, id: &str) -> BlockEdit {
    BlockEdit::InsertParagraph {
        after_block_id: None,
        text: text.to_owned(),
        new_block_id: id.to_owned(),
    }
}

/// Writes `text` into the day through the journal command; returns the day's id.
fn write_day(f: &Fixture, text: &str, block: &str) -> String {
    f.journal
        .edit_day(DATE.to_owned(), paragraph(text, block))
        .expect("the day takes the edit");
    f.journal
        .entry_id(DATE.to_owned())
        .expect("read")
        .expect("the day is live")
}

/// The file's text fed into the note's body, or seeded into an empty one.
fn feed(f: &Fixture, note: &str, markdown: &str, seed: bool) -> FeedOutcome {
    let feed = f.vault.external_feed(f.store.clone()).expect("a feed");
    let converter = Converter::new(Default::default());
    let input = FeedInput {
        note_id: note,
        markdown,
        note_path: None,
        writing: None,
        frontmatter: None,
        embeds: None,
    };
    if seed {
        feed.seed_body_if_empty(&converter, input)
    } else {
        feed.feed(&converter, input)
    }
    .expect("the feed runs")
}

#[test]
fn a_note_command_reaches_the_open_document_and_its_windows_as_a_system_write() {
    let f = fixture();
    let note = f.note();
    let main = Replica::from_state(1, &f.editor.open(&note, "main").expect("open").state);
    let heard = listen(&f, &note);

    assert!(
        f.writer
            .edit_block(note.clone(), paragraph("from a command", "blk1"))
            .expect("the command")
    );

    let (update, origin) = one_update(&heard);
    assert_eq!(origin, Origin::System);
    main.apply(&update);
    assert!(main.text().contains("from a command"));
    let side = Replica::from_state(2, &f.editor.open(&note, "side").expect("side").state);
    assert!(
        side.text().contains("from a command"),
        "the resident document took it"
    );
}

#[test]
fn a_journal_command_on_an_open_day_reaches_its_windows() {
    let f = fixture();
    let day = write_day(&f, "morning", "blk1");
    let main = Replica::from_state(1, &f.editor.open(&day, "main").expect("open").state);
    let heard = listen(&f, &day);

    write_day(&f, "evening", "blk2");

    let (update, origin) = one_update(&heard);
    assert_eq!(origin, Origin::System);
    main.apply(&update);
    assert!(main.text().contains("morning") && main.text().contains("evening"));
}

#[test]
fn an_outside_edit_fed_from_the_file_reaches_the_windows_as_external() {
    let f = fixture();
    let note = f.note();
    let main = Replica::from_state(1, &f.editor.open(&note, "main").expect("open").state);
    let heard = listen(&f, &note);

    assert_eq!(
        feed(&f, &note, "edited in another app", false),
        FeedOutcome::Fed
    );

    let (update, origin) = one_update(&heard);
    assert_eq!(origin, Origin::External);
    main.apply(&update);
    assert!(main.text().contains("edited in another app"));
}

/// The app's own edit of a note's file (a save, a version restore, a tag rename) is no outside
/// edit: its windows hear a system write, so typing still on its way to the host does not win
/// over it and no page says an outside change was replaced.
#[test]
fn an_app_edit_of_the_file_reaches_the_windows_as_a_system_write() {
    let f = fixture();
    let note = f.note();
    assert_eq!(feed(&f, &note, "the file before", false), FeedOutcome::Fed);
    let main = Replica::from_state(1, &f.editor.open(&note, "main").expect("open").state);
    let heard = listen(&f, &note);

    let read = AppRead {
        file_body: "the file before",
        compared_at: None,
    };
    let input = FeedInput {
        note_id: &note,
        markdown: "a version restored",
        note_path: None,
        writing: None,
        frontmatter: None,
        embeds: None,
    };
    let fed = f
        .vault
        .external_feed(f.store.clone())
        .expect("a feed")
        .feed_app_edit(&Converter::new(Default::default()), input, read)
        .expect("the feed runs");
    assert_eq!(fed, FeedOutcome::Fed);

    let (update, origin) = one_update(&heard);
    assert_eq!(origin, Origin::System);
    main.apply(&update);
    assert!(main.text().contains("a version restored"));
}

#[test]
fn a_body_that_needs_a_seed_takes_the_files_text_and_the_open_windows_hear_it() {
    let f = fixture();
    let note = f.note();
    let opened = f.editor.open(&note, "main").expect("open");
    assert!(opened.needs_seed);
    let main = Replica::from_state(1, &opened.state);
    let heard = listen(&f, &note);

    assert_eq!(feed(&f, &note, "the file's text", true), FeedOutcome::Fed);

    let (update, origin) = one_update(&heard);
    assert_eq!(origin, Origin::External);
    main.apply(&update);
    assert!(main.text().contains("the file's text"));
    assert!(!f.editor.open(&note, "side").expect("side").needs_seed);
}

#[test]
fn a_write_that_rolls_back_reaches_no_window() {
    let f = fixture();
    let note = f.note();
    f.editor.open(&note, "main").expect("open");
    let heard = listen(&f, &note);
    let lost = Replica::new(9).type_text("rolled back");

    f.vault
        .db_handle()
        .call_blocking(|conn| {
            let tx = conn.unchecked_transaction().expect("begin");
            update_log::append_local_update_in(&tx, &note, &lost, 1).expect("append");
            // Dropped without a commit: rolled back.
            Ok::<_, StorageError>(())
        })
        .expect("the closure");

    assert!(heard.lock().unwrap().is_empty());
    let side = Replica::from_state(2, &f.editor.open(&note, "side").expect("side").state);
    assert_eq!(side.text(), "");
}

pub(crate) fn http(transport: Arc<FakeTransport>) -> Arc<HttpClient> {
    Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("desktop", "1.2.3").expect("an identity"),
    ))
}

/// A delete that opens no payload: the cipher is never asked (§5.12).
struct NeverOpens;

impl RecordCipher for NeverOpens {
    fn open(&self, _envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Err(EnvelopeError::SignatureInvalid)
    }
}

/// The day's delete, pulled from the server through the real pull loop: the
/// tombstone purges the day's body log (chapter 07 §7.15). An untyped delete
/// (§5.12.1) keeps no copy of the body, so it purges a log that does not replay.
async fn pull_the_delete(f: &Fixture, day: &str, typed: bool) {
    let changes = if typed {
        json!({ "items": [{"id": day, "type": "journal"}], "deleted": [], "hasMore": false, "nextCursor": "77" })
    } else {
        json!({ "items": [], "deleted": [day], "hasMore": false, "nextCursor": "77" })
    };
    let item = json!({
        "id": day, "type": "journal", "operation": "update", "clientUpdatedAt": 1_700_000_500_000i64,
        "encryptedKey": "AAAA", "keyNonce": "AAAA", "encryptedData": "AAAA", "dataNonce": "AAAA",
        "signature": "AAAA", "signerDeviceId": "device-desktop", "deletedAt": 1_700_000_500_000i64,
    });
    let items = if typed { json!([item]) } else { json!([]) };
    let transport = FakeTransport::new(vec![
        response(200, &changes.to_string()),
        response(200, &json!({ "items": items }).to_string()),
    ]);
    PullLoop::new(
        http(transport),
        f.vault.db_handle(),
        Declaration::subscribed(),
        Arc::new(NeverOpens),
    )
    .with_clock_device("device-core")
    .pull_page()
    .await
    .expect("the delete applies");
}

#[tokio::test]
async fn a_journal_day_deleted_and_written_again_while_open_hands_the_windows_the_new_document() {
    let f = fixture();
    let day = write_day(&f, "old day", "blk1");
    let main = Replica::from_state(1, &f.editor.open(&day, "main").expect("open").state);
    assert!(main.text().contains("old day"));
    let heard = listen(&f, &day);

    pull_the_delete(&f, &day, true).await;

    assert_eq!(
        *heard.lock().unwrap(),
        vec![Heard::Purged],
        "the windows drop the deleted document"
    );
    assert_eq!(write_day(&f, "new day", "blk2"), day, "the same id");
    assert_eq!(
        *heard.lock().unwrap(),
        vec![Heard::Purged],
        "no update of the new day reaches windows that hold the deleted one"
    );
    let (rows, queued) = (f.local_blobs(&day).len(), f.queued(&day));
    assert!(
        matches!(
            f.editor.apply_update(&day, &main.full_state(), "main"),
            Err(EditorError::Purged { .. })
        ),
        "the window's copy of the deleted day is refused until it reopens"
    );
    assert_eq!((f.local_blobs(&day).len(), f.queued(&day)), (rows, queued));
    let reopened = Replica::from_state(2, &f.editor.open(&day, "main").expect("reopen").state);
    assert!(reopened.text().contains("new day"));
    assert!(
        !reopened.text().contains("old day"),
        "the purged document is gone: {}",
        reopened.text()
    );
    assert!(
        f.editor
            .apply_update(&day, &reopened.type_text(" again"), "main")
            .is_ok(),
        "a reopened window edits again"
    );
}

#[tokio::test]
async fn a_day_whose_log_did_not_replay_opens_once_a_delete_purged_it_and_it_was_written_again() {
    let f = fixture();
    let day = write_day(&f, "old day", "blk1");
    f.vault
        .db_handle()
        .call_blocking(|conn| {
            update_log::append_server_update(conn, &day, 1, &[0xff; 4], 1).map_err(|error| {
                StorageError::Failed {
                    what: error.to_string(),
                }
            })
        })
        .expect("bytes no build decodes");
    assert!(matches!(
        f.editor.open(&day, "main"),
        Err(EditorError::Unreadable { .. })
    ));

    pull_the_delete(&f, &day, false).await;
    write_day(&f, "new day", "blk2");

    let reopened = Replica::from_state(1, &f.editor.open(&day, "main").expect("reopen").state);
    assert!(reopened.text().contains("new day"));
}

/// The server's body, opened as stored: the envelope is chapter 04's concern.
pub(crate) struct PassThrough;

impl CrdtCipher for PassThrough {
    fn open(&self, update: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError> {
        Ok(update.packed.to_vec())
    }
}

#[tokio::test]
async fn a_pulled_baseline_snapshot_reaches_the_open_document_as_remote() {
    let f = fixture();
    let note = f.note();
    let main = Replica::from_state(1, &f.editor.open(&note, "main").expect("open").state);
    let heard = listen(&f, &note);
    let peer = Replica::new(9);
    peer.type_text("a peer's snapshot");
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

    let (update, origin) = one_update(&heard);
    assert_eq!(origin, Origin::Remote);
    main.apply(&update);
    assert!(main.text().contains("a peer's snapshot"));
}

#[test]
fn a_committed_row_the_open_document_cannot_take_unloads_it() {
    let f = fixture();
    let note = f.note();
    f.editor.open(&note, "main").expect("open");

    f.vault
        .db_handle()
        .call_blocking(|conn| {
            update_log::append_server_update(conn, &note, 1, &[0xff; 4], 1).map_err(|error| {
                StorageError::Failed {
                    what: error.to_string(),
                }
            })
        })
        .expect("bytes no build decodes");

    assert!(
        matches!(
            f.editor.open(&note, "side"),
            Err(EditorError::Unreadable { .. })
        ),
        "the next opener replays the committed log, not the copy that fell behind it"
    );
}

#[test]
fn a_window_edit_that_waited_on_a_purge_is_refused_and_writes_nothing() {
    let f = fixture();
    let day = write_day(&f, "old day", "blk1");
    let main = Replica::from_state(1, &f.editor.open(&day, "main").expect("open").state);
    main.type_text(" typed");
    let queued = f.queued(&day);
    let (holding, held) = mpsc::channel();
    let (db, id) = (f.vault.db_handle(), day.clone());
    let purge = std::thread::spawn(move || {
        db.call_blocking(|conn| {
            let tx = conn.unchecked_transaction().expect("begin");
            update_log::purge_in(&tx, &id).expect("purge");
            tx.commit().expect("commit");
            holding.send(()).expect("signal");
            // The writer stays held while the window's edit waits for it, so
            // the edit gets it before the purge's observer fences the holders.
            std::thread::sleep(Duration::from_millis(300));
            Ok::<_, StorageError>(())
        })
        .expect("the purge");
    });
    held.recv().expect("the purge holds the writer");

    let refused = f.editor.apply_update(&day, &main.full_state(), "main");
    purge.join().expect("the purge thread");

    assert!(
        matches!(refused, Err(EditorError::Purged { .. })),
        "{refused:?}"
    );
    assert!(
        f.local_blobs(&day).is_empty(),
        "the deleted body is not stored"
    );
    assert_eq!(f.queued(&day), queued, "nor queued for the other devices");
}
