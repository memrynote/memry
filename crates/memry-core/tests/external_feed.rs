//! An edit made outside the app reaches the note's document, and never doubles
//! the text of a note whose server body has not arrived (Step 12e-1).
//!
//! Real `data.db`, the real replay of the durable update log, the real converter
//! and the real outbox. A feed is observed through what it stores: the update
//! rows, the outbox rows, the markers, and the body a replay of the log renders.

#![cfg(feature = "markdown")]

mod http_fakes;

use std::sync::Arc;

use http_fakes::FakeSecureStore;
use memry_core::api::external_feed::ExternalFeed;
use memry_core::api::notes_write::NotesWriter;
use memry_core::api::vault::Vault;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{BODY_FRAGMENT, DocumentRegistry, update_log};
use memry_core::crypto::sodium;
use memry_core::domain::external_feed::{FeedInput, FeedOutcome};
use memry_core::markdown::convert::NoEmbeds;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use rusqlite::params;

struct Fixture {
    dir: std::path::PathBuf,
    vault: Vault,
    writer: Arc<NotesWriter>,
    feed: ExternalFeed,
    converter: Converter,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn fixture() -> Fixture {
    let dir = tempfile::Builder::new()
        .prefix("memry-feed-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    let vault = Vault::open("vault-1".to_owned(), dir.display().to_string()).expect("open");
    let (_public, secret) = sodium::sign_seed_keypair(&[7u8; 32]).expect("a keypair");
    let store = FakeSecureStore::new();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");
    let writer = vault.notes_writer(store.clone()).expect("a writer");
    let feed = vault.external_feed(store).expect("a feed");
    Fixture {
        dir,
        vault,
        writer,
        feed,
        converter: Converter::new(CalloutTypes::new(Vec::new())),
    }
}

impl Fixture {
    fn note(&self) -> String {
        self.writer.create("A note".into(), None).expect("create")
    }

    fn feed(&self, note_id: &str, markdown: &str) -> FeedOutcome {
        self.feed
            .feed(
                &self.converter,
                FeedInput {
                    note_id,
                    markdown,
                    note_path: Some("a.md"),
                    writing: None,
                },
            )
            .expect("the feed itself does not fail")
    }

    fn seed(&self, note_id: &str, markdown: &str) -> FeedOutcome {
        self.feed
            .seed_body_if_empty(
                &self.converter,
                FeedInput {
                    note_id,
                    markdown,
                    note_path: Some("a.md"),
                    writing: None,
                },
            )
            .expect("the seed itself does not fail")
    }

    fn count(&self, sql: &str, id: &str) -> i64 {
        self.vault
            .db_handle()
            .call_blocking(|conn| {
                Ok(conn
                    .query_row(sql, params![id], |row| row.get(0))
                    .expect("count"))
            })
            .expect("count")
    }

    fn updates(&self, id: &str) -> i64 {
        self.count(
            "SELECT COUNT(*) FROM yjs_updates WHERE doc_id LIKE '%' || ?1",
            id,
        )
    }

    fn queued_updates(&self, id: &str) -> i64 {
        self.count(
            "SELECT COUNT(*) FROM outbox WHERE item_id = ?1 AND item_type = 'note' AND op <> 'upsert'",
            id,
        )
    }

    fn owes_file_body(&self, id: &str) -> bool {
        self.vault.note_files().owes_file_body(id).expect("marker")
    }

    fn owe_body_pull(&self, id: &str) {
        self.vault
            .db_handle()
            .call_blocking(|conn| {
                conn.execute(
                    "INSERT INTO meta (key, value) VALUES (?1, '0:0')",
                    params![format!("sync.body_owed:{id}")],
                )
                .expect("owe");
                Ok(())
            })
            .expect("owe");
    }

    fn settle_body_pull(&self, id: &str) {
        self.vault
            .db_handle()
            .call_blocking(|conn| {
                conn.execute(
                    "DELETE FROM meta WHERE key = ?1",
                    params![format!("sync.body_owed:{id}")],
                )
                .expect("settle");
                Ok(())
            })
            .expect("settle");
    }

    /// The body a replay of the durable log renders.
    fn body(&self, id: &str) -> String {
        let sink: UpdateSink = Arc::new(|_, _| {});
        let document = DocumentRegistry::new("reader", sink)
            .get_or_open(id)
            .expect("open");
        self.vault
            .db_handle()
            .call_blocking(|conn| {
                for blob in update_log::load_plan(conn, id).expect("plan").blobs() {
                    document.apply_durable_update(blob).expect("apply");
                }
                Ok(())
            })
            .expect("replay");
        self.converter
            .doc_to_canonical_markdown(&document, BODY_FRAGMENT)
            .unwrap_or_default()
    }
}

#[test]
fn an_outside_edit_replaces_the_body_and_queues_exactly_its_update() {
    let f = fixture();
    let id = f.note();
    assert_eq!(f.feed(&id, "first text"), FeedOutcome::Fed);
    assert!(f.body(&id).contains("first text"), "{}", f.body(&id));
    assert_eq!((f.updates(&id), f.queued_updates(&id)), (1, 1));

    assert_eq!(f.feed(&id, "second text"), FeedOutcome::Fed);
    let body = f.body(&id);
    assert!(
        body.contains("second text") && !body.contains("first text"),
        "{body}"
    );
    assert_eq!(
        (f.updates(&id), f.queued_updates(&id)),
        (2, 2),
        "each update has its outbox row"
    );
}

#[test]
fn a_note_whose_server_body_has_not_arrived_owes_its_file_and_nothing_is_written() {
    let f = fixture();
    let id = f.note();
    f.owe_body_pull(&id);
    assert_eq!(f.feed(&id, "an edit made outside"), FeedOutcome::Owed);
    assert_eq!(
        (f.updates(&id), f.queued_updates(&id)),
        (0, 0),
        "no second copy to push (#2536)"
    );
    assert!(f.owes_file_body(&id));
    assert_eq!(
        f.vault.note_files().owed_file_bodies().unwrap(),
        vec![id.clone()]
    );

    f.settle_body_pull(&id);
    assert_eq!(f.feed(&id, "an edit made outside"), FeedOutcome::Fed);
    assert!(!f.owes_file_body(&id), "the document took the file");
    assert!(f.body(&id).contains("an edit made outside"));
}

#[test]
fn a_large_file_is_never_fed_and_owes_nothing() {
    let f = fixture();
    let id = f.note();
    let big = "word ".repeat(300_000);
    assert_eq!(f.feed(&id, &big), FeedOutcome::LargeFile);
    assert_eq!((f.updates(&id), f.queued_updates(&id)), (0, 0));
    assert!(!f.owes_file_body(&id));
    f.owe_body_pull(&id);
    assert_eq!(f.feed(&id, &big), FeedOutcome::LargeFile, "owed or not");
    assert!(!f.owes_file_body(&id));
}

#[test]
fn a_note_that_does_not_live_is_not_fed() {
    let f = fixture();
    assert_eq!(f.feed("never-existed", "text"), FeedOutcome::NoNote);
    let id = f.note();
    f.writer.delete(id.clone()).expect("delete");
    assert_eq!(f.feed(&id, "text"), FeedOutcome::NoNote);
    assert_eq!(f.updates(&id), 0);
}

#[test]
fn markdown_nested_past_the_stack_is_refused_without_a_write() {
    let f = fixture();
    let id = f.note();
    let outcome = std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(move || {
            let nested = format!("{}deep", "> ".repeat(20_000));
            let outcome = f.feed(&id, &nested);
            (
                outcome,
                f.updates(&id),
                f.queued_updates(&id),
                f.owes_file_body(&id),
            )
        })
        .expect("spawn")
        .join()
        .expect("no stack overflow");
    assert_ne!(outcome.0, FeedOutcome::Fed, "{outcome:?}");
    assert_eq!((outcome.1, outcome.2, outcome.3), (0, 0, false));
}

#[test]
fn the_update_and_its_outbox_row_commit_together_or_not_at_all() {
    let f = fixture();
    let id = f.note();
    f.owe_body_pull(&id);
    f.feed(&id, "owed first");
    f.settle_body_pull(&id);
    f.vault
        .db_handle()
        .call_blocking(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER refuse_outbox BEFORE INSERT ON outbox
                 BEGIN SELECT RAISE(ABORT, 'outbox refused'); END;",
            )
            .expect("trigger");
            Ok(())
        })
        .expect("trigger");
    let result = f.feed.feed(
        &f.converter,
        FeedInput {
            note_id: &id,
            markdown: "text that must not half land",
            note_path: None,
            writing: None,
        },
    );
    assert!(result.is_err(), "{result:?}");
    assert_eq!(f.updates(&id), 0, "no update row without its outbox row");
    assert!(
        f.owes_file_body(&id),
        "the marker is untouched by the failed feed"
    );
}

