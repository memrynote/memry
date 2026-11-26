//! A pulled delete whose signer is not in the pass's device directory
//! (chapter 01 §1.4.0, #5413).
//!
//! `VaultSync::sync_now` end to end: real `HttpClient`, `AuthSession`, SQLite,
//! sealing and signature checks; the transport is scripted in call order.
//!
//! | Test                                                          | Rule             |
//! | ------------------------------------------------------------- | ---------------- |
//! | the delete applies on the next pass, after the refetch        | §1.4.0, #5413    |
//! | a local edit is held while the delete waits, never pushed     | §5.8, #5413      |
//! | a delete whose signature fails otherwise is never re-pulled   | §5.14, #5340     |
//! | a signer that never appears stops being re-pulled             | #5413            |
//! | a local edit after the refusal neither ends the wait nor wins | §5.8, #5413      |
//! | a new refusal of a given-up id gets a fresh budget            | #5413            |
//! | an edit held under #5426's id-only key stays held             | #5413, C89.1     |
//! | a failed re-pull counts unless the transport failed           | #5413            |
//! | a verified record skipped as older ends the wait              | §5.8, #5413      |
//! | a refusal an older build recorded is re-pulled once adopted   | #5413            |
//! | one an older build records after this build ran is adopted too | #5413, C89.1    |
//! | a verified record of another type with the same id waits on    | #5413, C89.1    |
//! | an edit queued over a verified delete never undeletes        | §5.8, #5413      |
//! | a queued edit of a deleted row is never sent                  | §5.8, #5413      |
//! | a re-create whose clock is after the delete is still sent     | §5.8 client rule |
//! | a settings edit over a deleted payload-less row pushes merged | #5433            |
//! | a captive portal's answers never release a settings hold      | #5247            |

use crate::http_fakes;

use std::collections::BTreeMap;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, FakeTransport, jwt, response};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::errors::{StorageError, TransportError};
use memry_core::api::vault::Vault;
use memry_core::crypto::{keys, sodium};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::protocol::envelope::{self, RecordMaterial, RecordRequest, SyncOperation};
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::seams::transport::HttpResponse;
use memry_core::storage::Db;
use memry_core::storage::repositories::{Change as RepoChange, sync_items};
use memry_core::sync::outbox::{self, Change};
use rusqlite::params;
use serde_json::{Value as Json, json};

const BASE: &str = "https://sync.example.com";
const MASTER_KEY: [u8; 32] = [7u8; 32];
const THIS_DEVICE_SEED: [u8; 32] = [11u8; 32];
/// The device that registered and deleted after this pass fetched the list.
const NEW_DEVICE_SEED: [u8; 32] = [13u8; 32];
const NEW_DEVICE: &str = "server-device-2";

type Scripted = Result<HttpResponse, TransportError>;

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn vault(label: &str, transport: Arc<FakeTransport>) -> (Vault, Db, Arc<AuthSession>) {
    let (_public, secret) = sodium::sign_seed_keypair(&THIS_DEVICE_SEED).expect("a keypair");
    let store = FakeSecureStore::new();
    store.put_text(
        SecureStoreKey::AccessToken,
        &jwt(json!({"sub": "user-1", "device_id": "server-device-1", "type": "access", "exp": 9_999_999_999u64})),
    );
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .expect("plant the master key");
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");
    let dir = crate::support::scratch_dir(&format!("unknown-signer-{label}")).keep();
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    let side = memry_core::storage::open_data(&dir.join("data.db")).expect("a second handle");
    let session = Arc::new(
        AuthSession::new(
            transport,
            store,
            BASE.to_string(),
            "ios".to_string(),
            DeviceDescriptor {
                name: "Phone".to_string(),
                platform: DevicePlatform::Ios,
                form_factor: None,
                os_version: None,
                app_version: "1.0.0".to_string(),
                vault_id: None,
            },
            None,
        )
        .expect("a session"),
    );
    (vault, side, session)
}

/// `GET /auth/devices`: this device, plus the new one once it is listed.
fn devices(with_new: bool) -> Scripted {
    let key = |seed: &[u8; 32]| {
        let (public, _secret) = sodium::sign_seed_keypair(seed).expect("a keypair");
        BASE64.encode(&public)
    };
    let mut listed =
        vec![json!({"id": "server-device-1", "signingPublicKey": key(&THIS_DEVICE_SEED)})];
    if with_new {
        listed.push(json!({"id": NEW_DEVICE, "signingPublicKey": key(&NEW_DEVICE_SEED)}));
    }
    response(200, &json!({ "devices": listed }).to_string())
}

/// `id`'s clockless delete, signed by the new device.
fn delete_by_new_device(item_type: &str, id: &str) -> Json {
    clocked_delete_by_new_device(item_type, id, None)
}

fn clocked_delete_by_new_device(
    item_type: &str,
    id: &str,
    clock: Option<BTreeMap<String, u64>>,
) -> Json {
    signed_delete(&NEW_DEVICE_SEED, NEW_DEVICE, item_type, id, clock)
}

