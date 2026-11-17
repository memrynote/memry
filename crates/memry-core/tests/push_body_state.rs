//! What the push wave records about a note's body (`note_body_sync`, #2647),
//! Electron's `note-body-outbox.ts:259,302-323` through `recordNoteBodyPush`.
//!
//! Real SQLite and `HttpClient` over a scripted transport; the sealer passes
//! the update through.

#[allow(unused_imports)]
use crate::http_fakes;

use std::sync::Arc;

use http_fakes::{FakeTransport, response};
use memry_core::api::errors::{ApiError, StorageError};
use memry_core::crdt::snapshot_cadence::SnapshotRequests;
use memry_core::protocol::crdt_envelope::MAX_UPDATE_PAYLOAD_CHARS;
use memry_core::protocol::envelope::EnvelopeError;
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::admission::CrdtAdmission;
use memry_core::sync::hardening::body_state::{Pushes, pushes_of};
use memry_core::sync::outbox::{self, Change};
use memry_core::sync::push::{
    PendingRecord, PushCoordinator, PushSealer, SnapshotFallback, SnapshotFallbackOutcome,
};
use serde_json::{Value as Json, json};

struct Passthrough;

impl PushSealer for Passthrough {
    fn seal_record(&self, _item: &PendingRecord) -> Result<Json, EnvelopeError> {
        unreachable!("CRDT rows only")
    }

    fn seal_crdt_update(&self, _doc_id: &str, update: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        Ok(update.to_vec())
    }
}

/// Fails every update the way a key that cannot seal does: the row retires.
struct Unsealable;

impl PushSealer for Unsealable {
    fn seal_record(&self, _item: &PendingRecord) -> Result<Json, EnvelopeError> {
        unreachable!("CRDT rows only")
    }

    fn seal_crdt_update(&self, _doc_id: &str, _update: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        Err(EnvelopeError::SignatureInvalid)
    }
}

struct Answer(SnapshotFallbackOutcome);

#[async_trait::async_trait]
impl SnapshotFallback for Answer {
    async fn push_snapshot(&self, _doc_id: &str) -> Result<SnapshotFallbackOutcome, ApiError> {
        Ok(self.0.clone())
    }
}

fn scratch_db() -> Db {
    let dir = tempfile::Builder::new()
        .prefix("memry-body-state-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn queue(db: &Db, doc_id: &str, bytes: usize) {
    let doc_id = doc_id.to_owned();
    db.call_blocking(move |conn| {
        outbox::commit(
            conn,
            &Change::crdt_update("note", &doc_id, vec![7u8; bytes]),
            1,
            |_| Ok::<(), StorageError>(()),
        )?;
        Ok(())
    })
    .expect("queue");
}

fn pushes(db: &Db) -> Pushes {
    db.call_blocking(|conn| pushes_of(conn, "n1"))
        .expect("read note_body_sync")
        .expect("a row for n1")
}

fn outbox_rows(db: &Db) -> i64 {
    db.call_blocking(|conn| {
        conn.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })
    })
    .expect("count the outbox")
}

fn coordinator(
    db: &Db,
    transport: Arc<FakeTransport>,
    sealer: Arc<dyn PushSealer>,
) -> PushCoordinator {
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("desktop", "1.2.3").expect("a valid identity"),
    );
    PushCoordinator::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        sealer,
    )
}

#[tokio::test]
async fn a_stored_update_records_its_send_and_its_confirmation() {
    let db = scratch_db();
    queue(&db, "n1", 16);
    let transport = FakeTransport::new(vec![response(200, &json!({"sequences": [1]}).to_string())]);

    coordinator(&db, transport, Arc::new(Passthrough))
        .drain_wave()
        .await
        .expect("the wave");

    let row = pushes(&db);
    let (sent, confirmed) = (row.sent.expect("sent"), row.confirmed.expect("confirmed"));
    assert!(sent <= confirmed);
    assert_eq!((row.failed, row.rejected, row.snapshot), (None, None, None));
    assert_eq!(outbox_rows(&db), 0);
}

