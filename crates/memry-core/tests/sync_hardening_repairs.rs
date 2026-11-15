//! The manifest check and the stale-cursor reset (Step 17 L3b, #3534;
//! `sync::hardening::{manifest, stale_cursor}`) through the real pull.
//!
//! - The manifest check pulls a live server row this device holds no row of,
//!   by id, and queues a live clocked local row the server does not list as
//!   `create`; never a row held here in any state, a refused or permanently
//!   quarantined one, `task_activity`, or a type the server re-creates over a
//!   purged tombstone (notes among them). At most once per 30 minutes.
//! - A reconnect more than a day after the last successful pull reads the
//!   record feed from the start; less than a day keeps the cursor. Through the
//!   desktop driver's pass, on `driver_fakes`'s server.
//!
//! Real `HttpClient`, SQLite and apply; the transport and the record cipher
//! are the only fakes. The fake transport panics on an unscripted request, so
//! a script without a `/sync/pull` response proves no pull was made.

#[allow(unused_imports)]
use crate::http_fakes;

use crate::driver_fakes::Desktop;

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use http_fakes::{FakeTransport, body_json, response};
use memry_core::api::errors::StorageError;
use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::protocol::types::Declaration;
use memry_core::storage::{Db, open_data};
use memry_core::sync::driver::progress::SilentInitialSync;
use memry_core::sync::first_sync_store::read_meta;
use memry_core::sync::hardening::manifest::{ManifestCheck, ManifestOutcome};
use memry_core::sync::pull::{PullLoop, RecordCipher};
use memry_core::sync::store::{self, RECORD_CURSOR_SCOPE};
use serde_json::{Value as Json, json};

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;

fn now_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("after the epoch")
            .as_millis(),
    )
    .expect("fits")
}

