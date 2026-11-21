//! The push wave under the driver's shared CRDT admission (`with_crdt_pacing`,
//! `crdt-push-admission.ts`), against a scripted HTTP server on a paused clock.
//!
//! - A `429` holds every document's rows untouched and sends nothing more until
//!   its `Retry-After` has passed; then the rows go, are acked, and each stored
//!   document asks for a snapshot.
//! - While a cooldown holds, the wave seals no CRDT row and skips every
//!   document, so the record rows behind them still go.

#[allow(unused_imports)]
use crate::http_fakes;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use http_fakes::{FakeTransport, response, response_with_header};
use memry_core::api::errors::{ApiError, StorageError};
use memry_core::crdt::snapshot_cadence::SnapshotRequests;
use memry_core::protocol::envelope::EnvelopeError;
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::admission::CrdtAdmission;
use memry_core::sync::outbox::{self, Change};
use memry_core::sync::push::{PendingRecord, PushCoordinator, PushSealer};
use serde_json::{Value as Json, json};

/// Passes updates through and counts every CRDT seal.
#[derive(Default)]
struct Counting(AtomicUsize);

impl PushSealer for Counting {
    fn seal_record(&self, item: &PendingRecord) -> Result<Json, EnvelopeError> {
        Ok(json!({ "id": item.row.item_id, "type": item.row.item_type }))
    }

    fn seal_crdt_update(&self, _doc_id: &str, update: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(update.to_vec())
    }
}

struct Rig {
    db: Db,
    transport: Arc<FakeTransport>,
    sealer: Arc<Counting>,
    admission: Arc<CrdtAdmission>,
    requests: Arc<SnapshotRequests>,
    push: PushCoordinator,
}

fn rig(
    script: Vec<
        Result<memry_core::seams::transport::HttpResponse, memry_core::api::errors::TransportError>,
    >,
) -> Rig {
    let dir = tempfile::Builder::new()
        .prefix("memry-crdt-pacing-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    let db = open_data(&dir.join("data.db")).expect("open data.db");
    let transport = FakeTransport::new(script);
    let sealer = Arc::new(Counting::default());
    let admission = Arc::new(CrdtAdmission::default());
    let requests = Arc::new(SnapshotRequests::default());
    let http = HttpClient::new(
        transport.clone(),
        "https://sync.example",
        ClientIdentity::new("desktop", "1.2.3").expect("a valid identity"),
    );
    let push = PushCoordinator::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        sealer.clone(),
    )
    .with_crdt_pacing(Arc::clone(&admission), Arc::clone(&requests));
    Rig {
        db,
        transport,
        sealer,
        admission,
        requests,
        push,
    }
}

fn queue_update(db: &Db, doc_id: &str) {
    let doc_id = doc_id.to_owned();
    db.call_blocking(move |conn| {
        outbox::commit(
            conn,
            &Change::crdt_update("note", &doc_id, vec![7u8; 16]),
            1,
            |_| Ok::<(), StorageError>(()),
        )?;
        Ok(())
    })
    .expect("queue");
}

/// `(item_id, attempt_count, last_error, next_attempt_at)` of every queued row.
/// The documents `note_body_sync` holds a row for.
fn body_sync(db: &Db) -> Vec<String> {
    db.call_blocking(|conn| {
        let mut statement = conn
            .prepare("SELECT note_id FROM note_body_sync ORDER BY note_id")
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?;
        let ids = statement
            .query_map([], |row| row.get(0))
            .and_then(Iterator::collect)
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?;
        Ok(ids)
    })
    .expect("note_body_sync")
}

fn rows(db: &Db) -> Vec<(String, i64, Option<String>, Option<i64>)> {
    db.call_blocking(|conn| {
        let failed = |e: rusqlite::Error| StorageError::Failed {
            what: e.to_string(),
        };
        let mut statement = conn
            .prepare(
                "SELECT item_id, attempt_count, last_error, next_attempt_at FROM outbox ORDER BY id",
            )
            .map_err(failed)?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
            .map_err(failed)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(failed)?;
        Ok(rows)
    })
    .expect("read the outbox")
}