#[tokio::test]
async fn a_refused_request_records_a_failure_and_keeps_the_rows() {
    let db = scratch_db();
    queue(&db, "n1", 16);
    let transport = FakeTransport::new(vec![response(
        400,
        &json!({"error": {"code": "VALIDATION_ERROR", "message": "no"}}).to_string(),
    )]);

    let wave = coordinator(&db, transport, Arc::new(Passthrough))
        .drain_wave()
        .await;

    assert!(wave.is_err());
    let row = pushes(&db);
    assert!(row.sent.is_some() && row.failed.is_some());
    assert_eq!(row.confirmed, None);
    assert_eq!(outbox_rows(&db), 1);
}

#[tokio::test]
async fn a_dropped_row_records_a_refusal_and_asks_for_a_snapshot() {
    let db = scratch_db();
    queue(&db, "n1", 16);
    let requests = Arc::new(SnapshotRequests::default());

    coordinator(&db, FakeTransport::new(vec![]), Arc::new(Unsealable))
        .with_crdt_pacing(Arc::new(CrdtAdmission::default()), Arc::clone(&requests))
        .drain_wave()
        .await
        .expect("the wave");

    assert!(pushes(&db).rejected.is_some());
    assert_eq!(requests.take_all(), vec!["n1".to_owned()]);
    assert_eq!(outbox_rows(&db), 0);
}

#[tokio::test]
async fn a_refusal_that_cannot_be_recorded_keeps_the_row_until_it_can() {
    let db = scratch_db();
    queue(&db, "n1", 16);
    let exec = |sql: &'static str| {
        db.call_blocking(move |conn| {
            conn.execute_batch(sql).map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })
        })
        .expect(sql);
    };
    exec(
        "CREATE TRIGGER no_body_state BEFORE INSERT ON note_body_sync
         BEGIN SELECT RAISE(ABORT, 'note_body_sync is not writable'); END",
    );

    let wave = coordinator(&db, FakeTransport::new(vec![]), Arc::new(Unsealable))
        .drain_wave()
        .await;
    assert!(wave.is_err(), "the refusal could not be recorded");
    assert_eq!(outbox_rows(&db), 1, "the row waits with its refusal");

    exec("DROP TRIGGER no_body_state");
    coordinator(&db, FakeTransport::new(vec![]), Arc::new(Unsealable))
        .drain_wave()
        .await
        .expect("the wave");
    assert!(pushes(&db).rejected.is_some());
    assert_eq!(outbox_rows(&db), 0);
}

#[tokio::test]
async fn an_oversized_update_records_the_snapshot_that_carried_it_or_the_failure() {
    let oversized = MAX_UPDATE_PAYLOAD_CHARS / 4 * 3 + 3;

    let db = scratch_db();
    queue(&db, "n1", oversized);
    coordinator(&db, FakeTransport::new(vec![]), Arc::new(Passthrough))
        .with_snapshot_fallback(Arc::new(Answer(SnapshotFallbackOutcome::Pushed)))
        .drain_wave()
        .await
        .expect("the wave");
    let row = pushes(&db);
    assert!(row.snapshot.is_some() && row.confirmed == row.snapshot);

    let db = scratch_db();
    queue(&db, "n1", oversized);
    coordinator(&db, FakeTransport::new(vec![]), Arc::new(Passthrough))
        .with_snapshot_fallback(Arc::new(Answer(SnapshotFallbackOutcome::Transient(
            "a pull is owed".to_owned(),
        ))))
        .drain_wave()
        .await
        .expect("the wave");
    let row = pushes(&db);
    assert!(row.failed.is_some());
    assert_eq!((row.confirmed, row.snapshot), (None, None));
    assert_eq!(outbox_rows(&db), 1);
}
