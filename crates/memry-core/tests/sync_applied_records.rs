//! The applied-record feed through the real pull (#3534 L2): every observer
//! hears one record per item of a committed page, after the page committed
//! (its cursor included); a failure in the cursor write or in the middle of
//! the page stores and tells no record of it; a tombstone for an item never
//! live here counts as skipped; and the first sync's id fetch, the refused-records refetch and a
//! losing note tombstone reach the observers too.
//!
//! Real `HttpClient`, SQLite and apply; the transport and the record cipher
//! are the only fakes.

#[allow(unused_imports)]
use crate::http_fakes;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use http_fakes::{FakeTransport, response};
use memry_core::domain::sticky_draft::{self, StickyKind};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use memry_core::sync::driver::observer::{AppliedOutcome, AppliedRecord, ApplyObserver, Observers};
use memry_core::sync::pull::{PullLoop, RecordCipher};
use memry_core::sync::store::{self, RECORD_CURSOR_SCOPE};
use serde_json::{Value as Json, json};

const TYPE: &str = "sticky_draft";
const NOW: i64 = 1_776_297_600_000;
const ISO: &str = "2026-09-24T08:00:00.000Z";

fn scratch_db() -> Db {
    let dir = tempfile::Builder::new()
        .prefix("memry-applied-records-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

/// Opens each envelope to the payload of its id.
struct Payloads(BTreeMap<String, String>);

impl RecordCipher for Payloads {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Ok(self.0[&envelope.id].as_bytes().to_vec())
    }
}

fn envelope_of(item_type: &str, id: &str) -> Json {
    json!({
        "id": id, "type": item_type, "operation": "update",
        "encryptedKey": "AAAA", "keyNonce": "AAAA", "encryptedData": "AAAA",
        "dataNonce": "AAAA", "signature": "AAAA", "signerDeviceId": "device-b",
    })
}

fn sticky(id: &str) -> String {
    json!({"content": format!("from {id}"), "kind": "note", "clock": {"device-a": 1, "peer": 1}})
        .to_string()
}

fn changes(refs: &[(&str, &str)], deleted: &[&str], next_cursor: &str) -> String {
    let items: Vec<Json> = refs
        .iter()
        .map(|(item_type, id)| json!({"id": id, "type": item_type}))
        .collect();
    json!({"items": items, "deleted": deleted, "hasMore": false, "nextCursor": next_cursor})
        .to_string()
}

fn pulled(items: Vec<Json>) -> String {
    json!({ "items": items }).to_string()
}

/// What one observer heard: each record with its outcome, whether a reader
/// connection sees the row, and the record cursor a reader sees right then.
type Heard = (String, AppliedOutcome, bool, Option<String>);

/// Reads, from a reader connection, every record it hears.
struct Reader {
    name: &'static str,
    db: Db,
    heard: Mutex<Vec<Heard>>,
    revived: Mutex<Vec<String>>,
}

impl ApplyObserver for Reader {
    fn name(&self) -> &str {
        self.name
    }

    fn records_applied(&self, batch: &[AppliedRecord]) {
        for record in batch {
            let (item_type, item_id) = (record.item_type.clone(), record.item_id.clone());
            let (stored, cursor) = self
                .db
                .read_blocking(move |conn| {
                    let row = sync_items::load(conn, &item_type, &item_id)?;
                    let cursor = store::read_cursor(conn, RECORD_CURSOR_SCOPE)?;
                    Ok((row.is_some_and(|row| row.payload.is_some()), cursor))
                })
                .expect("a reader connection");
            self.heard.lock().unwrap().push((
                record.item_id.clone(),
                record.outcome,
                stored,
                cursor,
            ));
        }
    }

    fn note_revived(&self, note_id: &str) {
        self.revived.lock().unwrap().push(note_id.to_owned());
    }
}

/// A pull over `db` that answers from `script`, with two readers registered.
fn pull_loop(
    db: &Db,
    types: &[&str],
    payloads: BTreeMap<String, String>,
    script: Vec<String>,
) -> (PullLoop, [Arc<Reader>; 2]) {
    let transport = FakeTransport::new(script.iter().map(|body| response(200, body)).collect());
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("desktop", "1.0.0").expect("a valid identity"),
    );
    let observers = Arc::new(Observers::default());
    let readers = ["first", "second"].map(|name| {
        let reader = Arc::new(Reader {
            name,
            db: db.clone(),
            heard: Mutex::default(),
            revived: Mutex::default(),
        });
        observers.register(reader.clone());
        reader
    });
    let pull = PullLoop::new(
        Arc::new(http),
        db.clone(),
        Declaration::declare(types).expect("recognised"),
        Arc::new(Payloads(payloads)),
    )
    .with_observers(observers);
    (pull, readers)
}

