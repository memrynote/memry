//! The outbox, the push wave and client policy, against real adapters.
//!
//! Real `HttpClient`, real SQLite, real `sync_items` repository. The only
//! fakes are the two seams the core deliberately does not own: the
//! `Transport`, which is a foreign trait by construction (Constitution I),
//! and the sealer, whose key directory is a later task's. **Nothing here
//! reaches a network.**
//!
//! | Test                                      | Rule                                        |
//! | ----------------------------------------- | ------------------------------------------- |
//! | one transaction, and its order            | FR-030, data-model §A.2, §C.4               |
//! | an outbox row alone is refused            | FR-030                                      |
//! | a record row can never carry a payload    | chapter 06 §6.5.2 P2                        |
//! | the payload sent is the live row's        | chapter 06 §6.5.2 P2                        |
//! | a record enqueue supersedes               | data-model §A.2                             |
//! | a CRDT enqueue never coalesces            | data-model §A.2, T116                       |
//! | CRDT rows lead the wave                   | data-model §A.2, T117                       |
//! | halving holds its ceiling across waves    | chapter 05 §5.6                             |
//! | the three blocked states stay distinct    | chapter 11 §11.7.1, FR-035                  |
//! | a 402 demotes to `Unentitled`             | chapter 11 §11.7.1, chapter 00 §0.5         |

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use http_fakes::{FakeTransport, body_json, error_response, response};
use memry_core::api::errors::{ApiError, StorageError};
use memry_core::protocol::envelope::EnvelopeError;
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use memry_core::sync::outbox::{self, Batch, Change, OP_CRDT_UPDATE, RecordOp};
use memry_core::sync::policy::{PolicyTier, SYNC_PAYMENT_REQUIRED};
use memry_core::sync::push::{
    MIN_PUSH_BATCH_SIZE, PUSH_BATCH_SIZE, PendingRecord, PushCoordinator, PushSealer,
};
use memry_core::sync::state::WriteGate;
use rusqlite::params;
use serde_json::{Value as Json, json};

// ---------------------------------------------------------------- fixtures

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-outbox-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

/// Seeds a live `sync_items` row for a record the wave will rebuild from.
fn seed_item(db: &Db, item_type: &str, item_id: &str, payload: &str) {
    db.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
             VALUES (?1, ?2, ?3, 'full', 1)
             ON CONFLICT(item_type, item_id) DO UPDATE SET payload = excluded.payload",
            params![item_type, item_id, payload],
        )
        .map_err(|e| StorageError::Failed {
            what: e.to_string(),
        })?;
        Ok(())
    })
    .expect("seed the live row");
}

/// The three columns every assertion below reads back.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Queued {
    item_id: String,
    op: String,
    payload: Option<Vec<u8>>,
}

fn outbox_rows(db: &Db) -> Vec<Queued> {
    db.call_blocking(|conn| {
        let mut statement = conn
            .prepare("SELECT item_id, op, payload FROM outbox ORDER BY id")
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?;
        let rows = statement
            .query_map([], |row| {
                Ok(Queued {
                    item_id: row.get(0)?,
                    op: row.get(1)?,
                    payload: row.get(2)?,
                })
            })
            .and_then(Iterator::collect::<Result<Vec<_>, _>>)
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?;
        Ok(rows)
    })
    .expect("read the outbox")
}

/// A sealer that records the plaintext it was handed, so a test can assert
/// **which bytes** left the device rather than only that something did.
struct RecordingSealer {
    sealed: std::sync::Mutex<Vec<String>>,
    fail_with: Option<EnvelopeError>,
}

impl RecordingSealer {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            sealed: std::sync::Mutex::new(Vec::new()),
            fail_with: None,
        })
    }

    fn failing(error: EnvelopeError) -> Arc<Self> {
        Arc::new(Self {
            sealed: std::sync::Mutex::new(Vec::new()),
            fail_with: Some(error),
        })
    }

    fn sealed(&self) -> Vec<String> {
        self.sealed.lock().unwrap().clone()
    }
}