#[test]
fn a_marker_goes_with_the_files_row_of_its_note() {
    let f = fixture();
    let id = f.note();
    f.owe_body_pull(&id);
    f.feed(&id, "text");
    assert!(f.owes_file_body(&id));
    f.vault.note_files().remove(&id).expect("remove");
    assert!(!f.owes_file_body(&id));
}

#[test]
fn a_seed_fills_an_empty_body_and_never_replaces_one() {
    let f = fixture();
    let id = f.note();
    assert_eq!(f.seed(&id, "the file's text"), FeedOutcome::Fed);
    assert!(f.body(&id).contains("the file's text"));
    assert_eq!((f.updates(&id), f.queued_updates(&id)), (1, 1));

    // A crash replay of the same adoption, or a file edited since: the body stays.
    assert_eq!(f.seed(&id, "a different text"), FeedOutcome::BodyPresent);
    let body = f.body(&id);
    assert!(
        body.contains("the file's text") && !body.contains("a different text"),
        "{body}"
    );
    assert_eq!((f.updates(&id), f.queued_updates(&id)), (1, 1));
}

#[test]
fn a_seed_of_an_owed_note_writes_nothing_and_owes_the_file() {
    let f = fixture();
    let id = f.note();
    f.owe_body_pull(&id);
    assert_eq!(f.seed(&id, "text"), FeedOutcome::Owed);
    assert_eq!((f.updates(&id), f.queued_updates(&id)), (0, 0));
    assert!(f.owes_file_body(&id));
}