fn signed_delete(
    seed: &[u8; 32],
    signer: &str,
    item_type: &str,
    id: &str,
    clock: Option<BTreeMap<String, u64>>,
) -> Json {
    let vault_key = keys::derive_vault_key(&MASTER_KEY).expect("the vault key");
    let (_public, secret) = sodium::sign_seed_keypair(seed).expect("a keypair");
    let sealed = envelope::encrypt(
        &RecordRequest {
            id,
            item_type,
            operation: SyncOperation::Delete,
            content: b"",
            vault_key: &vault_key[..],
            signing_secret_key: &secret[..],
            signer_device_id: signer,
            clock,
            state_vector: None,
            deleted_at: Some(1_760_000_000_000),
        },
        &RecordMaterial::random(),
    )
    .expect("sealed");
    let mut json = envelope::to_json(&sealed.envelope);
    json["serverCursor"] = json!(3);
    json
}

/// A feed page that lists `deleted`, then the by-id pull that returns them.
fn deleted_page(deleted: &[&str], items: Vec<Json>) -> [Scripted; 2] {
    [
        response(
            200,
            &json!({"items": [], "deleted": deleted, "hasMore": false, "nextCursor": 3, "noteBodies": []})
                .to_string(),
        ),
        response(200, &json!({ "items": items }).to_string()),
    ]
}

fn empty_changes() -> Scripted {
    response(
        200,
        &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": 3, "noteBodies": []})
            .to_string(),
    )
}

fn live_row(side: &Db, item_type: &str, id: &str) {
    let (item_type, id) = (item_type.to_owned(), id.to_owned());
    side.call_blocking(move |conn| {
        sync_items::upsert_metadata_only(conn, &item_type, &id, 1, Some(1))
    })
    .expect("a live row");
}

fn deleted(side: &Db, item_type: &str, id: &str) -> bool {
    let (item_type, id) = (item_type.to_owned(), id.to_owned());
    side.call_blocking(move |conn| sync_items::load(conn, &item_type, &id))
        .expect("read")
        .expect("the row")
        .deleted_at
        .is_some()
}

fn urls(transport: &FakeTransport) -> Vec<String> {
    transport
        .calls()
        .iter()
        .map(|call| call.url.trim_start_matches(BASE).to_owned())
        .collect()
}

#[tokio::test]
async fn a_delete_from_a_device_the_list_did_not_hold_yet_applies_on_the_next_pass() {
    let [page, pulled] = deleted_page(
        &["deadnotexxxx"],
        vec![delete_by_new_device("note", "deadnotexxxx")],
    );
    let transport = FakeTransport::new(vec![devices(false), page, pulled]);
    let (vault, side, session) = vault("next-pass", transport.clone());
    live_row(&side, "note", "deadnotexxxx");
    let sync = vault.sync(session);

    sync.sync_now().await.expect("the first pass");
    assert!(!deleted(&side, "note", "deadnotexxxx"), "unverified: kept");

    // The next pass fetches the list again, which now holds the new device,
    // and re-pulls the refused delete by id before the feed.
    let first = transport.call_count();
    transport.push(devices(true));
    transport.push(response(
        200,
        &json!({"items": [delete_by_new_device("note", "deadnotexxxx")]}).to_string(),
    ));
    transport.push(empty_changes());
    let summary = sync.sync_now().await.expect("the second pass");

    assert!(deleted(&side, "note", "deadnotexxxx"), "{summary:?}");
    let second = &urls(&transport)[first..];
    assert_eq!(second[1], "/sync/pull", "{second:?}");
    assert!(second[2].starts_with("/sync/changes"), "{second:?}");

    // Settled: a third pass re-pulls nothing.
    transport.push(devices(true));
    transport.push(empty_changes());
    sync.sync_now().await.expect("the third pass");
}

#[tokio::test]
async fn an_edit_is_held_while_its_unverified_delete_waits() {
    let [page, pulled] = deleted_page(&["editor"], vec![delete_by_new_device("filter", "editor")]);
    let transport = FakeTransport::new(vec![devices(false), page, pulled]);
    let (vault, side, session) = vault("held-edit", transport.clone());
    side.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, server_cursor,
                                     updated_at)
             VALUES ('filter', 'editor', ?1, 'full', 1, 1)",
            params![r#"{"fontSize":14}"#],
        )
        .map_err(failed)?;
        outbox::commit(conn, &Change::upsert("filter", "editor"), 1, |_| Ok(())).map(|_| ())
    })
    .expect("an edited filter row");
    let sync = vault.sync(session);

    // The server takes any filter write over a delete, so sending the edit
    // now would bring the item back on every device. The script answers no
    // `/sync/push`: an attempt panics the transport.
    let summary = sync.sync_now().await.expect("the first pass");
    assert_eq!(summary.pending, 1, "the edit stays queued: {summary:?}");
    assert!(!deleted(&side, "filter", "editor"));

    push_due(&side);
    transport.push(devices(true));
    transport.push(re_pulled("filter", "editor"));
    transport.push(empty_changes());
    let summary = sync.sync_now().await.expect("the second pass");

    assert!(deleted(&side, "filter", "editor"));
    pushed_only_the_delete(&transport, "editor", summary.pending);
}