impl PushSealer for RecordingSealer {
    fn seal_record(&self, item: &PendingRecord) -> Result<Json, EnvelopeError> {
        if let Some(error) = &self.fail_with {
            return Err(error.clone());
        }
        let payload = item.row.payload.clone().unwrap_or_default();
        self.sealed.lock().unwrap().push(payload.clone());
        Ok(json!({
            "id": item.row.item_id,
            "type": item.row.item_type,
            "operation": item.operation.as_str(),
            // Stands in for the ciphertext. The envelope's bytes are chapter
            // 04's and are pinned by the `record-envelope` vector class; what
            // this test pins is *which plaintext* the wave chose.
            "encryptedData": payload,
        }))
    }

    fn seal_crdt_update(&self, doc_id: &str, update: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        self.sealed
            .lock()
            .unwrap()
            .push(format!("{doc_id}:{}", update.len()));
        Ok(update.to_vec())
    }
}

fn coordinator(
    db: Db,
    transport: Arc<FakeTransport>,
    sealer: Arc<dyn PushSealer>,
) -> PushCoordinator {
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    PushCoordinator::new(Arc::new(http), db, Declaration::subscribed(), sealer)
}

fn push_ok(accepted: &[&str]) -> String {
    json!({
        "accepted": accepted,
        "rejected": [],
        "serverTime": 1,
        "maxCursor": 1,
    })
    .to_string()
}

// ------------------------------------------------------- T116, the outbox

#[test]
fn the_source_row_and_the_outbox_row_commit_together_and_in_that_order() {
    let db = scratch_db("one-transaction");
    db.call_blocking(|conn| {
        let durable =
            outbox::commit(conn, &Change::upsert("note", "note-1"), 10, |tx| {
                // The source write runs first and sees its own row...
                tx.execute(
                    "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
                     VALUES ('note', 'note-1', '{\"title\":\"a\"}', 'full', 10)",
                    [],
                )
                .map_err(|e| StorageError::Failed { what: e.to_string() })?;
                // ...and the outbox row does not exist yet. This is the order
                // §C.4 states: the source write, then the enqueue, then one
                // commit, then the acknowledgement.
                let queued: i64 = tx
                    .query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))
                    .map_err(|e| StorageError::Failed {
                        what: e.to_string(),
                    })?;
                assert_eq!(queued, 0, "the outbox row must not precede its source row");
                Ok("acknowledged")
            })?;
        assert_eq!(durable.acknowledge(), "acknowledged");
        Ok(())
    })
    .expect("commit");

    assert_eq!(outbox_rows(&db).len(), 1);
    assert_eq!(
        db.call_blocking(|conn| sync_items::push_payload(conn, "note", "note-1"))
            .expect("read back"),
        Some(r#"{"title":"a"}"#.to_owned())
    );
}

#[test]
fn a_failed_source_write_leaves_no_outbox_row_and_no_acknowledgement() {
    let db = scratch_db("rollback");
    let outcome: Result<(), StorageError> =
        db.call_blocking(|conn| {
            outbox::commit(conn, &Change::upsert("note", "note-1"), 10, |tx| {
                tx.execute(
                "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
                 VALUES ('note', 'note-1', '{}', 'full', 10)",
                [],
            )
            .map_err(|e| StorageError::Failed { what: e.to_string() })?;
                Err::<(), _>(StorageError::Failed {
                    what: "the source write failed".to_owned(),
                })
            })
            .map(|_| ())
        });
    assert!(
        outcome.is_err(),
        "no `Durable` is minted for a failed write"
    );
    assert!(outbox_rows(&db).is_empty());
    assert_eq!(
        db.call_blocking(|conn| sync_items::load(conn, "note", "note-1"))
            .expect("read back"),
        None,
        "the source row rolled back with the outbox row"
    );
}

