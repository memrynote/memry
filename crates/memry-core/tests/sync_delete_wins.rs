//! An edit to an item the server holds deleted (chapter 05 §5.8, #5406).
//!
//! Real `HttpClient`, real SQLite. The fake is the `Transport`.
//!
//! | Test                                              | Rule                     |
//! | ------------------------------------------------- | ------------------------ |
//! | `SYNC_DELETE_WINS` deletes the row locally         | §5.8, #5406              |
//! | an edit over a kept marker deletes and sends none | §5.12.3, #5406           |
//! | a write newer than the marker pushes normally     | §5.12.3, #5406           |
//! | a local delete forgets the marker                 | §5.8 re-create, #5406    |

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use http_fakes::{FakeTransport, response};
use memry_core::api::errors::StorageError;
use memry_core::protocol::envelope::EnvelopeError;
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::outbox::{self, Change};
use memry_core::sync::push::{PendingRecord, PushCoordinator, PushSealer};
use rusqlite::params;
use serde_json::{Value as Json, json};

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-delete-wins-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn exec(db: &Db, sql: &'static str, values: Vec<rusqlite::types::Value>) {
    db.call_blocking(move |conn| {
        conn.execute(sql, rusqlite::params_from_iter(values))
            .map_err(failed)?;
        Ok(())
    })
    .expect("exec");
}

/// A live task row held at `cursor`, edited locally: one upsert queued.
fn edited_task(db: &Db, id: &str, cursor: i64) {
    let id = id.to_owned();
    db.call_blocking(move |conn| {
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, server_cursor,
                                     clock, updated_at)
             VALUES ('task', ?1, '{\"title\":\"edited\"}', 'full', ?2, '{\"device-b\":3}', 1)",
            params![id, cursor],
        )
        .map_err(failed)?;
        outbox::commit(conn, &Change::upsert("task", &id), 1, |_| Ok(())).map(|_| ())
    })
    .expect("seed the edited task");
}

/// What the first-sync reconcile records for a row it kept against a marker
/// with no attestation.
fn kept_marker(db: &Db, id: &str, cursor: i64, clock: Option<&str>) {
    exec(
        db,
        "INSERT INTO sync_unattested_markers
             (item_type, item_id, deleted_at, server_cursor, clock, recorded_at)
         VALUES ('task', ?1, 1700000000000, ?2, ?3, 1)",
        vec![
            id.to_owned().into(),
            cursor.into(),
            clock.map(str::to_owned).into(),
        ],
    );
}

fn task_deleted(db: &Db, id: &str) -> bool {
    let id = id.to_owned();
    db.call_blocking(move |conn| {
        conn.query_row(
            "SELECT deleted_at IS NOT NULL FROM sync_items WHERE item_type = 'task' AND item_id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(failed)
    })
    .expect("read the task")
}

fn count(db: &Db, sql: &'static str) -> i64 {
    db.call_blocking(move |conn| conn.query_row(sql, [], |row| row.get(0)).map_err(failed))
        .expect("count")
}

struct EchoSealer;

impl PushSealer for EchoSealer {
    fn seal_record(&self, item: &PendingRecord) -> Result<Json, EnvelopeError> {
        Ok(json!({"id": item.row.item_id, "type": item.row.item_type}))
    }

    fn seal_crdt_update(&self, _doc_id: &str, update: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
        Ok(update.to_vec())
    }
}

fn coordinator(db: &Db, transport: Arc<FakeTransport>) -> PushCoordinator {
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    PushCoordinator::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(EchoSealer),
    )
    .with_clock_device("device-b")
}

fn push_answer(accepted: &[&str], rejected: &[(&str, &str)]) -> String {
    let rejected: Vec<Json> = rejected
        .iter()
        .map(|(id, reason)| json!({"id": id, "reason": reason}))
        .collect();
    json!({"accepted": accepted, "rejected": rejected, "serverTime": 1, "maxCursor": 1}).to_string()
}