#[test]
fn a_seed_of_a_large_file_is_refused_like_a_feed() {
    let f = fixture();
    let id = f.note();
    assert_eq!(
        f.seed(&id, &"word ".repeat(300_000)),
        FeedOutcome::LargeFile
    );
    assert_eq!(f.updates(&id), 0);
}

// ---------------------------------------------------------------------------
// The feed never removes what the file cannot hold, and never removes a body
// without keeping it: a block a newer build wrote stays, an unchanged file
// writes nothing, and a replaced body is kept as a version first.

/// A body another device authored from `markdown`, plus whatever `extend` adds
/// to it raw, stored as the server sent it.
fn server_body(
    f: &Fixture,
    id: &str,
    markdown: &str,
    extend: impl FnOnce(&mut yrs::TransactionMut),
) {
    let authored: Arc<std::sync::Mutex<Vec<Vec<u8>>>> = Arc::default();
    let sink: UpdateSink = {
        let authored = Arc::clone(&authored);
        Arc::new(move |_, bytes: &[u8]| authored.lock().unwrap().push(bytes.to_vec()))
    };
    let peer = DocumentRegistry::new("peer-device", sink)
        .get_or_open(id)
        .expect("open");
    assert!(
        f.converter
            .seed_body(&peer, markdown, None, None, &NoEmbeds)
    );
    peer.write(|txn| extend(txn)).expect("extend");
    let updates = authored.lock().unwrap().clone();
    f.vault
        .db_handle()
        .call_blocking(|conn| {
            for (seq, update) in updates.iter().enumerate() {
                update_log::append_server_update(conn, id, seq as i64 + 1, update, 1)
                    .expect("store");
            }
            Ok(())
        })
        .expect("store");
}

/// Appends `blockContainer > <tag> > text` to the body's block group.
fn raw_block(txn: &mut yrs::TransactionMut, tag: &str, text: &str) {
    use yrs::{XmlElementPrelim, XmlFragment as _, XmlOut, XmlTextPrelim};
    let fragment = yrs::WriteTxn::get_or_insert_xml_fragment(txn, BODY_FRAGMENT);
    let Some(XmlOut::Element(group)) = fragment.get(txn, 0) else {
        panic!("a seeded body starts with its block group");
    };
    let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
    let block = container.push_back(txn, XmlElementPrelim::empty(tag));
    block.push_back(txn, XmlTextPrelim::new(text));
}

fn local_updates(f: &Fixture, id: &str) -> i64 {
    f.count(
        "SELECT COUNT(*) FROM yjs_updates WHERE doc_id = 'local.' || ?1",
        id,
    )
}

