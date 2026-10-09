//! One journal item per day (#2939): a foreign journal id for a day is merged
//! into `j<date>` and tombstoned, never projected.
//!
//! Real `HttpClient`, SQLite, update log, outbox and `yrs`; the transport and
//! the two ciphers are fakes. The body cipher hands packed bytes back as the
//! plaintext.

mod http_fakes;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeTransport, response};
use memry_core::api::errors::StorageError;
use memry_core::crdt::update_log;
use memry_core::domain::journal;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound_on;
use memry_core::sync::body_pull::{BodyPull, CrdtCipher, PackedUpdate};
use memry_core::sync::clock::{VectorClock, clock_of};
use memry_core::sync::journal_day_merge::{self, OwedMerge};
use memry_core::sync::pull::{PullLoop, RecordCipher};
use rusqlite::{Connection, params};
use serde_json::{Value as Json, json};
use yrs::updates::decoder::Decode as _;
use yrs::{GetString as _, ReadTxn as _, StateVector, Text as _, Transact as _, Update};

const DATE: &str = "2026-06-09";
const CANONICAL: &str = "j2026-06-09";
const FOREIGN: &str = "vcpzueguep8y";
const OTHER_FOREIGN: &str = "wxudm2oo4rci";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-journal-day-merge-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

struct ScriptedCipher(Mutex<Vec<(String, String)>>);

impl RecordCipher for ScriptedCipher {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .find(|(id, _)| id == &envelope.id)
            .map(|(_, payload)| payload.as_bytes().to_vec())
            .ok_or(EnvelopeError::SignatureInvalid)
    }
}

struct PassThrough;

impl CrdtCipher for PassThrough {
    fn open(&self, update: &PackedUpdate<'_>) -> Result<Vec<u8>, EnvelopeError> {
        Ok(update.packed.to_vec())
    }
}

fn http(transport: Arc<FakeTransport>) -> Arc<HttpClient> {
    Arc::new(HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    ))
}

fn envelope(id: &str) -> Json {
    json!({
        "id": id,
        "type": "journal",
        "operation": "update",
        "encryptedKey": "AAAA",
        "keyNonce": "AAAA",
        "encryptedData": "AAAA",
        "dataNonce": "AAAA",
        "signature": "AAAA",
        "signerDeviceId": "device-b",
    })
}

fn journal_payload(clock: Json) -> String {
    json!({"date": DATE, "content": "", "clock": clock}).to_string()
}

/// Pulls one page carrying a single journal record through the real loop.
async fn pull_one(db: &Db, id: &str, payload: &str) -> memry_core::sync::pull::PullReport {
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"items": [{"id": id, "type": "journal"}], "deleted": [], "hasMore": false, "nextCursor": "5"}).to_string(),
        ),
        response(200, &json!({"items": [envelope(id)]}).to_string()),
    ]);
    let cipher = Arc::new(ScriptedCipher(Mutex::new(vec![(
        id.to_owned(),
        payload.to_owned(),
    )])));
    PullLoop::new(
        http(transport),
        db.clone(),
        Declaration::subscribed(),
        cipher,
    )
    .pull_page()
    .await
    .expect("the page")
}

fn record(id: &str, payload: &str) -> InboundRecord {
    InboundRecord {
        item_type: "journal".to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_owned(),
        server_cursor: Some(1),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: 1,
        deleted_at: None,
    }
}