fn rate_limited(seconds: u64) -> ApiError {
    ApiError::RateLimited {
        retry_after_s: Some(seconds),
        message: "slow down".to_owned(),
    }
}

#[tokio::test(start_paused = true)]
async fn a_429_holds_every_document_until_its_retry_after_then_acks_and_requests_snapshots() {
    let rig = rig(vec![response_with_header(
        429,
        r#"{"error":{"code":"RATE_LIMITED","message":"slow down"}}"#,
        ("retry-after", "7"),
    )]);
    queue_update(&rig.db, "doc-a");
    queue_update(&rig.db, "doc-b");
    let before = rows(&rig.db);

    let failed = rig.push.drain_wave().await;
    assert!(failed.is_err(), "the 429 fails the wave");
    assert_eq!(rows(&rig.db), before, "both documents' rows untouched");
    // Marked sent after admission: a mark moved above it would stamp doc-b, never sent.
    assert_eq!(body_sync(&rig.db), ["doc-a"]);
    // Still cooling down: the next wave sends nothing.
    rig.push.drain_wave().await.expect("a wave that skips");
    assert_eq!(rig.transport.calls_to("/sync/crdt/updates").len(), 1);
    assert_eq!(rows(&rig.db), before);
    assert!(rig.requests.take_all().is_empty(), "nothing was stored");

    tokio::time::sleep(Duration::from_secs(7)).await;
    assert!(
        rig.admission.take_resume(),
        "the end of the cooldown asks for a push"
    );
    rig.transport.push(response(200, r#"{"sequences":[1]}"#));
    rig.transport.push(response(200, r#"{"sequences":[2]}"#));
    rig.push.drain_wave().await.expect("the wave");

    assert!(rows(&rig.db).is_empty(), "both acked");
    assert_eq!(rig.transport.calls_to("/sync/crdt/updates").len(), 3);
    let mut requested = rig.requests.take_all();
    requested.sort();
    assert_eq!(requested, ["doc-a", "doc-b"]);
}

#[tokio::test(start_paused = true)]
async fn a_cooldown_seals_no_document_and_the_record_rows_still_go() {
    let rig = rig(vec![response(
        200,
        r#"{"accepted":["task-1"],"rejected":[],"serverTime":1,"maxCursor":1}"#,
    )]);
    for doc in 0..60 {
        queue_update(&rig.db, &format!("doc-{doc:02}"));
    }
    rig.db
        .call_blocking(|conn| {
            conn.execute(
                "INSERT INTO sync_items (item_type, item_id, payload, payload_state, clock, updated_at)
                 VALUES ('task', 'task-1', '{}', 'full', '{\"device-a\":1}', 1)",
                [],
            )
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?;
            conn.execute(
                "INSERT INTO outbox (item_type, item_id, op, enqueued_at) VALUES ('task', 'task-1', 'upsert', 1)",
                [],
            )
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?;
            Ok(())
        })
        .expect("queue the task");
    rig.admission.note(&rate_limited(30));

    rig.push.drain_wave().await.expect("the wave");

    assert_eq!(rig.sealer.0.load(Ordering::SeqCst), 0, "no CRDT row sealed");
    assert!(body_sync(&rig.db).is_empty(), "no document marked sent");
    assert!(rig.transport.calls_to("/sync/crdt/updates").is_empty());
    assert_eq!(rig.transport.calls_to("/sync/push").len(), 1);
    let left = rows(&rig.db);
    assert_eq!(left.len(), 60, "only the task was acked");
    assert!(
        left.iter()
            .all(|(id, attempts, error, at)| id.starts_with("doc-")
                && *attempts == 0
                && error.is_none()
                && at.is_none()),
        "{left:?}"
    );
}