fn versions(f: &Fixture, id: &str) -> Vec<(String, String)> {
    f.vault
        .db_handle()
        .call_blocking(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT content, reason FROM note_snapshots WHERE note_id = ?1
                     ORDER BY created_at, rowid",
                )
                .expect("prepare");
            Ok(statement
                .query_map(params![id], |row| Ok((row.get(0)?, row.get(1)?)))
                .expect("query")
                .collect::<Result<Vec<_>, _>>()
                .expect("rows"))
        })
        .expect("versions")
}

#[test]
fn a_body_holding_a_block_this_build_cannot_represent_is_never_replaced() {
    let f = fixture();
    let id = f.note();
    server_body(&f, &id, "known", |txn| {
        raw_block(txn, "futureBlock", "written by a newer build");
    });
    assert_eq!(f.feed(&id, "the file's text"), FeedOutcome::Refused);
    assert_eq!((local_updates(&f, &id), f.queued_updates(&id)), (0, 0));
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new("reader", sink)
        .get_or_open(&id)
        .expect("open");
    f.vault
        .db_handle()
        .call_blocking(|conn| {
            for blob in update_log::load_plan(conn, &id).expect("plan").blobs() {
                document.apply_durable_update(blob).expect("apply");
            }
            Ok(())
        })
        .expect("replay");
    assert_eq!(
        f.converter
            .find_unrepresentable_nodes(&document, BODY_FRAGMENT),
        vec!["futureBlock".to_owned()],
        "the newer build's block is still there"
    );
}

#[test]
fn a_file_that_already_matches_the_body_writes_nothing() {
    let f = fixture();
    let id = f.note();
    assert_eq!(f.feed(&id, "the same text"), FeedOutcome::Fed);
    assert_eq!(f.feed(&id, "the same text"), FeedOutcome::Unchanged);
    assert_eq!(
        (local_updates(&f, &id), f.queued_updates(&id)),
        (1, 1),
        "a peer that merged the first feed gets no second copy"
    );
}

#[test]
fn a_replaced_body_is_kept_as_a_version_once() {
    let f = fixture();
    let id = f.note();
    assert_eq!(f.feed(&id, "first text"), FeedOutcome::Fed);
    assert!(
        versions(&f, &id).is_empty(),
        "an empty body is nothing to keep"
    );
    assert_eq!(f.feed(&id, "second text"), FeedOutcome::Fed);
    assert_eq!(f.feed(&id, "first text"), FeedOutcome::Fed);
    assert_eq!(f.feed(&id, "second text"), FeedOutcome::Fed);
    let kept = versions(&f, &id);
    assert_eq!(kept.len(), 2, "one version per distinct body: {kept:?}");
    assert!(kept[0].0.contains("first text") && kept[1].0.contains("second text"));
    assert!(kept.iter().all(|(_, reason)| reason == "significant"));
}

#[test]
fn a_fed_body_merged_with_the_server_body_holds_the_file_text_once() {
    let f = fixture();
    let id = f.note();
    server_body(&f, &id, "from the server", |_| {});
    assert_eq!(
        f.feed(&id, "from the server\n\nand a line added in another editor"),
        FeedOutcome::Fed
    );
    // A peer that holds the server body and then receives the fed update.
    let body = f.body(&id);
    assert_eq!(body.matches("from the server").count(), 1, "{body:?}");
    assert!(
        body.contains("and a line added in another editor"),
        "{body:?}"
    );
}

#[test]
fn crlf_line_ends_feed_like_lf_ones() {
    let f = fixture();
    let id = f.note();
    assert_eq!(
        f.feed(&id, "line one\r\n\r\nline two\r\n"),
        FeedOutcome::Fed
    );
    let body = f.body(&id);
    assert!(
        body.contains("line one") && body.contains("line two") && !body.contains('\r'),
        "{body:?}"
    );
    assert_eq!(
        f.feed(&id, "line one\r\n\r\nline two\r\n"),
        FeedOutcome::Unchanged,
        "the same text with CRLF line ends is the same body"
    );
}

#[test]
fn a_leading_byte_order_mark_is_not_part_of_the_body() {
    let f = fixture();
    let id = f.note();
    assert_eq!(f.feed(&id, "\u{feff}text after a BOM"), FeedOutcome::Fed);
    assert!(!f.body(&id).contains('\u{feff}'), "{:?}", f.body(&id));
    assert_eq!(f.feed(&id, "text after a BOM"), FeedOutcome::Unchanged);
}