/// A real Yjs update writing `text` into root `t`, authored by `client`.
fn text_update(client: u64, text: &str) -> Vec<u8> {
    let doc = yrs::Doc::with_client_id(client);
    let body = doc.get_or_insert_text("t");
    body.insert(&mut doc.transact_mut(), 0, text);
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

/// The server answers for one document with no cursor: no snapshot, then
/// one page holding `update`.
fn body_pull(db: &Db, update: &[u8]) -> BodyPull {
    bodies_for(db, &[Some(update)])
}

/// One scripted body per document, in drain order; `None` is an empty log.
fn bodies_for(db: &Db, logs: &[Option<&[u8]>]) -> BodyPull {
    let mut script = Vec::new();
    for log in logs {
        let updates: Vec<Json> = log
            .iter()
            .map(|update| json!({"sequenceNum": 1, "data": BASE64.encode(update), "signerDeviceId": "device-b", "createdAt": 1}))
            .collect();
        script.push(response(200, &json!({"snapshot": null}).to_string()));
        script.push(response(
            200,
            &json!({"updates": updates, "hasMore": false}).to_string(),
        ));
    }
    let transport = FakeTransport::new(script);
    BodyPull::new(
        http(transport),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(PassThrough),
    )
}

fn text_of(conn: &Connection, doc_id: &str) -> String {
    let doc = yrs::Doc::new();
    let body = doc.get_or_insert_text("t");
    for blob in update_log::load_plan(conn, doc_id)
        .expect("the plan")
        .blobs()
    {
        doc.transact_mut()
            .apply_update(Update::decode_v1(blob).expect("decodes"))
            .expect("applies");
    }
    body.get_string(&doc.transact())
}

fn outbox(conn: &Connection) -> Vec<(String, String, Option<Vec<u8>>)> {
    let mut statement = conn
        .prepare("SELECT item_id, op, payload FROM outbox ORDER BY id")
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn day_holder(conn: &Connection) -> Option<String> {
    journal::live_entry(conn, DATE).expect("the day")
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

#[tokio::test]
async fn a_foreign_journal_for_a_held_day_is_skipped_and_owed_not_corrupt() {
    let db = scratch_db("foreign-held");
    db.call_blocking(|conn| journal::open_day(conn, DATE, "device-a", 1).map(|_| ()))
        .unwrap();

    let report = pull_one(&db, FOREIGN, &journal_payload(json!({"device-b": 1}))).await;
    assert_eq!((report.applied, report.skipped, report.corrupt), (0, 1, 0));
    assert!(!report.refused);

    db.call_blocking(|conn| {
        assert_eq!(day_holder(conn).as_deref(), Some(CANONICAL));
        let foreign = sync_items::load(conn, "journal", FOREIGN)?;
        assert!(
            foreign.is_none_or(|row| row.corrupt_reason.is_none()),
            "a foreign id is never recorded corrupt"
        );
        assert_eq!(
            journal_day_merge::owed(conn)?,
            vec![OwedMerge {
                foreign_id: FOREIGN.to_owned(),
                date: DATE.to_owned(),
                clock: clock_of([("device-b", 1)]),
                deleted: false,
                record_markdown: None,
            }]
        );
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
async fn the_canonical_day_displaces_a_foreign_holder_and_owes_its_merge() {
    let db = scratch_db("canonical-displaces");
    // What an older build left: a foreign row holding the day.
    db.call_blocking(|conn| {
        let held = record(OTHER_FOREIGN, &journal_payload(json!({"device-b": 2})));
        assert_eq!(
            sync_items::apply_remote(conn, &held, 1)?,
            ApplyOutcome::Applied
        );
        update_log::append_server_update(conn, OTHER_FOREIGN, 1, &text_update(7, "held"), 1)
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?;
        assert_eq!(day_holder(conn).as_deref(), Some(OTHER_FOREIGN));
        Ok(())
    })
    .unwrap();

    let report = pull_one(&db, CANONICAL, &journal_payload(json!({"device-c": 1}))).await;
    assert_eq!((report.applied, report.corrupt), (1, 0));

    db.call_blocking(|conn| {
        assert_eq!(day_holder(conn).as_deref(), Some(CANONICAL));
        let rows: i64 = conn
            .query_row(
                "SELECT count(*) FROM journal_entries WHERE id = ?1",
                params![OTHER_FOREIGN],
                |row| row.get(0),
            )
            .map_err(failed)?;
        assert_eq!(rows, 0, "the holder's row is gone");
        assert_eq!(
            text_of(conn, OTHER_FOREIGN),
            "held",
            "its body stays for the drain"
        );
        assert_eq!(
            journal_day_merge::owed(conn)?,
            vec![OwedMerge {
                foreign_id: OTHER_FOREIGN.to_owned(),
                date: DATE.to_owned(),
                clock: clock_of([("device-b", 2)]),
                deleted: false,
                record_markdown: None,
            }]
        );
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
async fn the_drain_merges_a_foreign_body_once_and_tombstones_it() {
    let db = scratch_db("drain");
    db.call_blocking(|conn| {
        let foreign = record(FOREIGN, &journal_payload(json!({"device-b": 1})));
        assert_eq!(
            apply_inbound_on(conn, &foreign, 1, Some("device-a"))?,
            ApplyOutcome::Skipped
        );
        // A task linked to the foreign day, and to a note that stays.
        let task = InboundRecord {
            item_type: "task".to_owned(),
            item_id: "task-1".to_owned(),
            payload_json: json!({
                "title": "Follow up",
                "projectId": "inbox",
                "linkedNoteIds": [FOREIGN, "noteaaaaaaaa", CANONICAL],
                "clock": {"device-b": 1},
            })
            .to_string(),
            ..record("task-1", "{}")
        };
        assert_eq!(
            sync_items::apply_remote(conn, &task, 1)?,
            ApplyOutcome::Applied
        );
        Ok(())
    })
    .unwrap();

    let bodies = body_pull(&db, &text_update(9, "written elsewhere"));
    let report = journal_day_merge::drain(&db, &bodies, "device-a")
        .await
        .unwrap();
    assert_eq!(report.settled, vec![FOREIGN.to_owned()]);
    assert!(report.owed.is_empty());

    let snapshot = db
        .call_blocking(|conn| {
            assert_eq!(
                day_holder(conn).as_deref(),
                Some(CANONICAL),
                "the day was created"
            );
            assert_eq!(text_of(conn, CANONICAL), "written elsewhere");
            assert!(
                update_log::load_plan(conn, FOREIGN).unwrap().is_empty(),
                "purged"
            );
            assert!(journal_day_merge::owed(conn)?.is_empty());

            let queued = outbox(conn);
            let crdt: Vec<_> = queued.iter().filter(|row| row.1 == "crdt-update").collect();
            assert_eq!(crdt.len(), 1);
            assert_eq!(crdt[0].0, CANONICAL);
            assert!(
                queued
                    .iter()
                    .any(|row| row.0 == CANONICAL && row.1 == "upsert")
            );
            assert!(
                queued
                    .iter()
                    .any(|row| row.0 == "task-1" && row.1 == "upsert")
            );
            assert_eq!(
                queued
                    .iter()
                    .filter(|row| row.0 == FOREIGN && row.1 == "delete")
                    .count(),
                1
            );

            let tombstone = sync_items::load(conn, "journal", FOREIGN)?.expect("a tombstone row");
            assert!(tombstone.deleted_at.is_some());
            let ticked: VectorClock = serde_json::from_str(&tombstone.clock.unwrap()).unwrap();
            assert_eq!(ticked, clock_of([("device-a", 1), ("device-b", 1)]));

            let linked: String = conn
                .query_row(
                    "SELECT linked_note_ids FROM tasks WHERE id = 'task-1'",
                    [],
                    |row| row.get(0),
                )
                .map_err(failed)?;
            let linked: Vec<String> = serde_json::from_str(&linked).unwrap();
            assert_eq!(
                linked,
                vec![CANONICAL.to_owned(), "noteaaaaaaaa".to_owned()]
            );
            Ok(queued.len())
        })
        .unwrap();

    // A re-run, and the foreign record delivered again, change nothing.
    let again = journal_day_merge::drain(&db, &body_pull(&db, &[]), "device-a")
        .await
        .unwrap();
    assert!(again.settled.is_empty() && again.owed.is_empty());
    db.call_blocking(move |conn| {
        let foreign = record(FOREIGN, &journal_payload(json!({"device-b": 1})));
        assert_eq!(
            apply_inbound_on(conn, &foreign, 2, Some("device-a"))?,
            ApplyOutcome::Skipped
        );
        assert!(
            journal_day_merge::owed(conn)?.is_empty(),
            "already tombstoned past it"
        );
        assert_eq!(outbox(conn).len(), snapshot);
        assert_eq!(text_of(conn, CANONICAL), "written elsewhere");
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
async fn two_devices_merging_the_same_foreign_day_converge_on_one_copy() {
    let foreign_body = text_update(9, "once");
    let mut updates = Vec::new();
    let mut devices = Vec::new();
    for device in ["device-a", "device-c"] {
        let db = scratch_db(device);
        db.call_blocking(move |conn| {
            journal::open_day(conn, DATE, device, 1)?;
            let foreign = record(FOREIGN, &journal_payload(json!({"device-b": 1})));
            assert_eq!(
                apply_inbound_on(conn, &foreign, 1, Some(device))?,
                ApplyOutcome::Skipped
            );
            Ok(())
        })
        .unwrap();
        let bodies = body_pull(&db, &foreign_body);
        let report = journal_day_merge::drain(&db, &bodies, device)
            .await
            .unwrap();
        assert_eq!(report.settled, vec![FOREIGN.to_owned()]);
        let update = db
            .call_blocking(|conn| {
                Ok(outbox(conn)
                    .into_iter()
                    .find(|row| row.1 == "crdt-update")
                    .and_then(|row| row.2)
                    .expect("one crdt update for the day"))
            })
            .unwrap();
        updates.push(update);
        devices.push(db);
    }

    // A third device that already holds the merged day authors nothing.
    let late = scratch_db("device-d");
    let merged = updates[0].clone();
    late.call_blocking(move |conn| {
        journal::open_day(conn, DATE, "device-d", 1)?;
        update_log::append_server_update(conn, CANONICAL, 1, &merged, 2).map_err(|e| {
            StorageError::Failed {
                what: e.to_string(),
            }
        })?;
        let foreign = record(FOREIGN, &journal_payload(json!({"device-b": 1})));
        apply_inbound_on(conn, &foreign, 1, Some("device-d"))?;
        Ok(())
    })
    .unwrap();
    let report = journal_day_merge::drain(&late, &body_pull(&late, &foreign_body), "device-d")
        .await
        .unwrap();
    assert_eq!(report.settled, vec![FOREIGN.to_owned()]);
    late.call_blocking(|conn| {
        assert!(
            outbox(conn).iter().all(|row| row.1 != "crdt-update"),
            "an empty diff queues nothing"
        );
        assert_eq!(text_of(conn, CANONICAL), "once");
        Ok(())
    })
    .unwrap();

    // Each device receives the other's update for the day from the server.
    for (db, peer_update) in devices.iter().zip(updates.iter().rev()) {
        let peer_update = peer_update.clone();
        db.call_blocking(move |conn| {
            update_log::append_server_update(conn, CANONICAL, 1, &peer_update, 2).map_err(|e| {
                StorageError::Failed {
                    what: e.to_string(),
                }
            })?;
            assert_eq!(text_of(conn, CANONICAL), "once");
            Ok(())
        })
        .unwrap();
    }
}

/// Applies typed journal tombstones through the real pull loop.
async fn pull_tombstones(db: &Db, ids: &[&str]) {
    let refs: Vec<Json> = ids
        .iter()
        .map(|id| json!({"id": id, "type": "journal"}))
        .collect();
    let items: Vec<Json> = ids
        .iter()
        .map(|id| {
            let mut item = envelope(id);
            item["deletedAt"] = json!(5);
            item
        })
        .collect();
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"items": refs, "deleted": [], "hasMore": false, "nextCursor": "9"}).to_string(),
        ),
        response(200, &json!({"items": items}).to_string()),
    ]);
    let cipher = Arc::new(ScriptedCipher(Mutex::new(Vec::new())));
    let report = PullLoop::new(
        http(transport),
        db.clone(),
        Declaration::subscribed(),
        cipher,
    )
    .pull_page()
    .await
    .expect("the page");
    assert_eq!(report.deleted, ids.len());
}

#[tokio::test]
async fn a_foreign_id_another_device_already_deleted_is_not_pulled_and_settles_without_a_tombstone()
{
    let db = scratch_db("already-deleted");
    db.call_blocking(|conn| {
        let foreign = record(FOREIGN, &journal_payload(json!({"device-b": 1})));
        assert_eq!(
            apply_inbound_on(conn, &foreign, 1, Some("device-a"))?,
            ApplyOutcome::Skipped
        );
        Ok(())
    })
    .unwrap();
    pull_tombstones(&db, &[FOREIGN]).await;

    // The deleting device merged the server body: nothing is fetched (an
    // empty script fails any request), and nothing held here is left.
    let report = journal_day_merge::drain(&db, &bodies_for(&db, &[]), "device-a")
        .await
        .unwrap();
    assert_eq!(report.settled, vec![FOREIGN.to_owned()]);

    db.call_blocking(|conn| {
        assert!(journal_day_merge::owed(conn)?.is_empty());
        assert!(outbox(conn).is_empty(), "no day created, no tombstone");
        assert_eq!(day_holder(conn), None);
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
async fn a_tombstone_for_a_live_foreign_row_keeps_its_unpushed_edits_for_the_merge() {
    let db = scratch_db("tombstone-first");
    // A pre-fix row holding the day, with an edit this device never pushed.
    db.call_blocking(|conn| {
        let held = record(FOREIGN, &journal_payload(json!({"device-b": 2})));
        assert_eq!(
            sync_items::apply_remote(conn, &held, 1)?,
            ApplyOutcome::Applied
        );
        update_log::append_local_update(conn, FOREIGN, &text_update(7, "unpushed"), 1).map_err(
            |e| StorageError::Failed {
                what: e.to_string(),
            },
        )?;
        Ok(())
    })
    .unwrap();

    // Another device merged FOREIGN and deleted it before this device did.
    pull_tombstones(&db, &[FOREIGN]).await;
    db.call_blocking(|conn| {
        assert_eq!(text_of(conn, FOREIGN), "unpushed", "not purged");
        assert_eq!(
            journal_day_merge::owed(conn)?
                .iter()
                .map(|owed| owed.deleted)
                .collect::<Vec<_>>(),
            vec![true]
        );
        Ok(())
    })
    .unwrap();

    let report = journal_day_merge::drain(&db, &bodies_for(&db, &[]), "device-a")
        .await
        .unwrap();
    assert_eq!(report.settled, vec![FOREIGN.to_owned()]);
    db.call_blocking(|conn| {
        assert_eq!(day_holder(conn).as_deref(), Some(CANONICAL));
        assert_eq!(text_of(conn, CANONICAL), "unpushed");
        assert!(update_log::load_plan(conn, FOREIGN).unwrap().is_empty());
        assert!(
            outbox(conn).iter().all(|row| row.1 != "delete"),
            "the tombstone already exists"
        );
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
async fn a_deleted_day_is_not_recreated_and_the_foreign_id_is_dropped() {
    let db = scratch_db("day-deleted");
    db.call_blocking(|conn| {
        let day = record(CANONICAL, &journal_payload(json!({"device-c": 1})));
        assert_eq!(
            apply_inbound_on(conn, &day, 1, Some("device-a"))?,
            ApplyOutcome::Applied
        );
        Ok(())
    })
    .unwrap();
    pull_tombstones(&db, &[CANONICAL]).await;
    db.call_blocking(|conn| {
        let foreign = record(FOREIGN, &journal_payload(json!({"device-b": 1})));
        assert_eq!(
            apply_inbound_on(conn, &foreign, 1, Some("device-a"))?,
            ApplyOutcome::Skipped
        );
        Ok(())
    })
    .unwrap();

    let bodies = body_pull(&db, &text_update(9, "late"));
    let report = journal_day_merge::drain(&db, &bodies, "device-a")
        .await
        .unwrap();
    assert_eq!(report.settled, vec![FOREIGN.to_owned()]);
    db.call_blocking(|conn| {
        assert_eq!(day_holder(conn), None, "the day stays deleted");
        assert_eq!(text_of(conn, CANONICAL), "");
        let queued = outbox(conn);
        assert_eq!(
            queued
                .iter()
                .map(|row| (row.0.as_str(), row.1.as_str()))
                .collect::<Vec<_>>(),
            vec![(FOREIGN, "delete")]
        );
        let tombstone = sync_items::load(conn, "journal", FOREIGN)?.expect("the tombstone row");
        assert_eq!(
            tombstone.payload.as_deref(),
            Some(r#"{"clock":{"device-a":1,"device-b":1}}"#)
        );
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
async fn a_foreign_record_this_device_already_tombstoned_is_not_owed_again() {
    let db = scratch_db("redelivered");
    db.call_blocking(|conn| {
        let foreign = record(FOREIGN, &journal_payload(json!({"device-b": 1})));
        apply_inbound_on(conn, &foreign, 1, Some("device-a"))?;
        Ok(())
    })
    .unwrap();
    let bodies = body_pull(&db, &text_update(9, "once"));
    journal_day_merge::drain(&db, &bodies, "device-a")
        .await
        .unwrap();
    db.call_blocking(|conn| {
        let again = record(FOREIGN, &journal_payload(json!({"device-b": 1})));
        assert_eq!(
            apply_inbound_on(conn, &again, 1, Some("device-a"))?,
            ApplyOutcome::Skipped
        );
        assert!(journal_day_merge::owed(conn)?.is_empty());
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
async fn a_live_foreign_id_with_no_body_or_text_is_tombstoned_without_a_day() {
    let db = scratch_db("empty-live");
    db.call_blocking(|conn| {
        let foreign = record(FOREIGN, &journal_payload(json!({"device-b": 1})));
        assert_eq!(
            apply_inbound_on(conn, &foreign, 1, Some("device-a"))?,
            ApplyOutcome::Skipped
        );
        Ok(())
    })
    .unwrap();

    let report = journal_day_merge::drain(&db, &bodies_for(&db, &[None]), "device-a")
        .await
        .unwrap();
    assert_eq!(report.settled, vec![FOREIGN.to_owned()]);
    db.call_blocking(|conn| {
        assert!(journal_day_merge::owed(conn)?.is_empty());
        assert_eq!(day_holder(conn), None, "no day for nothing");
        let queued: Vec<(String, String)> = outbox(conn)
            .into_iter()
            .map(|(id, op, _)| (id, op))
            .collect();
        assert_eq!(queued, vec![(FOREIGN.to_owned(), "delete".to_owned())]);
        Ok(())
    })
    .unwrap();
}

/// The day's body as one string: every update of `doc_id`, `prosemirror` root.
fn body_of(conn: &Connection, doc_id: &str) -> String {
    let doc = yrs::Doc::new();
    let body = doc.get_or_insert_xml_fragment("prosemirror");
    for blob in update_log::load_plan(conn, doc_id)
        .expect("the plan")
        .blobs()
    {
        doc.transact_mut()
            .apply_update(Update::decode_v1(blob).expect("decodes"))
            .expect("applies");
    }
    body.get_string(&doc.transact())
}

#[tokio::test]
async fn a_live_foreign_id_with_text_but_no_yjs_body_is_built_into_the_day() {
    let db = scratch_db("text-only");
    db.call_blocking(|conn| {
        let payload =
            json!({"date": DATE, "content": "theirs, never opened\n", "clock": {"device-b": 1}});
        let foreign = record(FOREIGN, &payload.to_string());
        assert_eq!(
            apply_inbound_on(conn, &foreign, 1, Some("device-a"))?,
            ApplyOutcome::Skipped
        );
        Ok(())
    })
    .unwrap();

    let report = journal_day_merge::drain(&db, &bodies_for(&db, &[None]), "device-a")
        .await
        .unwrap();
    assert_eq!(report.settled, vec![FOREIGN.to_owned()]);
    db.call_blocking(|conn| {
        assert_eq!(day_holder(conn).as_deref(), Some(CANONICAL));
        assert!(body_of(conn, CANONICAL).contains("theirs, never opened"));
        assert!(journal_day_merge::owed(conn)?.is_empty());
        let ops: Vec<(String, String)> = outbox(conn)
            .into_iter()
            .map(|(id, op, _)| (id, op))
            .collect();
        assert!(ops.contains(&(FOREIGN.to_owned(), "delete".to_owned())));
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
async fn a_foreign_id_deleted_elsewhere_is_not_built_from_its_text_again() {
    let db = scratch_db("text-deleted");
    db.call_blocking(|conn| {
        let payload = json!({"date": DATE, "content": "built there", "clock": {"device-b": 1}});
        let foreign = record(FOREIGN, &payload.to_string());
        apply_inbound_on(conn, &foreign, 1, Some("device-a"))?;
        Ok(())
    })
    .unwrap();
    pull_tombstones(&db, &[FOREIGN]).await;

    let report = journal_day_merge::drain(&db, &bodies_for(&db, &[None]), "device-a")
        .await
        .unwrap();
    assert_eq!(report.settled, vec![FOREIGN.to_owned()]);
    db.call_blocking(|conn| {
        assert_eq!(day_holder(conn), None, "the deleting device built it");
        assert!(outbox(conn).is_empty());
        Ok(())
    })
    .unwrap();
}