/// Nine new drafts and one this device already has, as one page with cursor
/// "10": the ids and the script.
fn ten_drafts(db: &Db) -> (Vec<String>, BTreeMap<String, String>, Vec<String>) {
    let local = db
        .call_blocking(|conn| {
            sticky_draft::upsert(conn, None, "mine", StickyKind::Note, "device-a", NOW)
        })
        .expect("a local draft")
        .id;
    let mut ids: Vec<String> = (0..9).map(|n| format!("sticky-{n}")).collect();
    ids.push(local);
    let payloads = ids.iter().map(|id| (id.clone(), sticky(id))).collect();
    let refs: Vec<(&str, &str)> = ids.iter().map(|id| (TYPE, id.as_str())).collect();
    let script = vec![
        changes(&refs, &[], "10"),
        pulled(ids.iter().map(|id| envelope_of(TYPE, id)).collect()),
    ];
    (ids, payloads, script)
}

fn expected(ids: &[String], cursor: Option<&str>) -> Vec<Heard> {
    ids.iter()
        .enumerate()
        .map(|(at, id)| {
            // The last id is the draft this device already had.
            let outcome = if at == ids.len() - 1 {
                AppliedOutcome::Updated
            } else {
                AppliedOutcome::Created
            };
            (id.clone(), outcome, true, cursor.map(str::to_owned))
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn two_observers_hear_every_record_of_a_page_after_it_commits() {
    let db = scratch_db();
    let (ids, payloads, script) = ten_drafts(&db);
    let (pull, readers) = pull_loop(&db, &[TYPE], payloads, script);

    let report = pull.pull_page().await.expect("the page");
    assert_eq!(report.applied, 10);

    // The cursor is part of the commit: an observer told before it would see
    // none.
    for reader in readers {
        assert_eq!(
            *reader.heard.lock().unwrap(),
            expected(&ids, Some("10")),
            "{}",
            reader.name
        );
    }
}

/// A page's records commit with its cursor or not at all (§5.11, #5231). A
/// failure in the cursor write (here in `land_and_advance`) stores none of
/// them and tells the observers nothing; the re-pull then applies and tells
/// every one.
#[tokio::test(flavor = "multi_thread")]
async fn a_failure_in_the_cursor_write_stores_and_tells_no_record_of_the_page() {
    let db = scratch_db();
    let (ids, payloads, script) = ten_drafts(&db);
    let retry = script.clone();
    db.call_blocking(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER injected_cursor_failure BEFORE INSERT ON sync_cursors
             WHEN NEW.scope = 'record'
             BEGIN SELECT RAISE(ABORT, 'injected cursor failure'); END;",
        )
        .map_err(|error| memry_core::api::errors::StorageError::Failed {
            what: error.to_string(),
        })
    })
    .expect("the injected failure");
    let (pull, readers) = pull_loop(&db, &[TYPE], payloads.clone(), script);

    let error = pull.pull_page().await.expect_err("the cursor write fails");
    assert!(
        error.to_string().contains("injected cursor failure"),
        "{error}"
    );
    for reader in &readers {
        assert!(reader.heard.lock().unwrap().is_empty(), "{}", reader.name);
    }

    db.call_blocking(|conn| {
        conn.execute_batch("DROP TRIGGER injected_cursor_failure")
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })
    })
    .expect("drop the injected failure");
    let (pull, readers) = pull_loop(&db, &[TYPE], payloads, retry);
    pull.pull_page().await.expect("the re-pull");
    for reader in readers {
        assert_eq!(
            *reader.heard.lock().unwrap(),
            expected(&ids, Some("10")),
            "{}",
            reader.name
        );
    }
}

/// A record whose write fails mid-page (a trigger on `sticky-5`'s insert) aborts the page,
/// and the page's records commit with it or not at all (§5.11, #5231): the observers hear
/// nothing, and the re-pull applies and tells every one.
#[tokio::test(flavor = "multi_thread")]
async fn a_record_that_fails_mid_page_stores_and_tells_no_record_of_the_page() {
    let db = scratch_db();
    let (ids, payloads, script) = ten_drafts(&db);
    let retry = script.clone();
    db.call_blocking(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER injected_record_failure BEFORE INSERT ON sync_items
             WHEN NEW.item_id = 'sticky-5'
             BEGIN SELECT RAISE(ABORT, 'injected record failure'); END;",
        )
        .map_err(|error| memry_core::api::errors::StorageError::Failed {
            what: error.to_string(),
        })
    })
    .expect("the injected failure");
    let (pull, readers) = pull_loop(&db, &[TYPE], payloads.clone(), script);

    let error = pull.pull_page().await.expect_err("sticky-5's write fails");
    assert!(
        error.to_string().contains("injected record failure"),
        "{error}"
    );
    for reader in &readers {
        assert!(reader.heard.lock().unwrap().is_empty(), "{}", reader.name);
    }

    db.call_blocking(|conn| {
        conn.execute_batch("DROP TRIGGER injected_record_failure")
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })
    })
    .expect("drop the injected failure");
    let (pull, readers) = pull_loop(&db, &[TYPE], payloads, retry);
    pull.pull_page().await.expect("the re-pull");
    for reader in readers {
        assert_eq!(
            *reader.heard.lock().unwrap(),
            expected(&ids, Some("10")),
            "{}",
            reader.name
        );
    }
}