/// #5406: the server refuses the edit because it holds the item deleted.
/// Acking with no local change left the edit silently gone and the item
/// still live here; the delete now applies through the pulled-delete path.
#[tokio::test]
async fn a_delete_wins_answer_deletes_the_row_locally() {
    let db = scratch_db("answer");
    edited_task(&db, "t1", 5);
    let transport = FakeTransport::new(vec![response(
        200,
        &push_answer(&[], &[("t1", "SYNC_DELETE_WINS")]),
    )]);
    let report = coordinator(&db, transport)
        .drain_wave()
        .await
        .expect("the wave");
    assert!(task_deleted(&db, "t1"), "the server's delete applies here");
    assert_eq!(report.deleted_locally, 1);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM outbox"), 0);
}

/// #5406: a clockless marker the server accepts any update over. An edit of
/// the row the reconcile kept against it would reverse the delete on every
/// device, so it applies the marker's delete here and sends nothing.
#[tokio::test]
async fn an_edit_over_a_kept_clockless_marker_deletes_locally_and_sends_nothing() {
    let db = scratch_db("clockless");
    edited_task(&db, "t1", 5);
    kept_marker(&db, "t1", 9, None);
    let transport = FakeTransport::new(Vec::new());
    let report = coordinator(&db, transport.clone())
        .drain_wave()
        .await
        .expect("the wave");
    assert!(transport.calls_to("/sync/push").is_empty());
    assert!(task_deleted(&db, "t1"));
    assert_eq!(report.deleted_locally, 1);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM outbox"), 0);
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM sync_unattested_markers"),
        0
    );
}

/// A clocked marker the local edit happens strictly after is the §5.8 client
/// rule's keep: the server accepts that write, so it is sent.
#[tokio::test]
async fn an_edit_strictly_after_a_kept_clocked_marker_is_sent() {
    let db = scratch_db("after");
    edited_task(&db, "t1", 5);
    kept_marker(&db, "t1", 9, Some(r#"{"device-b":2}"#));
    let transport = FakeTransport::new(vec![response(200, &push_answer(&["t1"], &[]))]);
    coordinator(&db, transport.clone())
        .drain_wave()
        .await
        .expect("the wave");
    assert_eq!(transport.calls_to("/sync/push").len(), 1);
    assert!(!task_deleted(&db, "t1"));
}

/// The server wrote the item after the marker (someone re-created it): the
/// marker no longer stands for the row, and the edit pushes as usual.
#[tokio::test]
async fn a_row_written_after_the_marker_pushes_normally() {
    let db = scratch_db("newer");
    edited_task(&db, "t1", 12);
    kept_marker(&db, "t1", 9, None);
    let transport = FakeTransport::new(vec![response(200, &push_answer(&["t1"], &[]))]);
    coordinator(&db, transport.clone())
        .drain_wave()
        .await
        .expect("the wave");
    assert_eq!(transport.calls_to("/sync/push").len(), 1);
    assert!(!task_deleted(&db, "t1"));
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM sync_unattested_markers"),
        0
    );
}

/// A user who deletes the kept row has honoured the delete; a re-create of
/// the same id afterwards is theirs and is sent.
#[tokio::test]
async fn a_local_delete_forgets_the_marker() {
    let db = scratch_db("forget");
    edited_task(&db, "t1", 5);
    kept_marker(&db, "t1", 9, None);
    db.call_blocking(|conn| {
        outbox::commit(conn, &Change::delete("task", "t1"), 2, |_| Ok(()))?;
        outbox::commit(conn, &Change::upsert("task", "t1"), 3, |_| Ok(())).map(|_| ())
    })
    .expect("delete and re-create");
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM sync_unattested_markers"),
        0
    );
    let transport = FakeTransport::new(vec![response(200, &push_answer(&["t1"], &[]))]);
    coordinator(&db, transport.clone())
        .drain_wave()
        .await
        .expect("the wave");
    assert_eq!(transport.calls_to("/sync/push").len(), 1);
}