#[test]
fn an_outbox_row_outside_a_transaction_is_refused() {
    let db = scratch_db("autocommit");
    let refused = db.call_blocking(|conn| {
        Ok(outbox::enqueue(conn, &Change::upsert("note", "note-1"), 10).is_err())
    });
    assert_eq!(refused, Ok(true));
    assert!(outbox_rows(&db).is_empty());
}

#[test]
fn a_record_row_can_never_carry_a_payload_and_a_crdt_row_always_does() {
    let db = scratch_db("no-frozen-payload");
    db.call_blocking(|conn| {
        outbox::commit(conn, &Change::upsert("note", "n1"), 1, |_| Ok(()))?;
        outbox::commit(conn, &Change::delete("task", "t1"), 2, |_| Ok(()))?;
        outbox::commit(
            conn,
            &Change::crdt_update("note", "n1", vec![1, 2, 3]),
            3,
            |_| Ok(()),
        )?;
        Ok(())
    })
    .expect("enqueue");

    // The structural half of §6.5.2 P2: `Change::Record` has no payload
    // field, so there is no code path that puts bytes in this column for a
    // record row. This test fails the moment someone adds one.
    for row in outbox_rows(&db) {
        if row.op == OP_CRDT_UPDATE {
            assert_eq!(row.payload, Some(vec![1, 2, 3]));
        } else {
            assert_eq!(row.payload, None, "a frozen payload reintroduces §6.5.1 3c");
        }
    }
}

#[test]
fn a_record_enqueue_supersedes_and_a_crdt_enqueue_never_coalesces() {
    let db = scratch_db("supersede");
    db.call_blocking(|conn| {
        outbox::commit(conn, &Change::upsert("task", "t1"), 1, |_| Ok(()))?;
        // A row sitting in backoff is invisible to a per-id collapse and
        // would later re-push a stale payload, so the supersede is a delete
        // rather than a skip.
        conn.execute("UPDATE outbox SET next_attempt_at = 9999", [])
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?;
        outbox::commit(conn, &Change::delete("task", "t1"), 2, |_| Ok(()))?;

        outbox::commit(conn, &Change::crdt_update("note", "n1", vec![1]), 3, |_| {
            Ok(())
        })?;
        outbox::commit(conn, &Change::crdt_update("note", "n1", vec![2]), 4, |_| {
            Ok(())
        })?;
        Ok(())
    })
    .expect("enqueue");

    let rows = outbox_rows(&db);
    let records: Vec<_> = rows.iter().filter(|r| r.op != OP_CRDT_UPDATE).collect();
    assert_eq!(records.len(), 1, "a record enqueue supersedes");
    assert_eq!(records[0].op, RecordOp::Delete.as_str());
    let crdt: Vec<_> = rows.iter().filter(|r| r.op == OP_CRDT_UPDATE).collect();
    assert_eq!(
        crdt.len(),
        2,
        "collapsing CRDT rows drops updates a peer has not seen"
    );
}

#[test]
fn the_wave_leads_with_crdt_rows_grouped_by_document() {
    let db = scratch_db("wave-order");
    db.call_blocking(|conn| {
        outbox::commit(conn, &Change::upsert("task", "t1"), 1, |_| Ok(()))?;
        outbox::commit(conn, &Change::crdt_update("note", "n2", vec![9]), 2, |_| {
            Ok(())
        })?;
        outbox::commit(conn, &Change::delete("note", "n1"), 3, |_| Ok(()))?;
        outbox::commit(conn, &Change::crdt_update("note", "n1", vec![7]), 4, |_| {
            Ok(())
        })?;
        outbox::commit(conn, &Change::crdt_update("note", "n1", vec![8]), 5, |_| {
            Ok(())
        })?;
        Ok(())
    })
    .expect("enqueue");

    // A body edit must never land after its own note's delete, so both of
    // `n1`'s updates precede the record wave that carries `n1`'s delete.
    let first = db
        .call_blocking(|conn| outbox::next_batch(conn, 100, PUSH_BATCH_SIZE))
        .expect("a batch")
        .expect("a batch");
    match first {
        Batch::Crdt { doc_id, rows, .. } => {
            assert_eq!(doc_id, "n1");
            assert_eq!(rows.len(), 2, "one document's updates ride one batch");
        }
        other => panic!("CRDT rows lead the wave, got {other:?}"),
    }
}