#[tokio::test]
async fn a_delete_whose_signature_fails_for_another_reason_is_never_re_pulled() {
    let mut forged = delete_by_new_device("note", "deadnotexxxx");
    forged["signature"] = delete_by_new_device("note", "othernotexxx")["signature"].clone();
    let [page, pulled] = deleted_page(&["deadnotexxxx"], vec![forged]);
    // The new device is listed from the start: the signer resolves, and the
    // signature is over another item.
    let transport = FakeTransport::new(vec![devices(true), page, pulled]);
    let (vault, side, session) = vault("forged", transport.clone());
    live_row(&side, "note", "deadnotexxxx");
    let sync = vault.sync(session);

    sync.sync_now().await.expect("the first pass");
    let first = transport.call_count();
    transport.push(devices(true));
    transport.push(empty_changes());
    sync.sync_now().await.expect("the second pass");

    assert!(!deleted(&side, "note", "deadnotexxxx"));
    let second = &urls(&transport)[first..];
    assert!(second.iter().all(|url| url != "/sync/pull"), "{second:?}");
}

/// A record still unverifiable is an unusable answer, not the server's
/// absence (#5502): it counts toward [`MAX_FAILURES`], not [`MAX_RETRIES`].
#[tokio::test]
async fn a_signer_that_never_appears_stops_being_re_pulled() {
    let [page, pulled] = deleted_page(
        &["deadnotexxxx"],
        vec![delete_by_new_device("note", "deadnotexxxx")],
    );
    let transport = FakeTransport::new(vec![devices(false), page, pulled]);
    let (vault, side, session) = vault("bounded", transport.clone());
    live_row(&side, "note", "deadnotexxxx");
    let sync = vault.sync(session);
    sync.sync_now().await.expect("the refusing pass");

    // Fifty passes re-pull it; after that the row is left as it is.
    for pass in 0..52 {
        let before = transport.call_count();
        transport.push(devices(false));
        if pass < 50 {
            transport.push(response(
                200,
                &json!({"items": [delete_by_new_device("note", "deadnotexxxx")]}).to_string(),
            ));
        }
        transport.push(empty_changes());
        sync.sync_now().await.expect("a pass");
        let urls = &urls(&transport)[before..];
        assert_eq!(urls[1] == "/sync/pull", pass < 50, "pass {pass}: {urls:?}");
    }

    assert!(
        !deleted(&side, "note", "deadnotexxxx"),
        "never verified: kept"
    );
}

/// Ends any push backoff, so the next pass's wave sends the queue for certain.
fn push_due(side: &Db) {
    side.call_blocking(|conn| {
        conn.execute("UPDATE outbox SET next_attempt_at = NULL", [])
            .map_err(failed)
            .map(|_| ())
    })
    .expect("the queue due");
}

fn accepted(id: &str) -> Scripted {
    response(
        200,
        &json!({"accepted": [id], "rejected": [], "serverTime": 1, "maxCursor": 4}).to_string(),
    )
}

/// No record of `id` went out over its delete. The scripts answer no
/// `/sync/push`, so a send panics the transport; this also names the case
/// where a push was legitimately queued: only a delete may carry the id.
fn never_pushed_over_the_delete(transport: &FakeTransport, id: &str) {
    for push in transport.calls_to("/sync/push") {
        let body: Json = serde_json::from_slice(&push.body.expect("a body")).expect("json");
        for item in body["items"].as_array().expect("items") {
            if item["id"] == id {
                assert_eq!(
                    item["operation"], "delete",
                    "an edit over the delete: {item}"
                );
            }
        }
    }
}

/// Every pushed record of `id` carries the delete: nothing went over it, and
/// nothing is left queued to go over it later (`pending` of the last pass).
fn pushed_only_the_delete(transport: &FakeTransport, id: &str, pending: u32) {
    assert_eq!(pending, 0, "the edit is retired, not deferred");
    never_pushed_over_the_delete(transport, id);
}

fn re_pulled(item_type: &str, id: &str) -> Scripted {
    response(
        200,
        &json!({"items": [delete_by_new_device(item_type, id)]}).to_string(),
    )
}

#[tokio::test]
async fn a_local_edit_after_the_refusal_neither_ends_the_wait_nor_wins() {
    let id = "editor";
    let [page, pulled] = deleted_page(&[id], vec![delete_by_new_device("filter", id)]);
    let transport = FakeTransport::new(vec![devices(false), page, pulled]);
    let (vault, side, session) = vault("edit-after", transport.clone());
    side.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, server_cursor,
                                     updated_at)
             VALUES ('filter', 'editor', '{}', 'full', 1, 1)",
            [],
        )
        .map_err(failed)
        .map(|_| ())
    })
    .expect("a filter row");
    let sync = vault.sync(session);
    sync.sync_now().await.expect("the refusing pass");

    // The edit clears the row's corrupt flag; the refusal must outlive it.
    side.call_blocking(|conn| {
        let name = [("name", RepoChange::Set(json!("dark")))];
        outbox::commit(conn, &Change::upsert("filter", id), 2, |tx| {
            sync_items::apply_local_edit_in(tx, "filter", id, &name, 2).map(|_| ())
        })
        .map(|_| ())
    })
    .expect("a local filter edit");

    let first = transport.call_count();
    transport.push(devices(true));
    transport.push(re_pulled("filter", id));
    transport.push(empty_changes());
    let summary = sync.sync_now().await.expect("the second pass");

    assert_eq!(urls(&transport)[first + 1], "/sync/pull");
    assert!(deleted(&side, "filter", id));
    pushed_only_the_delete(&transport, id, summary.pending);
}

