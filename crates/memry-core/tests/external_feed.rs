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
        self.count("SELECT COUNT(*) FROM yjs_updates WHERE doc_id = ?1", id)
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
    assert!(body.contains("second text") && !body.contains("first text"), "{body}");
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
    assert_eq!((f.updates(&id), f.queued_updates(&id)), (0, 0), "no second copy to push (#2536)");
    assert!(f.owes_file_body(&id));
    assert_eq!(f.vault.note_files().owed_file_bodies().unwrap(), [id.clone()]);

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
            (outcome, f.updates(&id), f.queued_updates(&id), f.owes_file_body(&id))
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
    assert!(f.owes_file_body(&id), "the marker is untouched by the failed feed");
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