// -------------------------------------------- T117, the payload at send time

/// A disk failure must not cross the `PushWave` boundary dressed as a network
/// one.
///
/// Before `ApiError::Storage` existed, `pending` and `drain` reported a failed
/// SQLite read as `Transport { Failed { "local storage: …" } }`. It landed in
/// the right state — the engine's `is_offline` matches only
/// `TransportError::Offline` — but it told every reader the network failed when
/// the disk did, and a caller could not tell "the server is unreachable" from
/// "this device cannot read its own database". Those want different things said
/// to the user.
#[tokio::test]
async fn a_local_storage_failure_is_reported_as_storage_and_not_as_transport() {
    let db = scratch_db("push-local-storage-error");
    // A table the outbox needs, removed underneath it: the same `rusqlite`
    // error path a constraint or a full disk produces.
    db.call_blocking(|conn| {
        conn.execute("DROP TABLE outbox", []).expect("drop outbox");
        Ok(())
    })
    .expect("drop");

    let coordinator = coordinator(db, FakeTransport::new(vec![]), RecordingSealer::new());
    let error = memry_core::sync::engine::PushWave::pending(&coordinator)
        .await
        .expect_err("a missing table must not read as an empty queue");

    assert!(
        matches!(error, ApiError::Storage { .. }),
        "a disk failure must be ApiError::Storage, got {error:?}"
    );
    assert!(
        !matches!(error, ApiError::Transport { .. }),
        "and must not be a transport error"
    );
}

