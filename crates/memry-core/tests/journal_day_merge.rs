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
use memry_core::crdt::epoch::HeldBody;
use memry_core::crdt::update_log;
use memry_core::domain::journal_ops::metadata;
use memry_core::domain::{journal, tags};
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope, SyncOperation};
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
        // §5.14: a delete opens before it applies; this one opens to the
        // empty payload a signed delete seals.
        if envelope.deleted_at.is_some() || envelope.operation == SyncOperation::Delete {
            return Ok(Vec::new());
        }
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

/// The server answers for one document with no cursor: a refused batch
/// probe, no snapshot, then one page holding `update`.
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
        script.push(http_fakes::probe_refused());
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
                record_tags: Vec::new(),
                holder_tags: Vec::new(),
                unpushed_holder_tags: Vec::new(),
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
        HeldBody::never_purged(conn, OTHER_FOREIGN)
            .and_then(|held| held.append_server_update(1, &text_update(7, "held"), 1))
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
                record_tags: Vec::new(),
                holder_tags: Vec::new(),
                unpushed_holder_tags: Vec::new(),
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
        HeldBody::never_purged(conn, CANONICAL)
            .and_then(|held| held.append_server_update(1, &merged, 2))
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
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
            HeldBody::never_purged(conn, CANONICAL)
                .and_then(|held| held.append_server_update(1, &peer_update, 2))
                .map_err(|e| StorageError::Failed {
                    what: e.to_string(),
                })?;
            assert_eq!(text_of(conn, CANONICAL), "once");
            Ok(())
        })
        .unwrap();
    }
}

/// Applies typed journal tombstones with no clock through the real pull loop.
async fn pull_tombstones(db: &Db, ids: &[&str]) {
    pull_tombstones_at(db, ids, None).await;
}

