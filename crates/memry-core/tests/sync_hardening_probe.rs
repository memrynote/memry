//! The manifest check's question before it re-uploads a note (#4785; chapter
//! 05 §5.12.3, §5.15): `POST /sync/pull` names the id, and only an answer that
//! names nothing queues the `create`. A tombstone or a marker records its
//! clock and queues nothing, after which the row is not asked about again; a
//! failed question queues nothing until the next check; the check, and so the
//! question, runs at most once per 30 minutes.
//!
//! The server is untrusted: a clock is recorded only when a device signed it
//! (an attested marker, a tombstone whose envelope verifies), and no clock
//! carries a tick above `MAX_TICK`, from the question or from a pull.
//!
//! Real `HttpClient`, SQLite, pull, attestation and envelope signatures, on
//! `sync_hardening_repairs`'s scripted transport, which panics on an
//! unscripted request: a script without a `/sync/pull` response proves the
//! row was not asked about.

use std::collections::HashSet;
use std::sync::Arc;

use memry_core::api::errors::ApiError;
use memry_core::crypto::{keys, sodium};
use memry_core::protocol::delete_attestation::{claim_of, sign};
use memry_core::protocol::envelope::{self, RecordMaterial, RecordRequest, SyncOperation};
use memry_core::protocol::http::HttpClient;
use memry_core::storage::Db;
use memry_core::sync::clock::VectorClock;
use memry_core::sync::hardening::manifest::{MAX_PROBED, ManifestCheck, ManifestOutcome};
use memry_core::sync::hardening::purged::SignerKeys;
use memry_core::sync::pull::PullLoop;
use memry_core::sync::store;
use serde_json::{Value as Json, json};

use crate::http_fakes::{FakeTransport, error_response, response};
use crate::sync_hardening_repairs::{
    envelope, manifest, now_ms, pair, pull_live, pull_loop, queued, scratch_db,
};

const MINUTE_MS: i64 = 60_000;
const DELETED_AT: i64 = 1_760_000_000_000;
const PEER_SEED: u8 = 21;
const STRANGER_SEED: u8 = 22;

/// The account's one other device, `peer`, signing with [`PEER_SEED`].
struct PeerKey;

#[async_trait::async_trait]
impl SignerKeys for PeerKey {
    async fn signing_key(
        &self,
        _http: &HttpClient,
        device_id: &str,
    ) -> Result<Option<Vec<u8>>, ApiError> {
        Ok((device_id == "peer").then(|| keypair(PEER_SEED).0))
    }

    fn known_devices(&self) -> Option<HashSet<String>> {
        None
    }
}

fn keypair(seed: u8) -> (Vec<u8>, Vec<u8>) {
    let (public, secret) = sodium::sign_seed_keypair(&[seed; 32]).expect("a keypair");
    (public.to_vec(), secret.to_vec())
}

fn keyed_pull(db: &Db, transport: Arc<FakeTransport>) -> PullLoop {
    pull_loop(db, transport).with_signer_keys(Arc::new(PeerKey))
}

/// A note marker for `n1` at `clock`, attested as `signer` with `seed`'s key.
fn marker(clock: Json, signer: Option<(&str, u8)>) -> Json {
    let mut entry = json!({
        "id": "n1", "type": "note", "clock": clock, "deletedAt": DELETED_AT,
        "serverCursor": 7,
    });
    if let Some((device, seed)) = signer {
        let clock: VectorClock = serde_json::from_value(clock).expect("a clock");
        let claim = claim_of(
            "note",
            "n1",
            SyncOperation::Delete,
            Some(&clock),
            Some(DELETED_AT),
        )
        .expect("an attestable delete");
        entry["signerDeviceId"] = json!(device);
        entry["deleteAttestation"] = json!(sign(&claim, &keypair(seed).1).expect("signed"));
    }
    json!({ "items": [], "purgedTombstones": [entry] })
}

/// A note tombstone for `n1` at `ticks`, sealed and signed as `signer` with
/// `seed`'s key.
fn tombstone(ticks: u64, signer: &str, seed: u8) -> Json {
    let vault_key = keys::derive_vault_key(&[7; 32]).expect("the vault key");
    let sealed = envelope::encrypt(
        &RecordRequest {
            id: "n1",
            item_type: "note",
            operation: SyncOperation::Delete,
            content: b"{}",
            vault_key: &vault_key,
            signing_secret_key: &keypair(seed).1,
            signer_device_id: signer,
            clock: Some([("peer".to_owned(), ticks)].into()),
            state_vector: None,
            deleted_at: Some(DELETED_AT),
        },
        &RecordMaterial::random(),
    )
    .expect("sealed");
    json!({ "items": [envelope::to_json(&sealed.envelope)] })
}

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
    let pull = keyed_pull(&db, transport.clone());
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
async fn a_note_whose_attested_marker_the_server_answers_is_not_reuploaded() {
    let answer = marker(json!({ "peer": 2 }), Some(("peer", PEER_SEED)));
    a_note_the_server_answers_deleted_stays_local(answer).await;
}