/// A #5426 install recorded the wait as `sync.unknown_signer_retries:{id}`
/// only; the edit already cleared the row's flag, so that key is the hold
/// (REVIEW-5448).
#[tokio::test]
async fn an_edit_held_under_an_id_only_key_stays_held() {
    let id = "editor";
    let [page, pulled] = deleted_page(&[id], vec![delete_by_new_device("filter", id)]);
    let transport = FakeTransport::new(vec![devices(false), page, pulled]);
    let (vault, side, session) = vault("id-only-key", transport.clone());
    side.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, server_cursor,
                                     updated_at)
             VALUES ('filter', 'editor', '{}', 'full', 1, 1)",
            [],
        )
        .map_err(failed)
        .map(|_| ())
    })
    .expect("a filter row");
    let sync = vault.sync(session);
    sync.sync_now().await.expect("the refusing pass");
    side.call_blocking(|conn| {
        let name = [("name", RepoChange::Set(json!("dark")))];
        outbox::commit(conn, &Change::upsert("filter", id), 2, |tx| {
            sync_items::apply_local_edit_in(tx, "filter", id, &name, 2).map(|_| ())
        })
        .map(|_| ())
    })
    .expect("a local filter edit");
    side.call_blocking(|conn| {
        conn.execute_batch(
            "DELETE FROM meta WHERE key LIKE 'sync.unknown_signer%';
             INSERT INTO meta (key, value) VALUES ('sync.unknown_signer_retries:editor', '1'),
                                                  ('sync.unknown_signer_seeded', '1');",
        )
        .map_err(failed)
    })
    .expect("the wait as #5426 recorded it");
    push_due(&side);

    let first = transport.call_count();
    transport.push(devices(false));
    transport.push(re_pulled("filter", id));
    transport.push(empty_changes());
    sync.sync_now().await.expect("the first pass of this build");

    assert_eq!(urls(&transport)[first + 1], "/sync/pull");
    never_pushed_over_the_delete(&transport, id);
    let pending: i64 = side
        .call_blocking(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM outbox WHERE item_id = 'editor'",
                [],
                |row| row.get(0),
            )
            .map_err(failed)
        })
        .expect("the queue");
    assert_eq!(pending, 1, "the edit stays queued");
    assert!(!deleted(&side, "filter", id), "still unverified");
}