fn scratch_db() -> Db {
    let dir = tempfile::Builder::new()
        .prefix("memry-hardening-repairs-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

/// Every envelope opens to a live, clocked record; a note's title is enough.
struct Live;

impl RecordCipher for Live {
    fn open(&self, _envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        Ok(json!({"title": "From the peer", "clock": {"peer": 1}})
            .to_string()
            .into_bytes())
    }
}

fn declaration() -> Declaration {
    Declaration::declare(&["note", "journal", "task", "project", "task_activity"])
        .expect("recognised")
}

fn pull_loop(db: &Db, transport: Arc<FakeTransport>) -> PullLoop {
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("desktop", "1.0.0").expect("a valid identity"),
    );
    PullLoop::new(Arc::new(http), db.clone(), declaration(), Arc::new(Live)).with_hardening()
}

fn envelope(id: &str, item_type: &str) -> Json {
    json!({
        "id": id, "type": item_type, "operation": "update",
        "encryptedKey": "AAAA", "keyNonce": "AAAA", "encryptedData": "AAAA",
        "dataNonce": "AAAA", "signature": "AAAA", "signerDeviceId": "peer",
    })
}

fn changes(listed: &[(&str, &str)], next_cursor: &str) -> String {
    let items: Vec<Json> = listed
        .iter()
        .map(|(id, item_type)| json!({"id": id, "type": item_type}))
        .collect();
    json!({"items": items, "deleted": [], "hasMore": false, "nextCursor": next_cursor}).to_string()
}

fn manifest(listed: &[(&str, &str)]) -> String {
    let items: Vec<Json> = listed
        .iter()
        .map(|(item_type, id)| json!({"type": item_type, "id": id}))
        .collect();
    json!({"items": items, "nextCursor": null}).to_string()
}

/// Pulls `envelopes` live through one feed page: rows the server pushed
/// here, so nothing is queued for them.
async fn pull_live(db: &Db, envelopes: Vec<Json>) {
    let listed: Vec<(String, String)> = envelopes
        .iter()
        .map(|item| {
            (
                item["id"].as_str().unwrap().to_owned(),
                item["type"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    let listed: Vec<(&str, &str)> = listed
        .iter()
        .map(|(id, item_type)| (id.as_str(), item_type.as_str()))
        .collect();
    let transport = FakeTransport::new(vec![
        response(200, &changes(&listed, "10")),
        response(200, &json!({ "items": envelopes }).to_string()),
    ]);
    pull_loop(db, transport)
        .run(1)
        .await
        .expect("the seed pull");
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn exec(db: &Db, sql: &'static str) {
    db.call_blocking(move |conn| conn.execute_batch(sql).map_err(failed))
        .expect("seed");
}

fn queued(db: &Db) -> Vec<(String, String, String)> {
    db.call_blocking(|conn| {
        let mut statement = conn
            .prepare("SELECT item_type, item_id, op FROM outbox ORDER BY item_type, item_id")
            .map_err(failed)?;
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(failed)?
            .collect::<Result<_, _>>()
            .map_err(failed)
    })
    .expect("the outbox")
}

fn live(db: &Db, item_type: &'static str, id: &'static str) -> bool {
    db.call_blocking(move |conn| {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_items
                            WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NULL)",
            [item_type, id],
            |row| row.get(0),
        )
        .map_err(failed)
    })
    .expect("read")
}

fn pair(item_type: &str, id: &str) -> (String, String) {
    (item_type.to_owned(), id.to_owned())
}

#[tokio::test]
async fn a_live_server_row_held_nowhere_here_is_pulled_by_id() {
    let db = scratch_db();
    let transport = FakeTransport::new(vec![
        response(
            200,
            &manifest(&[("task", "t9"), ("task_activity", "a1"), ("bookmark", "b1")]),
        ),
        response(200, &json!({"items": [envelope("t9", "task")]}).to_string()),
    ]);
    let pull = pull_loop(&db, transport.clone());

    let outcome = ManifestCheck::default()
        .run(&pull, now_ms())
        .await
        .expect("the check")
        .expect("not throttled");

    assert_eq!(outcome.server_only, vec![pair("task", "t9")]);
    assert_eq!(
        body_json(&transport.calls_to("/sync/pull")[0]),
        json!({"itemIds": ["t9"]}),
        "not task_activity, not an undeclared type"
    );
    assert!(live(&db, "task", "t9"));
}

#[tokio::test]
async fn a_live_clocked_task_the_server_lacks_is_queued_as_create_and_a_note_is_not() {
    let db = scratch_db();
    pull_live(&db, vec![envelope("t1", "task"), envelope("n1", "note")]).await;
    assert!(queued(&db).is_empty(), "pulled rows owe nothing");
    let transport = FakeTransport::new(vec![response(200, &manifest(&[]))]);

    let outcome = ManifestCheck::default()
        .run(&pull_loop(&db, transport), now_ms())
        .await
        .expect("the check")
        .expect("not throttled");

    assert_eq!(
        outcome,
        ManifestOutcome {
            server_only: Vec::new(),
            reuploaded: vec![pair("task", "t1")],
        }
    );
    assert_eq!(
        queued(&db),
        vec![("task".to_owned(), "t1".to_owned(), "create".to_owned())],
        "a note is re-created over a purged tombstone by the server, so it stays local"
    );
}

#[tokio::test]
async fn a_row_held_here_in_any_state_or_in_either_spelling_is_not_pulled() {
    let db = scratch_db();
    pull_live(&db, vec![envelope("t3", "task"), envelope("n1", "note")]).await;
    let mut deleted = envelope("t3", "task");
    deleted["deletedAt"] = json!(now_ms());
    let transport = FakeTransport::new(vec![
        response(200, &changes(&[("t3", "task")], "11")),
        response(200, &json!({ "items": [deleted] }).to_string()),
    ]);
    pull_loop(&db, transport).run(1).await.expect("the delete");
    assert!(!live(&db, "task", "t3"));

    // No `/sync/pull` scripted: a pull would panic the transport.
    let transport = FakeTransport::new(vec![response(
        200,
        &manifest(&[("task", "t3"), ("journal", "n1")]),
    )]);
    let outcome = ManifestCheck::default()
        .run(&pull_loop(&db, transport.clone()), now_ms())
        .await
        .expect("the check")
        .expect("not throttled");

    assert!(outcome.server_only.is_empty(), "{outcome:?}");
    assert!(transport.calls_to("/sync/pull").is_empty());
    assert!(!live(&db, "task", "t3"), "the tombstone stands");
}

#[tokio::test]
async fn a_refused_or_permanently_quarantined_item_is_not_pulled() {
    let db = scratch_db();
    let now = now_ms();
    exec(
        &db,
        "INSERT INTO sync_refused_items (item_type, item_id, refused_by_version, refused_at)
         VALUES ('task', 't5', 'this-build', 0),
                ('note', 'n7', 'this-build', 0);",
    );
    let quarantined = format!(
        "INSERT INTO sync_quarantine
           (item_type, item_id, signer_device_id, failed_at, attempt_count, last_error)
         VALUES ('task', 't6', 'forger', {now}, 3, 'signature');"
    );
    db.call_blocking(move |conn| conn.execute_batch(&quarantined).map_err(failed))
        .expect("seed");
    let transport = FakeTransport::new(vec![response(
        200,
        // The refused note listed in its other spelling.
        &manifest(&[("task", "t5"), ("task", "t6"), ("journal", "n7")]),
    )]);

    let outcome = ManifestCheck::default()
        .run(&pull_loop(&db, transport), now)
        .await
        .expect("the check")
        .expect("not throttled");

    assert!(outcome.server_only.is_empty(), "{outcome:?}");
}

#[tokio::test]
async fn the_check_runs_at_most_once_per_30_minutes() {
    let db = scratch_db();
    let transport = FakeTransport::new(vec![
        response(200, &manifest(&[])),
        response(200, &manifest(&[])),
    ]);
    let pull = pull_loop(&db, transport.clone());
    let check = ManifestCheck::default();
    let start = now_ms();

    assert!(check.run(&pull, start).await.expect("first").is_some());
    assert!(
        check
            .run(&pull, start + 29 * MINUTE_MS)
            .await
            .expect("throttled")
            .is_none()
    );
    assert!(
        check
            .run(&pull, start + 31 * MINUTE_MS)
            .await
            .expect("second")
            .is_some()
    );
    assert_eq!(transport.calls_to("&cursor=0").len(), 2);
}

/// A desktop that last pulled `hours_ago`, holding `cursor` and the
/// cursor-skip marker `repair`, comes back online and runs one driver pass
/// (`SyncDriver::run_pass`) to a page ending at `4300`; returns the desktop
/// and the first feed request's URL.
async fn reconnect(hours_ago: i64, cursor: &str, repair: &str) -> (Desktop, String) {
    const TYPES: [&str; 5] = ["note", "journal", "task", "project", "task_activity"];
    let last_pull = now_ms() - hours_ago * HOUR_MS;
    let header = declaration().header_value();
    let (cursor, repair) = (cursor.to_owned(), repair.to_owned());
    let desktop = Desktop::open(&TYPES, move |conn| {
        conn.execute(
            "INSERT INTO sync_history (id, kind, item_count, created_at)
             VALUES ('h1', 'pull', 3, ?1)",
            [last_pull],
        )
        .map_err(failed)?;
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('sync.record_declaration', ?1),
                                                  ('sync.cursor_skip_repair', ?2)",
            [header, repair],
        )
        .map_err(failed)?;
        store::write_cursor(conn, RECORD_CURSOR_SCOPE, Some(&cursor), last_pull)
    })
    .await;
    desktop.server.page(&[], "4300");
    desktop.network.reconnect();
    desktop.pass().await;
    let url = desktop
        .server
        .urls()
        .into_iter()
        .find(|url| url.contains("/sync/changes"))
        .expect("a feed request");
    (desktop, url)
}

#[tokio::test]
async fn a_reconnect_25_hours_after_the_last_pull_reads_the_feed_from_the_start() {
    let (_, url) = reconnect(25, "4200", "done").await;
    assert!(!url.contains("cursor="), "{url}");
}

#[tokio::test]
async fn a_reconnect_23_hours_after_the_last_pull_keeps_the_cursor() {
    let (_, url) = reconnect(23, "4200", "done").await;
    assert!(url.contains("cursor=4200"), "{url}");
}

/// The cursor-skip repair reset the cursor from `4200` and the process died
/// mid-repair, at `50`. A stale reconnect reads the feed from the start again
/// without starting a second repair, and the pass that reaches the head
/// records the repair `done`.
#[tokio::test]
async fn a_stale_reconnect_during_an_interrupted_repair_reads_from_the_start_and_ends_done() {
    let (desktop, url) = reconnect(25, "50", "pending:4200").await;

    assert!(!url.contains("cursor="), "{url}");
    let (marker, cursor) = desktop
        .db
        .call_blocking(|conn| {
            Ok((
                read_meta(conn, "sync.cursor_skip_repair")?,
                store::read_cursor(conn, RECORD_CURSOR_SCOPE)?,
            ))
        })
        .expect("read");
    assert_eq!(marker.as_deref(), Some("done"));
    assert_eq!(cursor.as_deref(), Some("4300"), "the feed advanced");
}

/// A first sync reads the feed from the start under this build's
/// declaration, which is the cursor-skip repair too, so the pass after it
/// carries on from the cursor the first sync stored.
#[tokio::test]
async fn the_first_pass_after_a_first_sync_sends_the_stored_cursor() {
    let desktop = Desktop::open(&["task"], |_| Ok(())).await;
    desktop.server.put("task", "t1", json!({"title": "one"}));
    desktop.server.page(&["t1"], "4200");

    desktop
        .driver
        .first_sync(Arc::new(SilentInitialSync))
        .await
        .expect("the first sync")
        .expect("not paused");

    let feed: Vec<String> = desktop
        .server
        .urls()
        .into_iter()
        .filter(|url| url.contains("/sync/changes"))
        .collect();
    assert!(!feed[0].contains("cursor="), "{feed:?}");
    assert!(feed[1].contains("cursor=4200"), "{feed:?}");
}