#[tokio::test]
async fn a_note_whose_signed_tombstone_the_server_answers_is_not_reuploaded() {
    a_note_the_server_answers_deleted_stays_local(tombstone(2, "peer", PEER_SEED)).await;
}

/// The server answers `deleted` with a clock no device signed for: the note
/// is not re-uploaded this check, nothing is recorded, and the next check
/// asks again.
async fn an_unverified_answer_records_nothing(answer: Json) {
    let db = holding_a_note().await;
    let transport = FakeTransport::new(vec![
        response(200, &manifest(&[])),
        response(200, &answer.to_string()),
    ]);
    let pull = keyed_pull(&db, transport.clone());
    let check = ManifestCheck::default();
    let start = now_ms();

    let outcome = check.run(&pull, start).await.expect("the check");
    assert!(outcome.expect("not throttled").reuploaded.is_empty());
    assert!(queued(&db).is_empty(), "{:?}", queued(&db));
    assert_eq!(recorded(&db), None);

    transport.push(response(200, &manifest(&[])));
    transport.push(response(200, &answer.to_string()));
    check
        .run(&pull, start + 31 * MINUTE_MS)
        .await
        .expect("the next check");
    assert_eq!(transport.calls_to("/sync/pull").len(), 2, "asked again");
    assert!(queued(&db).is_empty());
    assert_eq!(recorded(&db), None);
}

#[tokio::test]
async fn an_unattested_marker_records_nothing() {
    an_unverified_answer_records_nothing(marker(json!({ "peer": 9 }), None)).await;
}

#[tokio::test]
async fn a_marker_with_a_bad_signature_records_nothing() {
    let answer = marker(json!({ "peer": 9 }), Some(("peer", STRANGER_SEED)));
    an_unverified_answer_records_nothing(answer).await;
}

#[tokio::test]
async fn a_marker_from_an_unknown_signer_records_nothing() {
    let answer = marker(json!({ "peer": 9 }), Some(("stranger", STRANGER_SEED)));
    an_unverified_answer_records_nothing(answer).await;
}

#[tokio::test]
async fn a_tombstone_with_a_bad_signature_records_nothing() {
    an_unverified_answer_records_nothing(tombstone(9, "peer", STRANGER_SEED)).await;
}

#[tokio::test]
async fn a_tombstone_from_an_unknown_signer_records_nothing() {
    an_unverified_answer_records_nothing(tombstone(9, "stranger", STRANGER_SEED)).await;
}

/// A `u64::MAX` tick, even one a real device signed, is never recorded, so
/// a revived journal day never signs it and `increment` never meets it.
#[tokio::test]
async fn a_signed_marker_with_a_u64_max_tick_records_nothing() {
    let answer = marker(json!({ "peer": u64::MAX }), Some(("peer", PEER_SEED)));
    an_unverified_answer_records_nothing(answer).await;
}

#[tokio::test]
async fn a_signed_tombstone_with_a_u64_max_tick_records_nothing() {
    an_unverified_answer_records_nothing(tombstone(u64::MAX, "peer", PEER_SEED)).await;
}

/// The same bound on the pull: a pulled tombstone whose clock carries a
/// `u64::MAX` tick is one corrupt item. It deletes nothing and records no
/// clock.
#[tokio::test]
async fn a_pulled_tombstone_with_a_u64_max_tick_is_not_applied() {
    let db = holding_a_note().await;
    let mut deleted = envelope("n1", "note");
    deleted["operation"] = json!("delete");
    deleted["deletedAt"] = json!(DELETED_AT);
    deleted["clock"] = json!({ "peer": u64::MAX });
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"items": [{"id": "n1", "type": "note"}], "deleted": [],
                    "hasMore": false, "nextCursor": "11"})
            .to_string(),
        ),
        response(200, &json!({ "items": [deleted] }).to_string()),
    ]);
    let report = pull_loop(&db, transport).run(1).await.expect("the pull");
    assert_eq!(report.corrupt, 1, "{report:?}");
    assert_eq!(recorded(&db), None);
    let deleted_at: Option<i64> = db
        .call_blocking(|conn| {
            conn.query_row(
                "SELECT deleted_at FROM sync_items WHERE item_type = 'note' AND item_id = 'n1'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })
        })
        .expect("the row");
    assert_eq!(deleted_at, None, "the note stays live");
}