/// Applies typed journal tombstones through the real pull loop.
async fn pull_tombstones_at(db: &Db, ids: &[&str], clock: Option<Json>) {
    let refs: Vec<Json> = ids
        .iter()
        .map(|id| json!({"id": id, "type": "journal"}))
        .collect();
    let items: Vec<Json> = ids
        .iter()
        .map(|id| {
            let mut item = envelope(id);
            item["deletedAt"] = json!(5);
            if let Some(clock) = &clock {
                item["clock"] = clock.clone();
            }
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
    // A pre-fix row holding the day, with edits this device never pushed.
    db.call_blocking(|conn| {
        let held = record(FOREIGN, &tagged_payload("", &[], json!({"device-b": 2})));
        assert_eq!(
            sync_items::apply_remote(conn, &held, 1)?,
            ApplyOutcome::Applied
        );
        update_log::append_local_update(conn, FOREIGN, &text_update(7, "unpushed"), 1).map_err(
            |e| StorageError::Failed {
                what: e.to_string(),
            },
        )?;
        metadata::set_tags(conn, DATE, &["mine".to_owned()], "device-a", 2)?;
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
        assert_eq!(day_tags(conn), vec!["mine"], "a holder's tags are local");
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
async fn a_deleted_day_is_not_recreated_and_the_foreign_id_stays_live() {
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
        // Not tombstoned: an old build may hold text of `F` it never pushed,
        // and a tombstone would make it delete its day file.
        assert!(outbox(conn).is_empty(), "no tombstone for a dropped id");
        assert!(sync_items::load(conn, "journal", FOREIGN)?.is_none());
        assert_eq!(text_of(conn, FOREIGN), "late", "its body stays");
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
async fn a_live_foreign_id_with_no_body_or_text_settles_without_a_day_or_tombstone() {
    let db = scratch_db("empty-live");
    // An update record carries `content: null`: the text lives only in an
    // old build's day file, which a tombstone would make it delete.
    db.call_blocking(|conn| {
        let payload = json!({"date": DATE, "content": null, "clock": {"device-b": 2}});
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
        assert!(journal_day_merge::owed(conn)?.is_empty());
        assert_eq!(day_holder(conn), None, "no day for nothing");
        assert!(
            outbox(conn).is_empty(),
            "a live id it did not merge is not tombstoned"
        );
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

fn tagged_payload(content: &str, tags: &[&str], clock: Json) -> String {
    json!({"date": DATE, "content": content, "tags": tags, "clock": clock}).to_string()
}

fn day_tags(conn: &Connection) -> Vec<String> {
    tags::list(conn, "journal", CANONICAL).expect("the day's tags")
}

fn upserts_of(conn: &Connection, id: &str) -> usize {
    outbox(conn)
        .iter()
        .filter(|row| row.0 == id && row.1 == "upsert")
        .count()
}

/// The day's payload owns its tags and the fold carries only the body, so
/// the drain adds a foreign entry's record tags to `j<D>` and pushes them
/// (§1.9.1 step 6, #5483).
#[tokio::test]
async fn a_folded_foreign_entry_adds_its_tags_to_the_day_and_pushes_them() {
    for (day, foreign, expected) in [
        (vec![], vec!["x"], vec!["x"]),
        (vec!["a"], vec!["x", "A"], vec!["a", "x"]),
    ] {
        let db = scratch_db("foreign-tags");
        db.call_blocking(move |conn| {
            let canonical = record(CANONICAL, &tagged_payload("", &day, json!({"device-c": 1})));
            assert_eq!(
                apply_inbound_on(conn, &canonical, 1, Some("device-a"))?,
                ApplyOutcome::Applied
            );
            let foreign = record(
                FOREIGN,
                &tagged_payload("", &foreign, json!({"device-b": 1})),
            );
            assert_eq!(
                apply_inbound_on(conn, &foreign, 2, Some("device-a"))?,
                ApplyOutcome::Skipped
            );
            Ok(())
        })
        .unwrap();

        let report =
            journal_day_merge::drain(&db, &body_pull(&db, &text_update(9, "theirs")), "device-a")
                .await
                .unwrap();
        assert_eq!(report.settled, vec![FOREIGN.to_owned()]);
        db.call_blocking(move |conn| {
            assert_eq!(day_tags(conn), expected);
            assert_eq!(upserts_of(conn, CANONICAL), 1, "the tags are pushed");
            assert!(journal_day_merge::owed(conn)?.is_empty());
            Ok(())
        })
        .unwrap();
    }
}

#[tokio::test]
async fn a_tagged_day_gaining_no_new_tag_writes_nothing() {
    let db = scratch_db("tags-held");
    db.call_blocking(|conn| {
        let canonical = record(
            CANONICAL,
            &tagged_payload("", &["a", "b"], json!({"device-c": 1})),
        );
        apply_inbound_on(conn, &canonical, 1, Some("device-a"))?;
        let foreign = record(FOREIGN, &tagged_payload("", &["B"], json!({"device-b": 1})));
        apply_inbound_on(conn, &foreign, 2, Some("device-a"))?;
        Ok(())
    })
    .unwrap();

    let report =
        journal_day_merge::drain(&db, &body_pull(&db, &text_update(9, "theirs")), "device-a")
            .await
            .unwrap();
    assert_eq!(report.settled, vec![FOREIGN.to_owned()]);
    db.call_blocking(|conn| {
        assert_eq!(day_tags(conn), vec!["a", "b"]);
        assert_eq!(upserts_of(conn, CANONICAL), 0);
        Ok(())
    })
    .unwrap();
}

/// A foreign holder's projection and `note_tags` go when `j<D>` arrives, but
/// its stored payload tags are kept in the owed merge and reach the day.
#[tokio::test]
async fn a_foreign_holder_keeps_its_tags_when_the_day_record_displaces_it() {
    let db = scratch_db("holder-tags");
    db.call_blocking(|conn| {
        let held = record(
            OTHER_FOREIGN,
            &tagged_payload("", &["mine"], json!({"device-b": 2})),
        );
        sync_items::apply_remote(conn, &held, 1)?;
        HeldBody::never_purged(conn, OTHER_FOREIGN)
            .and_then(|held| held.append_server_update(1, &text_update(7, "held"), 1))
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?;
        let canonical = record(CANONICAL, &tagged_payload("", &[], json!({"device-c": 1})));
        assert_eq!(
            apply_inbound_on(conn, &canonical, 2, Some("device-a"))?,
            ApplyOutcome::Applied
        );
        Ok(())
    })
    .unwrap();

    let report = journal_day_merge::drain(&db, &bodies_for(&db, &[None]), "device-a")
        .await
        .unwrap();
    assert_eq!(report.settled, vec![OTHER_FOREIGN.to_owned()]);
    db.call_blocking(|conn| {
        assert_eq!(day_tags(conn), vec!["mine"]);
        assert_eq!(text_of(conn, CANONICAL), "held");
        assert_eq!(upserts_of(conn, CANONICAL), 1);
        Ok(())
    })
    .unwrap();
}

/// An owed merge an older build recorded has no `tags` key: it still drains
/// and leaves the day's tags alone.
#[tokio::test]
async fn an_owed_merge_from_an_older_build_without_tags_still_drains() {
    let db = scratch_db("owed-no-tags");
    db.call_blocking(|conn| {
        let canonical = record(CANONICAL, &tagged_payload("", &["a"], json!({"device-c": 1})));
        apply_inbound_on(conn, &canonical, 1, Some("device-a"))?;
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)",
            params![
                format!("journal.day_merge:{FOREIGN}"),
                json!({"foreignId": FOREIGN, "date": DATE, "clock": {"device-b": 1}, "deleted": false})
                    .to_string()
            ],
        )
        .map_err(failed)?;
        Ok(())
    })
    .unwrap();

    let report =
        journal_day_merge::drain(&db, &body_pull(&db, &text_update(9, "theirs")), "device-a")
            .await
            .unwrap();
    assert_eq!(report.settled, vec![FOREIGN.to_owned()]);
    db.call_blocking(|conn| {
        assert_eq!(day_tags(conn), vec!["a"]);
        assert_eq!(text_of(conn, CANONICAL), "theirs");
        assert!(journal_day_merge::owed(conn)?.is_empty());
        Ok(())
    })
    .unwrap();
}

/// The newest record replaces the record tags kept so far: a tag removed on
/// the device that wrote it stays removed.
#[tokio::test]
async fn a_later_foreign_record_replaces_the_record_tags_it_owes() {
    let db = scratch_db("record-tags-replace");
    db.call_blocking(|conn| {
        let canonical = record(CANONICAL, &tagged_payload("", &[], json!({"device-c": 1})));
        apply_inbound_on(conn, &canonical, 1, Some("device-a"))?;
        let first = record(
            FOREIGN,
            &tagged_payload("", &["x", "y"], json!({"device-b": 1})),
        );
        apply_inbound_on(conn, &first, 2, Some("device-a"))?;
        let second = record(FOREIGN, &tagged_payload("", &["x"], json!({"device-b": 2})));
        apply_inbound_on(conn, &second, 3, Some("device-a"))?;
        Ok(())
    })
    .unwrap();

    let report =
        journal_day_merge::drain(&db, &body_pull(&db, &text_update(9, "theirs")), "device-a")
            .await
            .unwrap();
    assert_eq!(report.settled, vec![FOREIGN.to_owned()]);
    db.call_blocking(|conn| {
        assert_eq!(day_tags(conn), vec!["x"]);
        Ok(())
    })
    .unwrap();
}

/// A deleted foreign id was merged by the device that deleted it, record
/// tags included; adding them again would bring back a tag removed since.
/// A holder's tags are this device's and still go in: the row has no
/// `unpushedHolderTags`, as an older build wrote it, so all of them count as
/// unpushed.
#[tokio::test]
async fn a_deleted_foreign_id_adds_its_holder_tags_but_not_its_record_tags() {
    let db = scratch_db("deleted-record-tags");
    db.call_blocking(|conn| {
        let canonical = record(
            CANONICAL,
            &tagged_payload("", &["a"], json!({"device-c": 1})),
        );
        apply_inbound_on(conn, &canonical, 1, Some("device-a"))?;
        update_log::append_local_update(conn, FOREIGN, &text_update(7, "local"), 1).map_err(
            |e| StorageError::Failed {
                what: e.to_string(),
            },
        )?;
        let owed = json!({
            "foreignId": FOREIGN, "date": DATE, "clock": {"device-b": 1}, "deleted": true,
            "recordTags": ["gone"], "holderTags": ["mine"],
        });
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)",
            params![format!("journal.day_merge:{FOREIGN}"), owed.to_string()],
        )
        .map_err(failed)?;
        Ok(())
    })
    .unwrap();

    let report = journal_day_merge::drain(&db, &bodies_for(&db, &[]), "device-a")
        .await
        .unwrap();
    assert_eq!(report.settled, vec![FOREIGN.to_owned()]);
    db.call_blocking(|conn| {
        assert_eq!(text_of(conn, CANONICAL), "local");
        assert_eq!(day_tags(conn), vec!["a", "mine"]);
        Ok(())
    })
    .unwrap();
}

/// Device B merged `F` into the day, deleted it, then removed `b` from the
/// day. This device held `F` as pulled, so `b` reached the server and B added
/// it already: the deleted merge leaves it removed (#5247 B4). A tag added
/// here and never pushed still goes in.
#[tokio::test]
async fn a_deleted_merge_adds_only_the_holder_tags_this_device_never_pushed() {
    for (offline_add, expected) in [(false, vec!["a"]), (true, vec!["a", "c"])] {
        let db = scratch_db("holder-unpushed-tags");
        db.call_blocking(move |conn| {
            let held = record(
                FOREIGN,
                &tagged_payload("", &["a", "b"], json!({"device-b": 2})),
            );
            sync_items::apply_remote(conn, &held, 1)?;
            update_log::append_local_update(conn, FOREIGN, &text_update(7, "held"), 1).map_err(
                |e| StorageError::Failed {
                    what: e.to_string(),
                },
            )?;
            if offline_add {
                let tags = ["a", "b", "c"].map(str::to_owned);
                metadata::set_tags(conn, DATE, &tags, "device-a", 2)?;
                assert_eq!(upserts_of(conn, FOREIGN), 1, "the add is unpushed");
            }
            Ok(())
        })
        .unwrap();

        pull_tombstones_at(&db, &[FOREIGN], Some(json!({"device-b": 3}))).await;
        db.call_blocking(|conn| {
            let day = record(
                CANONICAL,
                &tagged_payload("", &["a"], json!({"device-b": 3})),
            );
            assert_eq!(
                apply_inbound_on(conn, &day, 3, Some("device-a"))?,
                ApplyOutcome::Applied
            );
            Ok(())
        })
        .unwrap();

        let report = journal_day_merge::drain(&db, &bodies_for(&db, &[]), "device-a")
            .await
            .unwrap();
        assert_eq!(report.settled, vec![FOREIGN.to_owned()]);
        db.call_blocking(move |conn| {
            assert_eq!(text_of(conn, CANONICAL), "held");
            assert_eq!(day_tags(conn), expected, "offline add: {offline_add}");
            let kept: i64 = conn
                .query_row(
                    "SELECT count(*) FROM meta WHERE key LIKE 'journal.synced_tags:%'",
                    [],
                    |row| row.get(0),
                )
                .map_err(failed)?;
            assert_eq!(kept, 0, "the merge forgets the tags kept for it");
            Ok(())
        })
        .unwrap();
    }
}

/// A blank `F` whose only content is a tag added offline: B's `j<D>` and then
/// its tombstone arrive. Nothing holds `c` but this device, so the drain
/// merges it into the day with no body to fold, rather than forgetting `F`
/// (#5659).
#[tokio::test]
async fn a_deleted_blank_holder_still_brings_its_offline_tag_to_the_day() {
    let db = scratch_db("holder-blank-tags");
    db.call_blocking(|conn| {
        let held = record(
            FOREIGN,
            &tagged_payload("", &["a", "b"], json!({"device-b": 2})),
        );
        sync_items::apply_remote(conn, &held, 1)?;
        let tags = ["a", "b", "c"].map(str::to_owned);
        metadata::set_tags(conn, DATE, &tags, "device-a", 2)?;
        let day = record(
            CANONICAL,
            &tagged_payload("", &["a", "b"], json!({"device-b": 4})),
        );
        assert_eq!(
            apply_inbound_on(conn, &day, 3, Some("device-a"))?,
            ApplyOutcome::Applied
        );
        Ok(())
    })
    .unwrap();
    pull_tombstones_at(&db, &[FOREIGN], Some(json!({"device-b": 3}))).await;

    let report = journal_day_merge::drain(&db, &bodies_for(&db, &[]), "device-a")
        .await
        .unwrap();

    assert_eq!(report.settled, vec![FOREIGN.to_owned()]);
    let tags = db.call_blocking(|conn| Ok(day_tags(conn))).unwrap();
    assert_eq!(tags, vec!["a", "b", "c"]);
}

/// A live blank `F` whose only content is a tag added offline: `j<D>`
/// displaces it and no tombstone comes. A tag the day lacks merges `F` with
/// no body to fold, and `F` is tombstoned like any merged id. With every tag
/// already in the day, `F` is forgotten and not tombstoned (#5699).
#[tokio::test]
async fn a_live_blank_holder_brings_its_offline_tag_to_the_day() {
    for (tags_of_day, expected, tombstoned) in [
        (vec!["a"], vec!["a", "c"], true),
        (vec!["a", "C"], vec!["a", "C"], false),
    ] {
        let db = scratch_db("live-holder-blank-tags");
        db.call_blocking(move |conn| {
            let held = record(FOREIGN, &tagged_payload("", &["a"], json!({"device-b": 2})));
            sync_items::apply_remote(conn, &held, 1)?;
            let tags = ["a", "c"].map(str::to_owned);
            metadata::set_tags(conn, DATE, &tags, "device-a", 2)?;
            let day = record(
                CANONICAL,
                &tagged_payload("", &tags_of_day, json!({"device-c": 1})),
            );
            assert_eq!(
                apply_inbound_on(conn, &day, 3, Some("device-a"))?,
                ApplyOutcome::Applied
            );
            Ok(())
        })
        .unwrap();

        let report = journal_day_merge::drain(&db, &bodies_for(&db, &[None]), "device-a")
            .await
            .unwrap();

        assert_eq!(report.settled, vec![FOREIGN.to_owned()]);
        db.call_blocking(move |conn| {
            assert_eq!(day_tags(conn), expected);
            let deletes = outbox(conn)
                .iter()
                .filter(|row| row.0 == FOREIGN && row.1 == "delete")
                .count();
            assert_eq!(deletes, usize::from(tombstoned));
            if tombstoned {
                assert_eq!(upserts_of(conn, FOREIGN), 0, "the tombstone replaces it");
            }
            assert!(journal_day_merge::owed(conn)?.is_empty());
            Ok(())
        })
        .unwrap();
    }
}

/// Desktop B merged `F`, then the user removed `b` from the day before B
/// pushed. Desktop's queue coalesces the edit into the queued `j<D>`, ahead
/// of `F`'s delete, so `j<D>` without `b` arrives first and displaces the
/// holder, and every holder tag counts until a tombstone. The tombstone's
/// weighing replaces that list: `b` stays removed and the body still folds
/// (#5659).
#[tokio::test]
async fn a_tag_removed_before_the_day_arrived_ahead_of_the_tombstone_stays_removed() {
    let db = scratch_db("holder-day-first-removed");
    db.call_blocking(|conn| {
        hold_foreign_tagged(conn, &["a", "b"])?;
        let day = record(
            CANONICAL,
            &tagged_payload("", &["a"], json!({"device-b": 4})),
        );
        assert_eq!(
            apply_inbound_on(conn, &day, 3, Some("device-a"))?,
            ApplyOutcome::Applied
        );
        Ok(())
    })
    .unwrap();
    pull_tombstones_at(&db, &[FOREIGN], Some(json!({"device-b": 3}))).await;

    let report = journal_day_merge::drain(&db, &bodies_for(&db, &[]), "device-a")
        .await
        .unwrap();

    assert_eq!(report.settled, vec![FOREIGN.to_owned()]);
    db.call_blocking(|conn| {
        assert_eq!(day_tags(conn), vec!["a"]);
        assert_eq!(text_of(conn, CANONICAL), "held");
        Ok(())
    })
    .unwrap();
}

/// `F` held as pulled at `{device-b: 2}`, with a body, as a pre-fix install
/// projected it.
fn hold_foreign_tagged(conn: &mut Connection, held_tags: &[&str]) -> Result<(), StorageError> {
    let held = record(
        FOREIGN,
        &tagged_payload("", held_tags, json!({"device-b": 2})),
    );
    sync_items::apply_remote(conn, &held, 1)?;
    update_log::append_local_update(conn, FOREIGN, &text_update(7, "held"), 1).map_err(|e| {
        StorageError::Failed {
            what: e.to_string(),
        }
    })?;
    Ok(())
}

fn upsert_ids(conn: &Connection, id: &str) -> Result<Vec<i64>, StorageError> {
    let mut statement = conn
        .prepare("SELECT id FROM outbox WHERE item_id = ?1 AND op = 'upsert'")
        .map_err(failed)?;
    statement
        .query_map(params![id], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<Vec<i64>, _>>()
        .map_err(failed)
}

/// B's tombstone for `F`, then B's `j<D>` with `day_tags`, then the drain.
async fn delete_merge_and_drain(db: &Db, tombstone: Json, tags_of_day: &[&str]) -> Vec<String> {
    pull_tombstones_at(db, &[FOREIGN], Some(tombstone)).await;
    let day = record(
        CANONICAL,
        &tagged_payload("", tags_of_day, json!({"device-b": 4})),
    );
    db.call_blocking(move |conn| {
        assert_eq!(
            apply_inbound_on(conn, &day, 3, Some("device-a"))?,
            ApplyOutcome::Applied
        );
        Ok(())
    })
    .unwrap();
    let report = journal_day_merge::drain(db, &bodies_for(db, &[]), "device-a")
        .await
        .unwrap();
    assert_eq!(report.settled, vec![FOREIGN.to_owned()]);
    db.call_blocking(|conn| {
        assert_eq!(text_of(conn, CANONICAL), "held");
        Ok(day_tags(conn))
    })
    .unwrap()
}

/// This device pushed `c` while B merged `F`: the server took the upsert,
/// then B's tombstone, clocked before it, replaced it. An ack does not mean
/// the deleting device saw the tag, so the tombstone's clock decides
/// (REVIEW-5656): `c` goes in. A push B did see, B merged, and B's removal
/// of `c` from the day stands.
#[tokio::test]
async fn a_deleted_merge_keeps_a_pushed_tag_the_deleting_device_never_saw() {
    for (tombstone, expected) in [
        (json!({"device-b": 3}), vec!["a", "b", "c"]),
        (json!({"device-b": 3, "device-a": 1}), vec!["a", "b"]),
    ] {
        let db = scratch_db("holder-acked-tags");
        db.call_blocking(|conn| {
            hold_foreign_tagged(conn, &["a", "b"])?;
            let tags = ["a", "b", "c"].map(str::to_owned);
            metadata::set_tags(conn, DATE, &tags, "device-a", 2)?;
            let ids = upsert_ids(conn, FOREIGN)?;
            assert_eq!(memry_core::sync::outbox::ack(conn, &ids)?, 1);
            Ok(())
        })
        .unwrap();

        let label = tombstone.to_string();
        assert_eq!(
            delete_merge_and_drain(&db, tombstone, &["a", "b"]).await,
            expected,
            "tombstone {label}"
        );
    }
}

/// `t` is removed here and pushed, then an older build, which keeps no tags,
/// adds it back offline. B saw the removal and merged the day without `t`,
/// so `t` goes in. Pushed by this build, the ack drops the tags kept before
/// the removal. Pushed by an older build, they are still kept, and B's clock,
/// past the edit they precede, rules them out.
#[tokio::test]
async fn a_deleted_merge_keeps_a_tag_an_older_build_added_back_after_a_push() {
    for this_build_pushed in [true, false] {
        let db = scratch_db("holder-downgrade-tags");
        db.call_blocking(move |conn| {
            hold_foreign_tagged(conn, &["a", "t"])?;
            metadata::set_tags(conn, DATE, &["a".to_owned()], "device-a", 2)?;
            let ids = upsert_ids(conn, FOREIGN)?;
            if this_build_pushed {
                memry_core::sync::outbox::ack(conn, &ids)?;
            } else {
                conn.execute("DELETE FROM outbox WHERE id = ?1", params![ids[0]])
                    .map_err(failed)?;
            }
            // The older build's edit: its payload and its upsert, no tags kept.
            let clock = json!({"device-a": 2, "device-b": 2});
            conn.execute(
                "UPDATE sync_items SET payload = ?2, clock = ?3
                  WHERE item_type = 'journal' AND item_id = ?1",
                params![
                    FOREIGN,
                    tagged_payload("", &["a", "t"], clock.clone()),
                    clock.to_string()
                ],
            )
            .map_err(failed)?;
            conn.execute(
                "INSERT INTO outbox (item_type, item_id, op, enqueued_at)
                 VALUES ('journal', ?1, 'upsert', 3)",
                params![FOREIGN],
            )
            .map_err(failed)?;
            Ok(())
        })
        .unwrap();

        let tombstone = json!({"device-b": 3, "device-a": 1});
        assert_eq!(
            delete_merge_and_drain(&db, tombstone, &["a"]).await,
            vec!["a", "t"],
            "pushed by this build: {this_build_pushed}"
        );
    }
}
