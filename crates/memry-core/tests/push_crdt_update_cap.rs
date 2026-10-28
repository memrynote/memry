//! The per-update cap of the incremental route, chapter 07 §7.4.2, at the
//! push coordinator: where the line sits, and what each side of it does.
//!
//! Real SQLite and `HttpClient`; the sealer passes the update through (so the
//! base64 length is exact) and the snapshot seam is the one the coordinator
//! defines. The end-to-end path through `sync_now` is in
//! `api_sync_oversized_update.rs`.

mod http_fakes;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use http_fakes::{FakeTransport, response};
use memry_core::api::errors::{ApiError, StorageError};
use memry_core::protocol::crdt_envelope::MAX_UPDATE_PAYLOAD_CHARS;
use memry_core::protocol::envelope::EnvelopeError;
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::outbox::{self, Change};
use memry_core::sync::push::{
    PendingRecord, PushCoordinator, PushSealer, SnapshotFallback, SnapshotFallbackOutcome,
};
use serde_json::{Value as Json, json};

/// Seals nothing: the packed bytes are the update, so base64 length is exact.
struct Passthrough;

impl PushSealer for Passthrough {
    fn seal_record(&self, _item: &PendingRecord) -> Result<Json, EnvelopeError> {
        unreachable!("CRDT rows only")
    }

    fn seal_crdt_update(&self, _doc_id: &str, update: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        Ok(update.to_vec())
    }
}

/// A sealer whose update is past the cap the sealer itself enforces.
struct TooLarge;

impl PushSealer for TooLarge {
    fn seal_record(&self, _item: &PendingRecord) -> Result<Json, EnvelopeError> {
        unreachable!("CRDT rows only")
    }

    fn seal_crdt_update(&self, _doc_id: &str, _update: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        Err(EnvelopeError::ItemTooLarge {
            bytes: 11 * 1024 * 1024,
            max_bytes: 10 * 1024 * 1024,
        })
    }
}

/// A seam that fails the way a dead network or a policy block does.
struct Offline;

#[async_trait::async_trait]
impl SnapshotFallback for Offline {
    async fn push_snapshot(&self, _doc_id: &str) -> Result<SnapshotFallbackOutcome, ApiError> {
        Err(ApiError::WritesDisabled {
            message: "writes are off".to_owned(),
        })
    }
}

struct Spy {
    docs: Mutex<Vec<String>>,
    answer: SnapshotFallbackOutcome,
    /// How long the second call takes, so a short retry delay can run out
    /// while the wave is still going.
    second_call_takes: std::time::Duration,
}

#[async_trait::async_trait]
impl SnapshotFallback for Spy {
    async fn push_snapshot(&self, doc_id: &str) -> Result<SnapshotFallbackOutcome, ApiError> {
        let call = {
            let mut docs = self.docs.lock().unwrap();
            docs.push(doc_id.to_owned());
            docs.len()
        };
        if call == 2 {
            tokio::time::sleep(self.second_call_takes).await;
        }
        Ok(self.answer.clone())
    }
}

fn spy(answer: SnapshotFallbackOutcome) -> Arc<Spy> {
    Arc::new(Spy {
        docs: Mutex::new(Vec::new()),
        answer,
        second_call_takes: std::time::Duration::ZERO,
    })
}