#[tokio::test]
async fn a_new_refusal_of_a_given_up_id_gets_a_fresh_budget() {
    let [page, pulled] = deleted_page(
        &["deadnotexxxx"],
        vec![delete_by_new_device("note", "deadnotexxxx")],
    );
    let transport = FakeTransport::new(vec![devices(false), page, pulled]);
    let (vault, side, session) = vault("fresh-budget", transport.clone());
    live_row(&side, "note", "deadnotexxxx");
    let sync = vault.sync(session);
    sync.sync_now().await.expect("the refusing pass");
    for _ in 0..5 {
        transport.push(devices(false));
        transport.push(response(200, r#"{"items":[]}"#));
        transport.push(empty_changes());
        sync.sync_now().await.expect("a re-pulling pass");
    }

    // Given up; then the feed serves the delete again and it is refused again.
    let [page, pulled] = deleted_page(
        &["deadnotexxxx"],
        vec![delete_by_new_device("note", "deadnotexxxx")],
    );
    transport.push(devices(false));
    transport.push(page);
    transport.push(pulled);
    sync.sync_now().await.expect("the second refusal");

    let before = transport.call_count();
    transport.push(devices(true));
    transport.push(re_pulled("note", "deadnotexxxx"));
    transport.push(empty_changes());
    sync.sync_now()
        .await
        .expect("a pass with the new device listed");

    assert_eq!(urls(&transport)[before + 1], "/sync/pull");
    assert!(deleted(&side, "note", "deadnotexxxx"));
}

/// #5502: a re-pull that failed says nothing about the record. Five `{}`
/// pages and five server errors later it still waits, and once its signer is
/// listed the next re-pull applies it.
#[tokio::test]
async fn re_pulls_without_an_answer_keep_the_record_waiting() {
    let [page, pulled] = deleted_page(
        &["deadnotexxxx"],
        vec![delete_by_new_device("note", "deadnotexxxx")],
    );
    let transport = FakeTransport::new(vec![devices(false), page, pulled]);
    let (vault, side, session) = vault("failed-re-pull", transport.clone());
    live_row(&side, "note", "deadnotexxxx");
    let sync = vault.sync(session);
    sync.sync_now().await.expect("the refusing pass");

    let answers: [fn() -> Scripted; 4] = [
        || Err(TransportError::Cancelled),
        || response(200, "{}"),
        || response(200, "not json"),
        || {
            response(
                504,
                r#"{"error":{"code":"GATEWAY_TIMEOUT","message":"down"}}"#,
            )
        },
    ];
    for answer in answers {
        for _ in 0..5 {
            transport.push(devices(false));
            transport.push(answer());
            transport.push(empty_changes());
            sync.sync_now().await.expect("a failed re-pull");
        }
    }

    let before = transport.call_count();
    transport.push(devices(true));
    transport.push(re_pulled("note", "deadnotexxxx"));
    transport.push(empty_changes());
    sync.sync_now()
        .await
        .expect("a pass with the new device listed");
    assert_eq!(urls(&transport)[before + 1], "/sync/pull");
    assert!(deleted(&side, "note", "deadnotexxxx"));
}

/// #5502: only a well-formed page that leaves the id out counts an attempt;
/// five of them and the record is no longer re-pulled.
#[tokio::test]
async fn well_formed_re_pulls_without_the_record_give_up() {
    let [page, pulled] = deleted_page(
        &["deadnotexxxx"],
        vec![delete_by_new_device("note", "deadnotexxxx")],
    );
    let transport = FakeTransport::new(vec![devices(false), page, pulled]);
    let (vault, side, session) = vault("absent-re-pull", transport.clone());
    live_row(&side, "note", "deadnotexxxx");
    let sync = vault.sync(session);
    sync.sync_now().await.expect("the refusing pass");

    for pass in 0..7 {
        let before = transport.call_count();
        transport.push(devices(false));
        if pass < 5 {
            transport.push(response(200, r#"{"items":[]}"#));
        }
        transport.push(empty_changes());
        sync.sync_now().await.expect("a pass");
        let urls = &urls(&transport)[before..];
        assert_eq!(urls[1] == "/sync/pull", pass < 5, "pass {pass}: {urls:?}");
    }
    assert!(!deleted(&side, "note", "deadnotexxxx"));
}

#[tokio::test]
async fn a_verified_record_skipped_as_older_ends_the_wait() {
    let older = || Some(BTreeMap::from([("server-device-1".to_owned(), 1u64)]));
    let [page, pulled] = deleted_page(
        &["keptaskxxxxx"],
        vec![clocked_delete_by_new_device(
            "task",
            "keptaskxxxxx",
            older(),
        )],
    );
    let transport = FakeTransport::new(vec![devices(false), page, pulled]);
    let (vault, side, session) = vault("skipped-older", transport.clone());
    side.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, server_cursor,
                                     updated_at, clock)
             VALUES ('task', 'keptaskxxxxx', NULL, 'metadata-only', 1, 1, ?1)",
            params![r#"{"server-device-1":5}"#],
        )
        .map_err(failed)
        .map(|_| ())
    })
    .expect("a row edited after the delete");
    let sync = vault.sync(session);
    sync.sync_now().await.expect("the refusing pass");

    transport.push(devices(true));
    transport.push(response(
        200,
        &json!({"items": [clocked_delete_by_new_device("task", "keptaskxxxxx", older())]})
            .to_string(),
    ));
    transport.push(empty_changes());
    sync.sync_now().await.expect("the verifying pass");
    assert!(
        !deleted(&side, "task", "keptaskxxxxx"),
        "the later edit keeps it"
    );

    let before = transport.call_count();
    transport.push(devices(true));
    transport.push(empty_changes());
    sync.sync_now().await.expect("a settled pass");
    let urls = &urls(&transport)[before..];
    assert!(urls.iter().all(|url| url != "/sync/pull"), "{urls:?}");
}

#[tokio::test]
async fn a_refusal_an_older_build_recorded_is_re_pulled() {
    let transport = FakeTransport::new(vec![]);
    let (vault, side, session) = vault("older-build", transport.clone());
    live_row(&side, "note", "deadnotexxxx");
    refused_by_an_older_build(&side, "note", "deadnotexxxx");
    let sync = vault.sync(session);

    transport.push(devices(true));
    transport.push(re_pulled("note", "deadnotexxxx"));
    transport.push(empty_changes());
    sync.sync_now().await.expect("the first pass of this build");

    assert!(deleted(&side, "note", "deadnotexxxx"));
}

/// A refusal recorded the way a build before #5426 does: in `corrupt_reason`
/// only, with no retry row.
fn refused_by_an_older_build(side: &Db, item_type: &str, id: &str) {
    let (item_type, id) = (item_type.to_owned(), id.to_owned());
    side.call_blocking(move |conn| {
        let reason = format!(
            "could not open the record: signer device `{NEW_DEVICE}`{}",
            memry_core::protocol::account::UNKNOWN_SIGNER
        );
        sync_items::mark_corrupt(conn, &item_type, &id, &reason, 1)
    })
    .expect("a refusal recorded only in corrupt_reason");
}

/// Downgrade, refuse, upgrade: the older build's refusal comes after this
/// build already adopted the earlier ones (VERIFY-5426).
#[tokio::test]
async fn a_refusal_an_older_build_records_after_this_build_ran_is_re_pulled() {
    let transport = FakeTransport::new(vec![devices(false), empty_changes()]);
    let (vault, side, session) = vault("downgraded", transport.clone());
    live_row(&side, "note", "deadnotexxxx");
    let sync = vault.sync(session);
    sync.sync_now().await.expect("a pass of this build");

    refused_by_an_older_build(&side, "note", "deadnotexxxx");
    transport.push(devices(true));
    transport.push(re_pulled("note", "deadnotexxxx"));
    transport.push(empty_changes());
    sync.sync_now().await.expect("the pass after the upgrade");

    assert!(deleted(&side, "note", "deadnotexxxx"));
}

/// A verified record ends the wait of its own `(type, id)` only.
#[tokio::test]
async fn a_verified_record_of_another_type_with_the_same_id_does_not_end_the_wait() {
    let [page, pulled] = deleted_page(
        &["sameidxxxxxx"],
        vec![delete_by_new_device("note", "sameidxxxxxx")],
    );
    let transport = FakeTransport::new(vec![devices(false), page, pulled]);
    let (vault, side, session) = vault("same-id", transport.clone());
    live_row(&side, "note", "sameidxxxxxx");
    let sync = vault.sync(session);
    sync.sync_now().await.expect("the refusing pass");

    let this_device = signed_delete(
        &THIS_DEVICE_SEED,
        "server-device-1",
        "task",
        "sameidxxxxxx",
        None,
    );
    transport.push(devices(false));
    transport.push(re_pulled("note", "sameidxxxxxx"));
    // The server's by-id pull serves every type with that id.
    let [page, pulled] = deleted_page(
        &["sameidxxxxxx"],
        vec![delete_by_new_device("note", "sameidxxxxxx"), this_device],
    );
    transport.push(page);
    transport.push(pulled);
    sync.sync_now().await.expect("a pass verifying the task");

    transport.push(devices(true));
    transport.push(re_pulled("note", "sameidxxxxxx"));
    transport.push(empty_changes());
    sync.sync_now()
        .await
        .expect("the pass that knows the signer");

    assert!(deleted(&side, "note", "sameidxxxxxx"));
}

/// The general case: a verified delete on the feed applies over a row whose
/// edit is still queued. The server takes any filter write over a delete,
/// so the edit must not go out (VERIFY-5426).
#[tokio::test]
async fn an_edit_queued_over_a_verified_delete_never_undeletes_it() {
    let [page, pulled] = deleted_page(&["editor"], vec![delete_by_new_device("filter", "editor")]);
    // The script answers no `/sync/push`: an attempt panics the transport.
    let transport = FakeTransport::new(vec![devices(true), page, pulled]);
    let (vault, side, session) = vault("edit-under-delete", transport.clone());
    side.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, server_cursor,
                                     updated_at)
             VALUES ('filter', 'editor', ?1, 'full', 1, 1)",
            params![r#"{"fontSize":14}"#],
        )
        .map_err(failed)?;
        outbox::commit(conn, &Change::upsert("filter", "editor"), 1, |_| Ok(())).map(|_| ())
    })
    .expect("an edited filter row");

    let summary = vault.sync(session).sync_now().await.expect("the pass");

    assert!(deleted(&side, "filter", "editor"));
    pushed_only_the_delete(&transport, "editor", summary.pending);
}