#[tokio::test]
async fn the_wave_sends_the_live_row_not_the_row_as_it_stood_at_enqueue() {
    let db = scratch_db("live-row");
    seed_item(&db, "note", "n1", r#"{"title":"at enqueue"}"#);
    db.call_blocking(|conn| outbox::commit(conn, &Change::upsert("note", "n1"), 1, |_| Ok(())))
        .expect("enqueue");
    // The edit that lands between the enqueue and the send. §6.5.2 P2: an
    // outbox that froze the payload would ship "at enqueue" and reintroduce
    // §6.5.1's case-3c divergence deterministically.
    seed_item(&db, "note", "n1", r#"{"title":"after the enqueue"}"#);

    let transport = FakeTransport::new(vec![response(200, &push_ok(&["n1"]))]);
    let sealer = RecordingSealer::new();
    let push = coordinator(db.clone(), transport.clone(), sealer.clone());
    let report = push.drain_wave().await.expect("the wave");

    assert_eq!(sealer.sealed(), vec![r#"{"title":"after the enqueue"}"#]);
    assert_eq!(report.accepted, 1);
    assert!(outbox_rows(&db).is_empty(), "ack is delete, per id");

    let sent = body_json(&transport.calls_to("/sync/push")[0]);
    assert_eq!(
        sent["items"][0]["encryptedData"],
        json!(r#"{"title":"after the enqueue"}"#)
    );
}

#[tokio::test]
async fn a_rejected_item_stays_queued_and_a_replay_is_acked() {
    let db = scratch_db("rejections");
    for id in ["a", "b"] {
        seed_item(&db, "note", id, r#"{"title":"x"}"#);
        let id = id.to_owned();
        db.call_blocking(|conn| outbox::commit(conn, &Change::upsert("note", &id), 1, |_| Ok(())))
            .expect("enqueue");
    }

    let transport = FakeTransport::new(vec![response(
        200,
        &json!({
            "accepted": [],
            "rejected": [
                {"id": "a", "reason": "SYNC_REPLAY_DETECTED"},
                {"id": "b", "reason": "SYNC_INVALID_SIGNATURE"},
            ],
            "serverTime": 1,
            "maxCursor": 1,
        })
        .to_string(),
    )]);
    let push = coordinator(db.clone(), transport, RecordingSealer::new());
    let report = push.drain_wave().await.expect("the wave");

    // §5.7: the server already holds a row this one cannot improve on.
    assert_eq!(report.accepted, 1);
    assert_eq!(report.rejected, 1);
    let rows = outbox_rows(&db);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].item_id, "b");
    let attempts: i64 = db
        .call_blocking(|conn| {
            conn.query_row("SELECT attempt_count FROM outbox", [], |row| row.get(0))
                .map_err(|e| StorageError::Failed {
                    what: e.to_string(),
                })
        })
        .expect("attempt count");
    assert_eq!(attempts, 1, "a per-item rejection accrues one attempt");
}

#[tokio::test]
async fn an_unsealable_row_retires_rather_than_retrying_for_ever() {
    let db = scratch_db("retire");
    seed_item(&db, "note", "n1", r#"{"title":"x"}"#);
    db.call_blocking(|conn| outbox::commit(conn, &Change::upsert("note", "n1"), 1, |_| Ok(())))
        .expect("enqueue");

    // §A.2: a row rejected as too large retires forever. No request is made,
    // so the transport script is deliberately empty.
    let transport = FakeTransport::new(vec![]);
    let sealer = RecordingSealer::failing(EnvelopeError::ItemTooLarge {
        bytes: 9_000_000,
        max_bytes: 3_826_919,
    });
    let push = coordinator(db.clone(), transport.clone(), sealer);
    let report = push.drain_wave().await.expect("the wave");

    assert_eq!(report.retired, 1);
    assert_eq!(transport.call_count(), 0);
    assert!(outbox_rows(&db).is_empty(), "acked locally");
}

// ------------------------------------------------- T117, the halving ladder

#[tokio::test]
async fn a_5xx_halves_the_batch_and_the_reduced_size_is_a_ceiling_for_later_waves() {
    let db = scratch_db("halving");
    let ids = |prefix: &str| -> Vec<String> { (0..60).map(|n| format!("{prefix}{n}")).collect() };
    let seed = |queued: &[String], now: i64| {
        for id in queued {
            seed_item(&db, "note", id, r#"{"title":"x"}"#);
            db.call_blocking(|conn| {
                outbox::commit(conn, &Change::upsert("note", id), now, |_| Ok(()))
            })
            .expect("enqueue");
        }
    };
    let wave_one = ids("n");
    let wave_two = ids("x");
    let one: Vec<&str> = wave_one.iter().map(String::as_str).collect();
    let two: Vec<&str> = wave_two.iter().map(String::as_str).collect();

    let transport = FakeTransport::new(vec![
        // §5.6: Cloudflare terminates an oversized push at the edge with an
        // empty 503 body before any handler runs, so there is no per-item
        // verdict and an identical resend fails identically.
        response(503, ""),
        // Wave one, retried at the halved ceiling: 50, then the last 10.
        response(200, &push_ok(&one[..50])),
        response(200, &push_ok(&one[50..])),
        // Wave two, still capped at 50.
        response(200, &push_ok(&two[..50])),
        response(200, &push_ok(&two[50..])),
    ]);
    let push = coordinator(db.clone(), transport.clone(), RecordingSealer::new());

    seed(&wave_one, 1);
    let first = push.drain_wave().await.expect("wave one");
    assert_eq!(first.halvings, 1);
    assert_eq!(first.batch_ceiling, PUSH_BATCH_SIZE / 2);
    assert_eq!(first.accepted, 60);
    assert!(outbox_rows(&db).is_empty());

    let sent = transport.calls_to("/sync/push");
    assert_eq!(sent.len(), 3);
    assert_eq!(
        body_json(&sent[0])["items"].as_array().unwrap().len(),
        60,
        "the first attempt claims up to the full ceiling of 100"
    );
    assert_eq!(
        body_json(&sent[1])["items"].as_array().unwrap().len(),
        50,
        "the 5xx is answered by halving, never by resending the same batch"
    );
    assert_eq!(body_json(&sent[2])["items"].as_array().unwrap().len(), 10);

    // A second wave: the ceiling is still 50, so a fresh 60 rows cannot go
    // back out as one batch of 60.
    seed(&wave_two, 2);
    assert_eq!(push.batch_ceiling(), 50);
    let second = push.drain_wave().await.expect("wave two");
    assert_eq!(second.accepted, 60);
    assert_eq!(
        second.halvings, 1,
        "the ceiling is held, not re-derived from a second 5xx"
    );

    let all_sent = transport.calls_to("/sync/push");
    assert_eq!(all_sent.len(), 5);
    assert_eq!(
        body_json(&all_sent[3])["items"].as_array().unwrap().len(),
        50,
        "the reduced size is held as a ceiling for subsequent waves"
    );
    assert_eq!(
        body_json(&all_sent[4])["items"].as_array().unwrap().len(),
        10
    );
}

#[tokio::test]
async fn a_single_item_that_still_draws_a_5xx_fails_the_wave() {
    let db = scratch_db("halving-floor");
    seed_item(&db, "note", "n1", r#"{"title":"x"}"#);
    db.call_blocking(|conn| outbox::commit(conn, &Change::upsert("note", "n1"), 1, |_| Ok(())))
        .expect("enqueue");

    // 100 -> 50 -> 25 -> 12 -> 6 -> 3 -> 1, then nothing left to halve.
    let script: Vec<_> = (0..8).map(|_| response(503, "")).collect();
    let transport = FakeTransport::new(script);
    let push = coordinator(db.clone(), transport, RecordingSealer::new());
    let error = push.drain_wave().await.expect_err("the wave fails");
    assert!(error.to_string().contains("503"));
    assert_eq!(push.batch_ceiling(), MIN_PUSH_BATCH_SIZE);
    // §5.6 and §11.9: the row is still queued. A push is never retried
    // identically — that is how a duplicate lands — and no row is removed.
    assert_eq!(outbox_rows(&db).len(), 1);
}

#[tokio::test]
async fn a_blocked_policy_parks_without_touching_attempt_count() {
    let db = scratch_db("parked");
    seed_item(&db, "note", "n1", r#"{"title":"x"}"#);
    db.call_blocking(|conn| outbox::commit(conn, &Change::upsert("note", "n1"), 1, |_| Ok(())))
        .expect("enqueue");

    let transport = FakeTransport::new(vec![error_response(
        403,
        "PLATFORM_WRITES_DISABLED",
        "writes are off for ios",
    )]);
    let push = coordinator(db.clone(), transport, RecordingSealer::new());
    let error = push.drain_wave().await.expect_err("the wave parks");
    assert!(matches!(
        error,
        memry_core::sync::push::PushError::Api {
            source: ApiError::WritesDisabled { .. }
        }
    ));

    let attempts: i64 = db
        .call_blocking(|conn| {
            conn.query_row("SELECT attempt_count FROM outbox", [], |row| row.get(0))
                .map_err(|e| StorageError::Failed {
                    what: e.to_string(),
                })
        })
        .expect("attempt count");
    assert_eq!(
        attempts, 0,
        "§11.9: no attempt accrues backoff against a condition the user cannot fix"
    );
    assert_eq!(outbox_rows(&db).len(), 1, "no row removed");
}

// ------------------------------------------------------- T118, client policy

#[test]
fn the_three_write_blocked_states_never_collapse() {
    let tier = PolicyTier::new("1.0.0");
    assert_eq!(tier.gate(), WriteGate::Open);

    // Each source produces its own state, and only its own.
    let read_only = PolicyTier::new("1.0.0");
    read_only.learn(&json!({"clientPolicy": {"writesEnabled": false}}), 1);
    assert_eq!(read_only.gate(), WriteGate::ReadOnly);

    let blocked = PolicyTier::new("1.0.0");
    blocked.learn(&json!({"clientPolicy": {"minWriteVersion": "2.0.0"}}), 1);
    assert_eq!(
        blocked.gate(),
        WriteGate::BlockedUpgrade {
            min_version: Some("2.0.0".to_owned())
        }
    );

    let unentitled = PolicyTier::new("1.0.0");
    unentitled.observe(&ApiError::Status {
        status: 402,
        code: Some(SYNC_PAYMENT_REQUIRED.to_owned()),
        message: String::new(),
    });
    assert_eq!(unentitled.gate(), WriteGate::Unentitled);

    // Three states, three parked outboxes, no two equal.
    let gates = [read_only.gate(), blocked.gate(), unentitled.gate()];
    for gate in &gates {
        assert!(gate.blocked_state().is_some());
    }
    assert_ne!(gates[0], gates[1]);
    assert_ne!(gates[1], gates[2]);
    assert_ne!(gates[0], gates[2]);
}

#[test]
fn a_426_with_no_min_version_is_still_blocked_upgrade_and_not_read_only() {
    // §11.6 lets a server omit `minVersion`; folding that into the kill
    // switch would tell the user writes are off for the whole platform when
    // what they need is an update.
    let tier = PolicyTier::new("1.0.0");
    tier.observe(&ApiError::UpgradeRequired {
        min_version: None,
        message: "update".to_owned(),
    });
    assert_eq!(tier.gate(), WriteGate::BlockedUpgrade { min_version: None });

    // §11.9 rule 4: the next successful poll clears it, with no restart.
    tier.learn(&json!({"clientPolicy": {}}), 2);
    assert_eq!(tier.gate(), WriteGate::Open);
}

#[test]
fn entitlement_starts_present_and_only_a_402_takes_it_away() {
    let tier = PolicyTier::new("1.0.0");
    // §11.3's reasoning: a status call that did not answer is not evidence.
    tier.observe(&ApiError::Transport {
        source: memry_core::api::errors::TransportError::Offline,
    });
    assert!(tier.entitled());
    // A poll is silent on entitlement, and silence is not evidence either.
    tier.learn(&json!({"clientPolicy": {"writesEnabled": true}}), 1);
    assert!(tier.entitled());

    tier.observe(&ApiError::Status {
        status: 402,
        code: Some(SYNC_PAYMENT_REQUIRED.to_owned()),
        message: "no active sync subscription".to_owned(),
    });
    assert!(!tier.entitled());
    assert_eq!(tier.gate(), WriteGate::Unentitled);
    // And a poll cannot restore it: `clientPolicy` carries no entitlement
    // field (§11.7.1), so only the account tier may say so.
    tier.learn(&json!({"clientPolicy": {}}), 2);
    assert_eq!(tier.gate(), WriteGate::Unentitled);
    tier.set_entitled(true);
    assert_eq!(tier.gate(), WriteGate::Open);
}

#[tokio::test]
async fn crdt_updates_go_to_their_own_route_and_are_acked_one_per_sequence() {
    let db = scratch_db("crdt-wave");
    db.call_blocking(|conn| {
        outbox::commit(
            conn,
            &Change::crdt_update("note", "n1", vec![1, 2]),
            1,
            |_| Ok(()),
        )?;
        outbox::commit(conn, &Change::crdt_update("note", "n1", vec![3]), 2, |_| {
            Ok(())
        })?;
        Ok(())
    })
    .expect("enqueue");

    // §7.4: the server assigns the sequence numbers and answers
    // `{ sequences }`; a client never proposes one.
    let transport = FakeTransport::new(vec![response(
        200,
        &json!({"sequences": [7, 8]}).to_string(),
    )]);
    let push = coordinator(db.clone(), transport.clone(), RecordingSealer::new());
    let report = push.drain_wave().await.expect("the wave");

    assert_eq!(report.crdt_updates, 2);
    assert!(transport.calls_to("/sync/push").is_empty());
    let sent = transport.calls_to("/sync/crdt/updates");
    assert_eq!(sent.len(), 1, "one document, one request");
    assert_eq!(body_json(&sent[0])["noteId"], json!("n1"));
    assert_eq!(
        body_json(&sent[0])["updates"].as_array().unwrap().len(),
        2,
        "a CRDT enqueue never coalesces, so both rows ride the wave"
    );
    assert!(outbox_rows(&db).is_empty(), "one ack per row");
}

// ------------------------------------------- T118, the 402 reaches the engine

struct ScriptedPush(std::sync::Mutex<Option<ApiError>>);

#[async_trait::async_trait]
impl memry_core::sync::engine::PushWave for ScriptedPush {
    async fn pending(&self) -> Result<usize, ApiError> {
        Ok(1)
    }

    async fn drain(&self) -> Result<(), ApiError> {
        match self.0.lock().unwrap().clone() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

struct AlwaysOnline;

impl memry_core::seams::reachability::Reachability for AlwaysOnline {
    fn current(&self) -> memry_core::seams::reachability::Reachable {
        memry_core::seams::reachability::Reachable::Wifi
    }
    fn observe(&self, _observer: Arc<dyn memry_core::seams::reachability::ReachabilityObserver>) {}
}

struct NoCipher;

impl memry_core::sync::pull::RecordCipher for NoCipher {
    fn open(
        &self,
        _envelope: &memry_core::protocol::envelope::RecordEnvelope,
    ) -> Result<Vec<u8>, EnvelopeError> {
        Err(EnvelopeError::SignatureInvalid)
    }
}

#[tokio::test]
async fn a_mid_wave_402_demotes_the_engine_to_unentitled_and_parks_the_next_pass() {
    let db = scratch_db("engine-402");
    let transport = FakeTransport::new(vec![
        // Pass one: the status poll, then an empty page, then the push.
        response(
            200,
            &json!({"clientPolicy": {"writesEnabled": true}}).to_string(),
        ),
        response(
            200,
            &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": 1}).to_string(),
        ),
        // Pass two: the poll runs again because the gate is no longer open
        // (§11.8.1, "immediately before draining a parked outbox"), and it
        // still says nothing about entitlement (§11.7.1).
        response(
            200,
            &json!({"clientPolicy": {"writesEnabled": true}}).to_string(),
        ),
        response(
            200,
            &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": 2}).to_string(),
        ),
    ]);
    let http = Arc::new(HttpClient::new(
        transport.clone(),
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    ));
    let pull = Arc::new(memry_core::sync::pull::PullLoop::new(
        Arc::clone(&http),
        db,
        Declaration::subscribed(),
        Arc::new(NoCipher),
    ));
    let push = Arc::new(ScriptedPush(std::sync::Mutex::new(Some(
        ApiError::Status {
            status: 402,
            code: Some(SYNC_PAYMENT_REQUIRED.to_owned()),
            message: "no active sync subscription".to_owned(),
        },
    ))));
    let engine = memry_core::sync::engine::SyncEngine::new(pull, http, Arc::new(AlwaysOnline))
        .with_push(push);

    let first = engine
        .run_pass(memry_core::sync::state::PassTrigger::Timer)
        .await;
    assert_eq!(
        first.final_state,
        memry_core::sync::state::SyncState::Unentitled,
        "a 402 mid-wave is a billing fact, not a transport failure"
    );
    assert_eq!(engine.write_gate(), WriteGate::Unentitled);

    // The next pass parks: reads still run, the wave is not attempted.
    let second = engine
        .run_pass(memry_core::sync::state::PassTrigger::Timer)
        .await;
    assert!(second.parked);
    assert!(!second.pushed);
    assert_eq!(
        second.final_state,
        memry_core::sync::state::SyncState::Unentitled
    );
    assert_eq!(second.pull.pages, 1, "reads are never gated");

    // Only the account tier clears it (§11.7.1).
    engine.set_entitled(true);
    assert_eq!(engine.write_gate(), WriteGate::Open);
}