fn scratch_db() -> Db {
    let dir: PathBuf = tempfile::Builder::new()
        .prefix("memry-update-cap-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

/// Queues one update of `bytes` bytes, whose base64 is `4 * ceil(bytes / 3)`.
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

fn left(db: &Db) -> Vec<(i64, Option<String>)> {
    db.call_blocking(|conn| {
        let mut statement = conn
            .prepare("SELECT attempt_count, last_error FROM outbox ORDER BY id")
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?;
        Ok(rows)
    })
    .expect("read the outbox")
}

fn coordinator(db: &Db, transport: Arc<FakeTransport>) -> PushCoordinator {
    coordinator_sealing(db, transport, Arc::new(Passthrough))
}

fn coordinator_sealing(
    db: &Db,
    transport: Arc<FakeTransport>,
    sealer: Arc<dyn PushSealer>,
) -> PushCoordinator {
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    PushCoordinator::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        sealer,
    )
}

fn next_attempts(db: &Db) -> Vec<Option<i64>> {
    db.call_blocking(|conn| {
        let mut statement = conn
            .prepare("SELECT next_attempt_at FROM outbox ORDER BY id")
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?;
        Ok(rows)
    })
    .expect("read the retry times")
}

fn age(db: &Db, attempts: i64) {
    db.call_blocking(move |conn| {
        conn.execute("UPDATE outbox SET attempt_count = ?1", [attempts])
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?;
        Ok(())
    })
    .expect("age the row");
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// 900,000 bytes is exactly 1,200,000 characters of base64.
const AT_THE_CAP: usize = MAX_UPDATE_PAYLOAD_CHARS / 4 * 3;

#[tokio::test]
async fn an_update_at_the_cap_rides_the_incremental_route() {
    let db = scratch_db();
    queue(&db, "n1", AT_THE_CAP);
    let transport = FakeTransport::new(vec![response(200, &json!({"sequences": [1]}).to_string())]);
    let snapshots = spy(SnapshotFallbackOutcome::Pushed);

    let report = coordinator(&db, transport.clone())
        .with_snapshot_fallback(snapshots.clone())
        .drain_wave()
        .await
        .expect("the wave");

    assert_eq!(report.crdt_updates, 1);
    assert!(
        snapshots.docs.lock().unwrap().is_empty(),
        "no snapshot at the cap"
    );
    assert_eq!(transport.calls_to("/sync/crdt/updates").len(), 1);
    assert!(left(&db).is_empty());
}

#[tokio::test]
async fn one_character_past_the_cap_goes_as_a_snapshot_and_acks_the_whole_batch() {
    let db = scratch_db();
    queue(&db, "n1", 100);
    queue(&db, "n1", AT_THE_CAP + 1);
    // No script: any request to the updates route would panic.
    let transport = FakeTransport::new(vec![]);
    let snapshots = spy(SnapshotFallbackOutcome::Pushed);

    let report = coordinator(&db, transport.clone())
        .with_snapshot_fallback(snapshots.clone())
        .drain_wave()
        .await
        .expect("the wave");

    assert_eq!(*snapshots.docs.lock().unwrap(), vec!["n1".to_owned()]);
    assert_eq!(
        report.crdt_updates, 2,
        "the small row rides the snapshot too"
    );
    assert_eq!(
        transport.call_count(),
        0,
        "nothing went to the updates route"
    );
    assert!(left(&db).is_empty());
}

#[tokio::test]
async fn a_refused_snapshot_defers_every_row_and_never_retires_one() {
    let db = scratch_db();
    queue(&db, "n1", 100);
    queue(&db, "n1", AT_THE_CAP + 1);
    let transport = FakeTransport::new(vec![]);
    let snapshots = spy(SnapshotFallbackOutcome::Transient(
        "the document owes a pull".to_owned(),
    ));

    let report = coordinator(&db, transport)
        .with_snapshot_fallback(snapshots)
        .drain_wave()
        .await
        .expect("the wave");

    assert_eq!((report.rejected, report.retired), (2, 0));
    let rows = left(&db);
    assert_eq!(rows.len(), 2, "both rows stay queued");
    assert!(rows.iter().all(|(attempts, reason)| *attempts == 1
        && reason.as_deref() == Some("the document owes a pull")));
}

#[tokio::test]
async fn without_a_snapshot_seam_an_oversized_row_is_deferred_and_the_queue_still_drains() {
    let db = scratch_db();
    queue(&db, "big", AT_THE_CAP + 1);
    queue(&db, "small", 100);
    let transport = FakeTransport::new(vec![response(200, &json!({"sequences": [1]}).to_string())]);

    let report = coordinator(&db, transport.clone())
        .drain_wave()
        .await
        .expect("the wave");

    assert_eq!(report.crdt_updates, 1, "the small document went");
    assert_eq!(report.retired, 0);
    assert_eq!(left(&db).len(), 1, "the large row waits");
}

#[tokio::test]
async fn a_row_the_sealer_calls_too_large_is_deferred_and_not_retired() {
    let db = scratch_db();
    queue(&db, "n1", 100);
    let snapshots = spy(SnapshotFallbackOutcome::Transient("owes a pull".to_owned()));

    let report = coordinator_sealing(&db, FakeTransport::new(vec![]), Arc::new(TooLarge))
        .with_snapshot_fallback(snapshots.clone())
        .drain_wave()
        .await
        .expect("the wave");

    assert_eq!(report.retired, 0, "an oversized edit is never dropped");
    assert_eq!(*snapshots.docs.lock().unwrap(), vec!["n1".to_owned()]);
    assert_eq!(left(&db).len(), 1);
}

#[tokio::test]
async fn a_network_or_policy_error_from_the_snapshot_seam_fails_the_wave_and_touches_no_row() {
    let db = scratch_db();
    queue(&db, "n1", AT_THE_CAP + 1);

    let outcome = coordinator(&db, FakeTransport::new(vec![]))
        .with_snapshot_fallback(Arc::new(Offline))
        .drain_wave()
        .await;

    assert!(outcome.is_err(), "the wave reports it like any request");
    assert_eq!(
        left(&db),
        vec![(0, None)],
        "no attempt counted, nothing deferred"
    );
}

#[tokio::test]
async fn a_deferred_batch_waits_at_most_a_minute_however_many_attempts_it_has() {
    let db = scratch_db();
    queue(&db, "n1", AT_THE_CAP + 1);
    db.call_blocking(|conn| {
        conn.execute("UPDATE outbox SET attempt_count = 12", [])
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?;
        Ok(())
    })
    .expect("age the row");
    let snapshots = spy(SnapshotFallbackOutcome::Transient("owes a pull".to_owned()));
    let before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    coordinator(&db, FakeTransport::new(vec![]))
        .with_snapshot_fallback(snapshots)
        .drain_wave()
        .await
        .expect("the wave");

    let next: i64 = db
        .call_blocking(|conn| {
            conn.query_row("SELECT next_attempt_at FROM outbox", [], |row| row.get(0))
                .map_err(|e| StorageError::Failed {
                    what: e.to_string(),
                })
        })
        .expect("the retry time");
    assert!(
        next <= before + 60_000 + 5_000,
        "waits {} ms",
        next - before
    );
}

/// Each class waits as long as its kind of refusal does: a transient one at
/// most a minute, quota and per-document rejections on the full ladder, and a
/// parked one until the document changes.
#[tokio::test]
async fn each_class_waits_as_long_as_its_kind_of_refusal_does() {
    for (outcome, check) in [
        (
            SnapshotFallbackOutcome::Transient("pull owed".to_owned()),
            Box::new(|at: i64, now: i64| at <= now + 60_000 + 5_000)
                as Box<dyn Fn(i64, i64) -> bool>,
        ),
        (
            SnapshotFallbackOutcome::QuotaExceeded("quota".to_owned()),
            Box::new(|at, now| at > now + 3_600_000),
        ),
        (
            SnapshotFallbackOutcome::Rejected("refused".to_owned()),
            Box::new(|at, now| at > now + 3_600_000),
        ),
        (
            SnapshotFallbackOutcome::Parked("too large".to_owned()),
            Box::new(|at, _| at == outbox::PARKED_UNTIL_EDIT),
        ),
    ] {
        let db = scratch_db();
        queue(&db, "n1", AT_THE_CAP + 1);
        age(&db, 12);
        let before = now_ms();

        let report = coordinator(&db, FakeTransport::new(vec![]))
            .with_snapshot_fallback(spy(outcome.clone()))
            .drain_wave()
            .await
            .expect("the wave");

        assert_eq!((report.rejected, report.retired), (1, 0), "{outcome:?}");
        let at = next_attempts(&db)[0].expect("deferred");
        assert!(check(at, before), "{outcome:?} waits until {at}");
    }
}

#[tokio::test]
async fn a_parked_batch_is_released_by_the_next_edit_of_its_document() {
    let db = scratch_db();
    queue(&db, "n1", AT_THE_CAP + 1);
    queue(&db, "other", 100);
    coordinator(
        &db,
        FakeTransport::new(vec![response(200, &json!({"sequences": [1]}).to_string())]),
    )
    .with_snapshot_fallback(spy(SnapshotFallbackOutcome::Parked("too large".to_owned())))
    .drain_wave()
    .await
    .expect("the wave");
    assert_eq!(left(&db).len(), 1, "only the parked row is left");

    // An edit of another document does not release it; an edit of this one does.
    queue(&db, "other", 100);
    let batch = |db: &Db| {
        db.call_blocking(|conn| outbox::next_batch(conn, now_ms(), 100, &[]))
            .expect("a batch")
    };
    assert!(matches!(batch(&db), Some(outbox::Batch::Crdt { doc_id, .. }) if doc_id == "other"));
    db.call_blocking(|conn| outbox::ack(conn, &[3]).map(|_| ()))
        .expect("ack");
    assert!(batch(&db).is_none(), "still parked");
    queue(&db, "n1", 100);
    let Some(outbox::Batch::Crdt { doc_id, rows, .. }) = batch(&db) else {
        panic!("the edit releases the parked batch");
    };
    assert_eq!(
        (doc_id.as_str(), rows.len()),
        ("n1", 2),
        "in order, together"
    );
}

#[tokio::test]
async fn a_document_with_a_deferred_row_does_not_send_its_later_rows() {
    let db = scratch_db();
    queue(&db, "n1", AT_THE_CAP + 1);
    let snapshots = spy(SnapshotFallbackOutcome::Transient("pull owed".to_owned()));
    let push = coordinator(&db, FakeTransport::new(vec![])).with_snapshot_fallback(snapshots);
    push.drain_wave().await.expect("the first wave defers");

    // The later small row would ride /sync/crdt/updates, which has no script.
    queue(&db, "n1", 100);
    push.drain_wave()
        .await
        .expect("the second wave sends nothing");

    assert_eq!(
        left(&db).len(),
        2,
        "the later row waits behind the deferred one"
    );
}

/// A document whose batch was deferred is not tried again in the same wave,
/// even when its retry delay (2 s at the first attempt) runs out while the wave
/// is still going: one failed full-document upload per document per wave.
#[tokio::test]
async fn a_document_deferred_in_a_wave_is_not_tried_again_in_it() {
    let db = scratch_db();
    queue(&db, "a", AT_THE_CAP + 1);
    queue(&db, "b", AT_THE_CAP + 1);
    let snapshots = Arc::new(Spy {
        docs: Mutex::new(Vec::new()),
        answer: SnapshotFallbackOutcome::QuotaExceeded("quota".to_owned()),
        second_call_takes: std::time::Duration::from_millis(2_300),
    });

    coordinator(&db, FakeTransport::new(vec![]))
        .with_snapshot_fallback(snapshots.clone())
        .drain_wave()
        .await
        .expect("the wave");

    assert_eq!(*snapshots.docs.lock().unwrap(), ["a", "b"]);
}