/// A tombstone for an id this device never held live, typed or untyped (§5.12.1), deletes
/// nothing: the run counts it skipped, as the feed reports it.
#[tokio::test(flavor = "multi_thread")]
async fn a_tombstone_for_an_item_never_live_here_counts_as_skipped() {
    let db = scratch_db();
    let mut tombstone = envelope_of(TYPE, "ghost");
    tombstone["deletedAt"] = json!(NOW);
    let script = vec![
        changes(&[(TYPE, "ghost")], &["untyped"], "10"),
        pulled(vec![tombstone]),
    ];
    let payloads = BTreeMap::from([("ghost".to_owned(), sticky("ghost"))]);
    let (pull, _readers) = pull_loop(&db, &[TYPE], payloads, script);

    let report = pull.pull_page().await.expect("the page");

    assert_eq!((report.deleted, report.skipped), (0, 2), "{report:?}");
}

/// The first sync's metadata pass ([`PullLoop::fetch_ids`]) tells what it
/// applied.
#[tokio::test(flavor = "multi_thread")]
async fn the_first_syncs_id_fetch_tells_the_observers() {
    let db = scratch_db();
    let ids = ["sticky-a", "sticky-b"].map(str::to_owned);
    let payloads = ids.iter().map(|id| (id.clone(), sticky(id))).collect();
    let script = vec![pulled(ids.iter().map(|id| envelope_of(TYPE, id)).collect())];
    let (pull, readers) = pull_loop(&db, &[TYPE], payloads, script);

    let report = pull.fetch_ids(&ids).await.expect("the fetch");
    assert_eq!(report.applied, 2);
    for reader in readers {
        let heard: Vec<(String, AppliedOutcome)> = reader
            .heard
            .lock()
            .unwrap()
            .iter()
            .map(|(id, outcome, stored, _)| {
                assert!(stored, "{id} is readable");
                (id.clone(), *outcome)
            })
            .collect();
        assert_eq!(
            heard,
            ids.iter()
                .map(|id| (id.clone(), AppliedOutcome::Created))
                .collect::<Vec<_>>(),
            "{}",
            reader.name
        );
    }
}

/// A record another core build refused is refetched at the start of a run,
/// and the observers hear it apply.
#[tokio::test(flavor = "multi_thread")]
async fn a_refetched_refused_record_tells_the_observers() {
    let db = scratch_db();
    let id = "sticky-refused".to_owned();
    let entry = id.clone();
    db.call_blocking(move |conn| {
        conn.execute(
            "INSERT INTO sync_refused_items (item_type, item_id, refused_by_version, refused_at)
             VALUES (?1, ?2, '0.0.1+older', 0)",
            [TYPE, entry.as_str()],
        )
        .map_err(|error| memry_core::api::errors::StorageError::Failed {
            what: error.to_string(),
        })
    })
    .expect("an older build's entry");
    let payloads = BTreeMap::from([(id.clone(), sticky(&id))]);
    let script = vec![pulled(vec![envelope_of(TYPE, &id)]), changes(&[], &[], "1")];
    let (pull, readers) = pull_loop(&db, &[TYPE], payloads, script);

    pull.pull_first_page().await.expect("the run");
    for reader in readers {
        assert_eq!(
            *reader.heard.lock().unwrap(),
            [(id.clone(), AppliedOutcome::Created, true, None)],
            "{}",
            reader.name
        );
    }
}

/// Electron's `note-handler.ts:740-746`: a pulled note tombstone older than
/// the local edit is skipped and the note revived.
#[tokio::test(flavor = "multi_thread")]
async fn a_note_tombstone_that_loses_to_the_local_edit_revives_the_note() {
    let db = scratch_db();
    let id = "note00000001".to_owned();
    let note = json!({
        "title": "Plan", "fileType": "markdown", "folderPath": "Notes",
        "clock": {"peer": 2}, "createdAt": ISO, "modifiedAt": ISO,
    });
    let mut tombstone = envelope_of("note", &id);
    tombstone["operation"] = json!("delete");
    tombstone["deletedAt"] = json!(5);
    tombstone["clock"] = json!({"peer": 1});
    let payloads = BTreeMap::from([(id.clone(), note.to_string())]);
    let script = vec![
        changes(&[("note", &id)], &[], "1"),
        pulled(vec![envelope_of("note", &id)]),
        changes(&[], &[&id], "2"),
        pulled(vec![tombstone]),
    ];
    let (pull, readers) = pull_loop(&db, &["note"], payloads, script);

    pull.pull_page().await.expect("the note");
    let report = pull.pull_page().await.expect("the tombstone");
    assert_eq!((report.deleted, report.skipped), (0, 1));
    for reader in readers {
        assert_eq!(
            *reader.revived.lock().unwrap(),
            std::slice::from_ref(&id),
            "{}",
            reader.name
        );
        let outcomes: Vec<AppliedOutcome> = reader
            .heard
            .lock()
            .unwrap()
            .iter()
            .map(|heard| heard.1)
            .collect();
        assert_eq!(
            outcomes,
            [AppliedOutcome::Created, AppliedOutcome::Skipped],
            "{}",
            reader.name
        );
    }
}