/// Second line: a queued upsert whose row is deleted retires unsent, however
/// it got there.
#[tokio::test]
async fn a_queued_edit_of_a_deleted_row_is_never_sent() {
    let transport = FakeTransport::new(vec![devices(true), empty_changes()]);
    let (vault, side, session) = vault("deleted-row-queued", transport.clone());
    side.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, server_cursor,
                                     updated_at, deleted_at)
             VALUES ('filter', 'editor', ?1, 'full', 1, 1, 5)",
            params![r#"{"fontSize":14}"#],
        )
        .map_err(failed)?;
        outbox::commit(conn, &Change::upsert("filter", "editor"), 1, |_| Ok(())).map(|_| ())
    })
    .expect("a deleted row with a queued edit");

    let summary = vault.sync(session).sync_now().await.expect("the pass");

    pushed_only_the_delete(&transport, "editor", summary.pending);
}

/// §5.8's client rule: a live row whose clock happens after the delete's is a
/// re-create that saw the delete. The delete is skipped and the edit is sent.
#[tokio::test]
async fn a_re_create_whose_clock_is_after_the_delete_is_still_sent() {
    const TASK: &str = "taskrecreate";
    let delete_clock = BTreeMap::from([(NEW_DEVICE.to_owned(), 1)]);
    let [page, pulled] = deleted_page(
        &[TASK],
        vec![clocked_delete_by_new_device(
            "task",
            TASK,
            Some(delete_clock),
        )],
    );
    let transport = FakeTransport::new(vec![devices(true), page, pulled, accepted(TASK)]);
    let (vault, side, session) = vault("re-create", transport.clone());
    side.call_blocking(|conn| {
        let clock = format!(r#"{{"{NEW_DEVICE}":1,"server-device-1":1}}"#);
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, server_cursor,
                                     updated_at, clock)
             VALUES ('task', ?1, ?2, 'full', 1, 1, ?3)",
            params![
                TASK,
                format!(r#"{{"title":"Again","clock":{clock}}}"#),
                clock
            ],
        )
        .map_err(failed)?;
        outbox::commit(conn, &Change::upsert("task", TASK), 1, |_| Ok(())).map(|_| ())
    })
    .expect("a re-created task with its edit queued");

    let summary = vault.sync(session).sync_now().await.expect("the pass");

    assert!(!deleted(&side, "task", TASK), "{summary:?}");
    let pushes = transport.calls_to("/sync/push");
    assert_eq!(pushes.len(), 1, "{summary:?}");
    let body: Json =
        serde_json::from_slice(pushes[0].body.as_deref().expect("a body")).expect("json");
    let item = &body["items"][0];
    assert_eq!(item["id"], TASK);
    assert_eq!(item["operation"], "update", "{item}");
    assert!(item.get("deletedAt").is_none_or(Json::is_null), "{item}");
    assert_eq!(summary.pending, 0, "{summary:?}");
}