/// One check asks about at most `MAX_PROBED` rows; the rest are asked at the
/// next one.
#[tokio::test]
async fn a_check_asks_about_at_most_max_probed_rows_and_the_rest_next_time() {
    let db = scratch_db();
    db.call_blocking(|conn| {
        for n in 0..=MAX_PROBED {
            conn.execute(
                "INSERT INTO sync_items (item_type, item_id, payload, payload_state, clock, updated_at)
                 VALUES ('note', ?1, '{}', 'full', '{\"peer\":1}', 1)",
                [format!("n{n:05}")],
            )
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })?;
        }
        Ok(())
    })
    .expect("seeded");
    let chunks = MAX_PROBED / 100;
    let mut script = vec![response(200, &manifest(&[]))];
    script.extend((0..chunks).map(|_| response(200, &answer(json!({ "items": [] })))));
    let transport = FakeTransport::new(script);
    let pull = pull_loop(&db, transport.clone());
    let check = ManifestCheck::default();
    let start = now_ms();

    let outcome = check.run(&pull, start).await.expect("the check");
    assert_eq!(outcome.expect("not throttled").reuploaded.len(), MAX_PROBED);
    assert_eq!(transport.calls_to("/sync/pull").len(), chunks);

    transport.push(response(200, &manifest(&[])));
    transport.push(response(200, &answer(json!({ "items": [] }))));
    let outcome = check
        .run(&pull, start + 31 * MINUTE_MS)
        .await
        .expect("the next check");
    assert_eq!(
        outcome.expect("not throttled").reuploaded,
        vec![pair("note", &format!("n{MAX_PROBED:05}"))]
    );
    assert_eq!(transport.calls_to("/sync/pull").len(), chunks + 1);
}

/// Unattested markers for `n{from:05}` to `n{to:05}`: deleted there, and never
/// resolved here.
fn unattested_markers(from: usize, to: usize) -> String {
    let markers: Vec<Json> = (from..=to)
        .map(|n| {
            json!({
                "id": format!("n{n:05}"), "type": "note", "clock": { "peer": 9 },
                "deletedAt": DELETED_AT, "serverCursor": 7,
            })
        })
        .collect();
    answer(json!({ "items": [], "purgedTombstones": markers }))
}

/// The first `MAX_PROBED` rows never resolve (unattested markers), and the
/// row behind them is still asked about by the second check: the window
/// starts after the last row asked and wraps around.
#[tokio::test]
async fn rows_that_never_resolve_do_not_starve_the_rest() {
    let db = scratch_db();
    db.call_blocking(|conn| {
        for n in 0..=MAX_PROBED {
            conn.execute(
                "INSERT INTO sync_items (item_type, item_id, payload, payload_state, clock, updated_at)
                 VALUES ('note', ?1, '{}', 'full', '{\"peer\":1}', 1)",
                [format!("n{n:05}")],
            )
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })?;
        }
        Ok(())
    })
    .expect("seeded");
    let chunks = MAX_PROBED / 100;
    let mut script = vec![response(200, &manifest(&[]))];
    script.extend((0..chunks).map(|_| response(200, &unattested_markers(0, MAX_PROBED - 1))));
    let transport = FakeTransport::new(script);
    let pull = keyed_pull(&db, transport.clone());
    let check = ManifestCheck::default();
    let start = now_ms();
    let last = pair("note", &format!("n{MAX_PROBED:05}"));

    let first = check.run(&pull, start).await.expect("the check");
    let mut reuploaded = first.expect("not throttled").reuploaded;

    transport.push(response(200, &manifest(&[])));
    for _ in 0..chunks {
        transport.push(response(200, &unattested_markers(0, MAX_PROBED - 1)));
    }
    let second = check
        .run(&pull, start + 31 * MINUTE_MS)
        .await
        .expect("the next check");
    reuploaded.extend(second.expect("not throttled").reuploaded);

    assert_eq!(reuploaded, vec![last.clone()]);
    assert!(queued(&db).contains(&(last.0, last.1, "create".to_owned())));
    assert_eq!(transport.calls_to("/sync/pull").len(), 2 * chunks);
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
