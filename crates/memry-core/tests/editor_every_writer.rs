//! Every writer of a body log reaches the editor host's open documents on a real
//! `data.db` (Step 14c-1): a note or journal command, an outside edit fed from
//! the file, a server merge, a delete's purge. Each reaches the windows after
//! its commit, with where it came from; a write that rolled back reaches none.

#![cfg(feature = "markdown")]

use std::sync::{Arc, Mutex};

use memry_core::api::editor::{EditorError, Notice, Origin};
use memry_core::api::errors::StorageError;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::crdt::update_log;
use memry_core::domain::external_feed::{FeedInput, FeedOutcome};
use memry_core::markdown::convert::api::Converter;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
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
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("desktop", "1.2.3").expect("an identity"),
    );
    PullLoop::new(
        Arc::new(http),
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
    let reopened = Replica::from_state(2, &f.editor.open(&day, "main").expect("reopen").state);
    assert!(reopened.text().contains("new day"));
    assert!(
        !reopened.text().contains("old day"),
        "the purged document is gone: {}",
        reopened.text()
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