/// `synced_settings`, live on the server, sealed by the listed new device.
fn live_settings_by_new_device(payload: &Json, cursor: i64) -> Json {
    let vault_key = keys::derive_vault_key(&MASTER_KEY).expect("the vault key");
    let (_public, secret) = sodium::sign_seed_keypair(&NEW_DEVICE_SEED).expect("a keypair");
    let content = payload.to_string();
    let sealed = envelope::encrypt(
        &RecordRequest {
            id: "synced_settings",
            item_type: "settings",
            operation: SyncOperation::Update,
            content: content.as_bytes(),
            vault_key: &vault_key[..],
            signing_secret_key: &secret[..],
            signer_device_id: NEW_DEVICE,
            clock: None,
            state_vector: None,
            deleted_at: None,
        },
        &RecordMaterial::random(),
    )
    .expect("sealed");
    let mut json = envelope::to_json(&sealed.envelope);
    json["serverCursor"] = json!(cursor);
    json
}

/// REVIEW-5447 #1 (#5433): a build before #5434 marked the settings row deleted
/// with no payload while the server copy stayed live below the cursor. A local
/// edit seeds the row, but its push waits for a re-pull that merges the
/// server's settings: the pushed payload carries every server key plus the
/// edit, never a one-key object that would replace the account's settings.
#[tokio::test]
async fn a_settings_edit_over_a_deleted_payloadless_row_pushes_the_merged_settings() {
    let server = json!({
        "settings": {"general": {"theme": "dark"}, "editor": {"font": "serif"}},
        "fieldClocks": {"general.theme": {NEW_DEVICE: 3}, "editor.font": {NEW_DEVICE: 2}},
    });
    let transport = FakeTransport::new(vec![
        devices(true),
        response(
            200,
            &json!({"items": [live_settings_by_new_device(&server, 5)]}).to_string(),
        ),
        empty_changes(),
        accepted("synced_settings"),
    ]);
    let (vault, side, session) = vault("settings-refetch", transport.clone());
    seed_settings_edit(&side);

    let summary = vault.sync(session).sync_now().await.expect("the pass");

    let sent = sent_settings(&transport);
    assert_eq!(
        sent["settings"],
        json!({"general": {"theme": "dark"}, "editor": {"font": "serif", "zoom": 120}}),
        "{sent}"
    );
    assert_eq!(summary.pending, 0, "{summary:?}");
}

/// A build before #5434 left the settings row deleted with no payload; a
/// local edit over it seeds the row and is held for a re-pull (#5433).
fn seed_settings_edit(side: &Db) {
    side.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, server_cursor,
                                     updated_at, deleted_at)
             VALUES ('settings', 'synced_settings', NULL, 'metadata-only', 10, 2, 2)",
            [],
        )
        .map_err(failed)?;
        memry_core::domain::settings::set(conn, "editor.zoom", json!(120), "device-a", 3)
            .map(|_| ())
    })
    .expect("an edit over the deleted payload-less row");
}

/// The settings payload of the one push sent, decrypted.
fn sent_settings(transport: &FakeTransport) -> Json {
    let pushes = transport.calls_to("/sync/push");
    assert_eq!(pushes.len(), 1, "one push");
    let body: Json =
        serde_json::from_slice(pushes[0].body.as_deref().expect("a body")).expect("json");
    let item = &body["items"][0];
    assert_eq!(item["id"], "synced_settings");
    let (public, _secret) = sodium::sign_seed_keypair(&THIS_DEVICE_SEED).expect("a keypair");
    let vault_key = keys::derive_vault_key(&MASTER_KEY).expect("the vault key");
    let sent = envelope::decrypt(
        &envelope::from_json(item).expect("an envelope"),
        &vault_key[..],
        &public,
    )
    .expect("decrypt the push");
    serde_json::from_slice(&sent).expect("json")
}

