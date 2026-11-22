//! A pulled delete whose signer is not in the pass's device directory
//! (chapter 01 §1.4.0, #5413).
//!
//! `VaultSync::sync_now` end to end: real `HttpClient`, `AuthSession`, SQLite,
//! sealing and signature checks; the transport is scripted in call order.
//!
//! | Test                                                        | Rule              |
//! | ----------------------------------------------------------- | ----------------- |
//! | the delete applies on the next pass, after the refetch       | §1.4.0, #5413     |
//! | a local edit is held while the delete waits, never pushed    | §5.8, #5413       |
//! | a delete whose signature fails otherwise is never re-pulled  | §5.14, #5340      |
//! | a signer that never appears stops being re-pulled            | #5413             |
//! | a local edit after the refusal neither ends the wait nor wins | §5.8, #5413       |
//! | a new refusal of a given-up id gets a fresh budget           | #5413             |
//! | a failed re-pull counts unless the transport failed          | #5413             |
//! | a verified record skipped as older ends the wait             | §5.8, #5413       |
//! | a refusal an older build recorded is re-pulled once adopted  | #5413             |

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
use memry_core::storage::repositories::sync_items;
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
    let vault_key = keys::derive_vault_key(&MASTER_KEY).expect("the vault key");
    let (_public, secret) = sodium::sign_seed_keypair(&NEW_DEVICE_SEED).expect("a keypair");
    let sealed = envelope::encrypt(
        &RecordRequest {
            id,
            item_type,
            operation: SyncOperation::Delete,
            content: b"",
            vault_key: &vault_key[..],
            signing_secret_key: &secret[..],
            signer_device_id: NEW_DEVICE,
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
async fn a_settings_edit_is_held_while_its_unverified_delete_waits() {
    let [page, pulled] = deleted_page(
        &["editor"],
        vec![delete_by_new_device("settings", "editor")],
    );
    let transport = FakeTransport::new(vec![devices(false), page, pulled]);
    let (vault, side, session) = vault("held-edit", transport.clone());
    side.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, server_cursor,
                                     updated_at)
             VALUES ('settings', 'editor', ?1, 'full', 1, 1)",
            params![r#"{"fontSize":14}"#],
        )
        .map_err(failed)?;
        outbox::commit(conn, &Change::upsert("settings", "editor"), 1, |_| Ok(())).map(|_| ())
    })
    .expect("an edited settings row");
    let sync = vault.sync(session);

    // The server takes any settings write over a delete, so sending the edit
    // now would bring the item back on every device. The script answers no
    // `/sync/push`: an attempt panics the transport.
    let summary = sync.sync_now().await.expect("the first pass");
    assert_eq!(summary.pending, 1, "the edit stays queued: {summary:?}");
    assert!(!deleted(&side, "settings", "editor"));

    push_due(&side);
    transport.push(devices(true));
    transport.push(re_pulled("settings", "editor"));
    transport.push(empty_changes());
    transport.push(accepted("editor"));
    sync.sync_now().await.expect("the second pass");

    assert!(deleted(&side, "settings", "editor"));
    pushed_only_the_delete(&transport, "editor");
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

    // Five passes re-pull it; after that the row is left as it is.
    for pass in 0..7 {
        let before = transport.call_count();
        transport.push(devices(false));
        if pass < 5 {
            transport.push(response(
                200,
                &json!({"items": [delete_by_new_device("note", "deadnotexxxx")]}).to_string(),
            ));
        }
        transport.push(empty_changes());
        sync.sync_now().await.expect("a pass");
        let urls = &urls(&transport)[before..];
        assert_eq!(urls[1] == "/sync/pull", pass < 5, "pass {pass}: {urls:?}");
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

/// Every pushed record of `id` carries the delete: nothing went over it.
fn pushed_only_the_delete(transport: &FakeTransport, id: &str) {
    // The verified delete retired the queued edit: sealed from the deleted
    // row it would be an `update` with `deletedAt`, which the server applies
    // as a write and so brings the item back.
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

fn re_pulled(item_type: &str, id: &str) -> Scripted {
    response(
        200,
        &json!({"items": [delete_by_new_device(item_type, id)]}).to_string(),
    )
}

#[tokio::test]
async fn a_local_edit_after_the_refusal_neither_ends_the_wait_nor_wins() {
    let id = "synced_settings";
    let [page, pulled] = deleted_page(&[id], vec![delete_by_new_device("settings", id)]);
    let transport = FakeTransport::new(vec![devices(false), page, pulled]);
    let (vault, side, session) = vault("edit-after", transport.clone());
    side.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, server_cursor,
                                     updated_at)
             VALUES ('settings', 'synced_settings', '{}', 'full', 1, 1)",
            [],
        )
        .map_err(failed)
        .map(|_| ())
    })
    .expect("a settings row");
    let sync = vault.sync(session);
    sync.sync_now().await.expect("the refusing pass");

    // The edit clears the row's corrupt flag; the refusal must outlive it.
    side.call_blocking(|conn| {
        memry_core::domain::settings::set(conn, "theme", json!("dark"), "server-device-1", 2)
            .map(|_| ())
    })
    .expect("a local settings edit");

    let first = transport.call_count();
    transport.push(devices(true));
    transport.push(re_pulled("settings", id));
    transport.push(empty_changes());
    transport.push(accepted(id));
    sync.sync_now().await.expect("the second pass");

    assert_eq!(urls(&transport)[first + 1], "/sync/pull");
    assert!(deleted(&side, "settings", id));
    pushed_only_the_delete(&transport, id);
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
        transport.push(re_pulled("note", "deadnotexxxx"));
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

#[tokio::test]
async fn a_failed_re_pull_counts_unless_the_transport_failed() {
    let [page, pulled] = deleted_page(
        &["deadnotexxxx"],
        vec![delete_by_new_device("note", "deadnotexxxx")],
    );
    let transport = FakeTransport::new(vec![devices(false), page, pulled]);
    let (vault, side, session) = vault("failed-re-pull", transport.clone());
    live_row(&side, "note", "deadnotexxxx");
    let sync = vault.sync(session);
    sync.sync_now().await.expect("the refusing pass");

    // A transport failure counts nothing: six of them, and the budget is whole.
    for _ in 0..6 {
        transport.push(devices(false));
        transport.push(Err(TransportError::Cancelled));
        transport.push(empty_changes());
        sync.sync_now().await.expect("an offline re-pull");
    }
    // An answer that will not parse counts: five, then no more re-pulls.
    for pass in 0..6 {
        let before = transport.call_count();
        transport.push(devices(false));
        if pass < 5 {
            transport.push(response(200, "not json"));
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
    side.call_blocking(|conn| {
        let reason = format!(
            "could not open the record: signer device `{NEW_DEVICE}`{}",
            memry_core::protocol::account::UNKNOWN_SIGNER
        );
        sync_items::mark_corrupt(conn, "note", "deadnotexxxx", &reason, 1)
    })
    .expect("a refusal recorded only in corrupt_reason");
    let sync = vault.sync(session);

    transport.push(devices(true));
    transport.push(re_pulled("note", "deadnotexxxx"));
    transport.push(empty_changes());
    sync.sync_now().await.expect("the first pass of this build");

    assert!(deleted(&side, "note", "deadnotexxxx"));
}
