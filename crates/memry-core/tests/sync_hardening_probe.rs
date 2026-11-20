//! The manifest check's question before it re-uploads a note (#4785; chapter
//! 05 §5.12.3, §5.15): `POST /sync/pull` names the id, and only an answer that
//! names nothing queues the `create`. A tombstone or a marker records its
//! clock and queues nothing, after which the row is not asked about again; a
//! failed question queues nothing until the next check; the check, and so the
//! question, runs at most once per 30 minutes.
//!
//! Real `HttpClient`, SQLite and pull, on `sync_hardening_repairs`'s scripted
//! transport, which panics on an unscripted request: a script without a
//! `/sync/pull` response proves the row was not asked about.

use memry_core::sync::hardening::manifest::{ManifestCheck, ManifestOutcome};
use memry_core::sync::store;
use serde_json::{Value as Json, json};

use crate::http_fakes::{FakeTransport, error_response, response};
use crate::sync_hardening_repairs::{
    envelope, manifest, now_ms, pair, pull_live, pull_loop, queued, scratch_db,
};

const MINUTE_MS: i64 = 60_000;

fn answer(body: Json) -> String {
    body.to_string()
}

fn recorded(db: &memry_core::storage::Db) -> Option<Json> {
    db.call_blocking(|conn| store::tombstone_clock(conn, "note", "n1"))
        .expect("read")
        .map(|clock| serde_json::to_value(clock).expect("json"))
}

async fn holding_a_note() -> memry_core::storage::Db {
    let db = scratch_db();
    pull_live(&db, vec![envelope("n1", "note")]).await;
    db
}

/// The server answers the asked note with `deleted`: nothing is queued, the
/// delete's clock is recorded, and the next check does not ask again.
async fn a_note_the_server_answers_deleted_stays_local(deleted: Json) {
    let db = holding_a_note().await;
    let transport = FakeTransport::new(vec![
        response(200, &manifest(&[])),
        response(200, &answer(deleted)),
    ]);
    let pull = pull_loop(&db, transport.clone());
    let check = ManifestCheck::default();
    let start = now_ms();

    let outcome = check.run(&pull, start).await.expect("the check");
    assert_eq!(
        outcome,
        Some(ManifestOutcome {
            server_only: Vec::new(),
            reuploaded: Vec::new(),
            deleted_there: vec![pair("note", "n1")],
        })
    );
    assert!(queued(&db).is_empty(), "{:?}", queued(&db));
    assert_eq!(recorded(&db), Some(json!({ "peer": 2 })));

    // Known deleted now: the next check lists, and asks nothing.
    transport.push(response(200, &manifest(&[])));
    check
        .run(&pull, start + 31 * MINUTE_MS)
        .await
        .expect("the second check");
    assert!(queued(&db).is_empty());
    assert_eq!(transport.calls_to("/sync/pull").len(), 1);
}

#[tokio::test]
async fn a_note_whose_marker_the_server_answers_is_not_reuploaded() {
    a_note_the_server_answers_deleted_stays_local(json!({
        "items": [],
        "purgedTombstones": [{
            "id": "n1", "type": "note", "clock": { "peer": 2 },
            "deletedAt": 1_760_000_000_000_i64, "serverCursor": 7,
        }],
    }))
    .await;
}

#[tokio::test]
async fn a_note_whose_tombstone_the_server_answers_is_not_reuploaded() {
    let mut tombstone = envelope("n1", "note");
    tombstone["operation"] = json!("delete");
    tombstone["deletedAt"] = json!(1_760_000_000_000_i64);
    tombstone["clock"] = json!({ "peer": 2 });
    a_note_the_server_answers_deleted_stays_local(json!({ "items": [tombstone] })).await;
}

/// The bound: a note the server answers live for is asked about once per
/// check, and the check runs at most once per 30 minutes.
#[tokio::test]
async fn a_note_is_asked_about_at_most_once_per_30_minutes() {
    let db = holding_a_note().await;
    let transport = FakeTransport::new(vec![
        response(200, &manifest(&[])),
        response(200, &answer(json!({ "items": [envelope("n1", "note")] }))),
    ]);
    let pull = pull_loop(&db, transport.clone());
    let check = ManifestCheck::default();
    let start = now_ms();

    check.run(&pull, start).await.expect("the check");
    assert!(queued(&db).is_empty(), "the server holds it live");
    for minutes in [1, 15, 29] {
        let throttled = check.run(&pull, start + minutes * MINUTE_MS).await;
        assert_eq!(throttled.expect("throttled"), None);
    }
    assert_eq!(transport.calls_to("/sync/pull").len(), 1);

    transport.push(response(200, &manifest(&[])));
    transport.push(response(200, &answer(json!({ "items": [] }))));
    check
        .run(&pull, start + 30 * MINUTE_MS)
        .await
        .expect("the next check");
    assert_eq!(transport.calls_to("/sync/pull").len(), 2);
    assert_eq!(
        queued(&db),
        vec![("note".to_owned(), "n1".to_owned(), "create".to_owned())]
    );
}

/// A failed question queues no note, while the other types' re-uploads stand;
/// the next check asks again.
#[tokio::test]
async fn a_failed_question_reuploads_no_note() {
    let db = scratch_db();
    pull_live(&db, vec![envelope("n1", "note"), envelope("t1", "task")]).await;
    let transport = FakeTransport::new(vec![
        response(200, &manifest(&[])),
        error_response(400, "SYNC_INVALID_REQUEST", "no"),
    ]);
    let pull = pull_loop(&db, transport.clone());
    let check = ManifestCheck::default();
    let start = now_ms();

    let outcome = check.run(&pull, start).await.expect("the check stands");
    assert_eq!(
        outcome.expect("not throttled").reuploaded,
        vec![pair("task", "t1")]
    );
    assert_eq!(
        queued(&db),
        vec![("task".to_owned(), "t1".to_owned(), "create".to_owned())]
    );
    assert_eq!(recorded(&db), None);

    transport.push(response(200, &manifest(&[("task", "t1")])));
    transport.push(response(200, &answer(json!({ "items": [] }))));
    check
        .run(&pull, start + 31 * MINUTE_MS)
        .await
        .expect("the next check");
    assert!(
        queued(&db).contains(&("note".to_owned(), "n1".to_owned(), "create".to_owned())),
        "{:?}",
        queued(&db)
    );
}