/// Runs passes whose settings re-pull gets `re_pull`. The scripts answer no
/// `/sync/push`, so a released edit panics the transport.
async fn held_passes(label: &str, passes: usize, listed: bool, re_pull: impl Fn() -> Scripted) {
    let transport = FakeTransport::new(vec![]);
    let (vault, side, session) = vault(label, transport.clone());
    seed_settings_edit(&side);
    let sync = vault.sync(session);
    for pass in 0..passes {
        transport.push(devices(listed));
        transport.push(re_pull());
        transport.push(empty_changes());
        push_due(&side);
        let summary = sync.sync_now().await.expect("a pass");
        assert_eq!(summary.pending, 1, "pass {pass}: {summary:?}");
    }
    assert!(transport.calls_to("/sync/push").is_empty());
}

/// VERIFY-5447 r3 #1: a 200 page with no `items` is not an answer about the
/// server copy. Passes past [`MAX_RETRIES`] of it keep the one-key edit held.
#[tokio::test]
async fn settings_re_pulls_answered_without_items_keep_the_seeded_edit_held() {
    held_passes("settings-refetch-no-items", 7, true, || response(200, "{}")).await;
}

/// VERIFY-5447 r3 #4: a server error says nothing about the server copy, so
/// it counts toward no bound. Passes up to [`MAX_FAILURES`] of it
/// keep the one-key edit held (504 is not retried within a pass).
#[tokio::test]
async fn settings_re_pulls_failing_with_a_server_error_keep_the_seeded_edit_held() {
    held_passes("settings-refetch-5xx", 52, true, || {
        response(
            504,
            r#"{"error":{"code":"GATEWAY_TIMEOUT","message":"down"}}"#,
        )
    })
    .await;
}

/// VERIFY-5447 r4 #8: a captive portal or proxy answers in the server's place.
/// None of its answers is about the server copy or the request, so passes past
/// [`MAX_FAILURES`] of each keep the one-key edit held.
#[tokio::test]
async fn settings_re_pulls_a_captive_portal_answers_keep_the_seeded_edit_held() {
    let answers = [
        (
            "settings-portal-page",
            200,
            "<html>Sign in to the network</html>",
        ),
        ("settings-portal-empty", 200, "{}"),
        ("settings-portal-403", 403, "<html>Forbidden</html>"),
        (
            "settings-portal-407",
            407,
            "<html>Proxy authentication</html>",
        ),
    ];
    for (label, status, body) in answers {
        held_passes(label, 52, true, || response(status, body)).await;
    }
}

/// The server's own refusal of the re-pull is about the request and may
/// persist: the fiftieth releases the seeded edit.
#[tokio::test]
async fn settings_re_pulls_the_server_refuses_release_the_seeded_edit() {
    let transport = FakeTransport::new(vec![]);
    let (vault, side, session) = vault("settings-refetch-refused", transport.clone());
    seed_settings_edit(&side);
    let sync = vault.sync(session);
    for pass in 0..50 {
        transport.push(devices(true));
        transport.push(response(
            400,
            r#"{"error":{"code":"VALIDATION_ERROR","message":"bad ids"}}"#,
        ));
        transport.push(empty_changes());
        if pass == 49 {
            transport.push(accepted("synced_settings"));
        }
        push_due(&side);
        let summary = sync.sync_now().await.expect("a pass");
        let pending = if pass == 49 { 0 } else { 1 };
        assert_eq!(summary.pending, pending, "pass {pass}: {summary:?}");
    }
}

/// The server answers well-formed pages that leave `synced_settings` out: it
/// holds no copy. The fifth such pass releases the seeded edit, and the push
/// carries the seed plus the edit.
#[tokio::test]
async fn well_formed_re_pulls_without_the_settings_release_the_seeded_edit() {
    let transport = FakeTransport::new(vec![]);
    let (vault, side, session) = vault("settings-refetch-absent", transport.clone());
    seed_settings_edit(&side);
    let sync = vault.sync(session);
    for pass in 0..5 {
        transport.push(devices(true));
        transport.push(response(200, r#"{"items":[]}"#));
        transport.push(empty_changes());
        if pass == 4 {
            transport.push(accepted("synced_settings"));
        }
        push_due(&side);
        let summary = sync.sync_now().await.expect("a pass");
        let pending = if pass == 4 { 0 } else { 1 };
        assert_eq!(summary.pending, pending, "pass {pass}: {summary:?}");
    }
    let sent = sent_settings(&transport);
    assert_eq!(sent["settings"], json!({"editor": {"zoom": 120}}), "{sent}");
}

/// VERIFY-5447 #2: the server copy is sealed by a device the list does not
/// hold yet, so every re-pull comes back unverifiable. That is a copy, not its
/// absence: passes past [`MAX_RETRIES`] of it keep the one-key edit held.
#[tokio::test]
async fn unverifiable_settings_re_pulls_keep_the_seeded_edit_held() {
    let server = json!({
        "settings": {"general": {"theme": "dark"}},
        "fieldClocks": {"general.theme": {NEW_DEVICE: 3}},
    });
    held_passes("settings-refetch-unverifiable", 7, false, || {
        response(
            200,
            &json!({"items": [live_settings_by_new_device(&server, 5)]}).to_string(),
        )
    })
    .await;
}
