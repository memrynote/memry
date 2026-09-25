//! `VaultSync::sync_now` (spec 004 TP028a): pull first, then push.
//!
//! Real `HttpClient`, `AuthSession`, SQLite and sealing; only the two foreign
//! seams are fakes. The point of the export is that a phone write leaves the
//! outbox, so the test starts from a local write and ends with an empty outbox
//! and a `/sync/push` that the pull preceded, signed as the device the server
//! registered (the access token's `device_id`), never the local clock id.

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, FakeTransport, body_json, jwt, response};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::vault::Vault;
use memry_core::crypto::{keys, sodium};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::sync::body_debt;
use serde_json::json;

const BASE: &str = "https://sync.example.com";
const MASTER_KEY: [u8; 32] = [7u8; 32];
const SIGNING_SEED: [u8; 32] = [11u8; 32];

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch_vault() -> Vault {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-api-sync-pass-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open")
}

#[tokio::test]
async fn a_local_write_is_pulled_over_then_pushed_and_leaves_the_outbox() {
    let (public, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let local_id = keys::local_device_id_hex(&public).expect("a local device id");
    // The server names devices itself; the local id is only a clock id.
    let device_id = "server-device-1";
    assert_ne!(local_id, device_id);

    let store = FakeSecureStore::new();
    store.put_text(
        SecureStoreKey::AccessToken,
        &jwt(json!({"sub": "user-1", "device_id": device_id, "type": "access", "exp": 9_999_999_999u64})),
    );
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .expect("plant the master key");
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");

    let vault = scratch_vault();
    let writer = vault.notes_writer(store.clone()).expect("a writer");
    let note_id = writer
        .create("Written on the phone".to_string(), None)
        .expect("create");

    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"devices": [{"id": device_id, "signingPublicKey": BASE64.encode(&public)}]})
                .to_string(),
        ),
        response(
            200,
            &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": null}).to_string(),
        ),
        response(
            200,
            &json!({"accepted": [note_id], "rejected": [], "serverTime": 1, "maxCursor": 1})
                .to_string(),
        ),
        response(200, &json!({"updates": [], "hasMore": false}).to_string()),
    ]);
    let session = Arc::new(
        AuthSession::new(
            transport.clone(),
            store,
            BASE.to_string(),
            "ios".to_string(),
            DeviceDescriptor {
                name: "Phone".to_string(),
                platform: DevicePlatform::Ios,
                os_version: None,
                app_version: "1.0.0".to_string(),
                vault_id: None,
            },
        )
        .expect("a session"),
    );

    // The pass body-pulls notes written at or after its start; a local write
    // in the same millisecond would join them and reorder the script.
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let summary = vault.sync(session).sync_now().await.expect("the pass");

    assert_eq!(summary.pushed, 1, "{summary:?}");
    assert_eq!(summary.pending, 0, "the outbox drained: {summary:?}");

    let paths: Vec<String> = transport.calls().iter().map(|c| c.url.clone()).collect();
    let pull_at = paths
        .iter()
        .position(|p| p.contains("/sync/changes"))
        .expect("a pull");
    let push_at = paths
        .iter()
        .position(|p| p.contains("/sync/push"))
        .expect("a push");
    assert!(pull_at < push_at, "pull before push: {paths:?}");

    let pushed = body_json(&transport.calls_to("/sync/push")[0]);
    assert_eq!(pushed["items"][0]["id"], json!(note_id));
    assert_eq!(pushed["items"][0]["type"], json!("note"));
    assert_eq!(
        pushed["items"][0]["signerDeviceId"],
        json!(device_id),
        "signed as the registered device: {}",
        pushed["items"][0]
    );
}

/// An attachment manifest is signed as the registered device too: other
/// devices resolve the signer through the account's device list, which never
/// holds the local clock id.
#[tokio::test]
async fn an_attachment_manifest_is_signed_as_the_registered_device() {
    let (_public, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let device_id = "server-device-1";
    let store = FakeSecureStore::new();
    store.put_text(
        SecureStoreKey::AccessToken,
        &jwt(json!({"sub": "user-1", "device_id": device_id, "type": "access", "exp": 9_999_999_999u64})),
    );
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .expect("plant the master key");
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");

    let vault = scratch_vault();
    let note_id = vault
        .notes_writer(store.clone())
        .expect("a writer")
        .create("Has a picture".to_string(), None)
        .expect("create");

    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"sessionId": "upload-1", "expiresAt": 9_999_999_999_000i64}).to_string(),
        ),
        response(200, &json!({"success": true}).to_string()),
        response(200, &json!({"success": true}).to_string()),
        response(200, &json!({"success": true}).to_string()),
    ]);
    let session = Arc::new(
        AuthSession::new(
            transport.clone(),
            store,
            BASE.to_string(),
            "ios".to_string(),
            DeviceDescriptor {
                name: "Phone".to_string(),
                platform: DevicePlatform::Ios,
                os_version: None,
                app_version: "1.0.0".to_string(),
                vault_id: None,
            },
        )
        .expect("a session"),
    );

    vault
        .sync(session)
        .upload_attachment(
            note_id,
            "a.png".to_string(),
            "image/png".to_string(),
            vec![1, 2, 3],
        )
        .await
        .expect("the upload");

    let manifest = transport
        .calls()
        .into_iter()
        .find(|call| call.url.ends_with("/manifest"))
        .expect("a manifest upload");
    assert_eq!(body_json(&manifest)["signerDeviceId"], json!(device_id));
}

/// Two passes started together over one vault run one after the other: the
/// outbox row goes out once, and the second pass finds nothing to push.
#[tokio::test]
async fn overlapping_passes_over_one_vault_push_a_row_once() {
    let (public, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let device_id = "server-device-1";
    let store = FakeSecureStore::new();
    store.put_text(
        SecureStoreKey::AccessToken,
        &jwt(json!({"sub": "user-1", "device_id": device_id, "type": "access", "exp": 9_999_999_999u64})),
    );
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .expect("plant the master key");
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");

    let vault = scratch_vault();
    let note_id = vault
        .notes_writer(store.clone())
        .expect("a writer")
        .create("Written once".to_string(), None)
        .expect("create");
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;

    let devices = || {
        response(
            200,
            &json!({"devices": [{"id": device_id, "signingPublicKey": BASE64.encode(&public)}]})
                .to_string(),
        )
    };
    let empty_page = || {
        response(
            200,
            &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": null}).to_string(),
        )
    };
    // Held in flight, so the second pass is started while the first runs.
    let transport = FakeTransport::slow(
        vec![
            devices(),
            empty_page(),
            response(
                200,
                &json!({"accepted": [note_id], "rejected": [], "serverTime": 1, "maxCursor": 1})
                    .to_string(),
            ),
            devices(),
            empty_page(),
        ],
        20,
    );
    let session = Arc::new(
        AuthSession::new(
            transport.clone(),
            store,
            BASE.to_string(),
            "ios".to_string(),
            DeviceDescriptor {
                name: "Phone".to_string(),
                platform: DevicePlatform::Ios,
                os_version: None,
                app_version: "1.0.0".to_string(),
                vault_id: None,
            },
        )
        .expect("a session"),
    );

    let first = vault.sync(Arc::clone(&session));
    let second = vault.sync(session);
    let (a, b) = tokio::join!(first.sync_now(), second.sync_now());
    let (a, b) = (a.expect("first pass"), b.expect("second pass"));

    assert_eq!(
        transport.calls_to("/sync/push").len(),
        1,
        "{:?}",
        transport
            .calls()
            .iter()
            .map(|c| c.url.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(a.pushed + b.pushed, 1);
    assert_eq!(a.rejected + b.rejected, 0);
    assert_eq!(b.pending, 0);
}

/// #2294: the body step pulls every document owed a whole-body pull, settles
/// the ones whose pull merged, and keeps the debt of one that stopped at a gap.
#[tokio::test]
async fn the_pass_pulls_owed_bodies_and_settles_only_the_merged_ones() {
    let (public, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let device_id = "server-device-1";
    let store = FakeSecureStore::new();
    store.put_text(
        SecureStoreKey::AccessToken,
        &jwt(json!({"sub": "user-1", "device_id": device_id, "type": "access", "exp": 9_999_999_999u64})),
    );
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .expect("plant the master key");
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");

    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-api-sync-pass-owed-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    let side = memry_core::storage::open_data(&dir.join("data.db")).expect("a second handle");
    side.call_blocking(|conn| {
        body_debt::owe(conn, "goodnote1234")?;
        body_debt::owe(conn, "stopnote1234")
    })
    .expect("owe two bodies");

    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"devices": [{"id": device_id, "signingPublicKey": BASE64.encode(&public)}]})
                .to_string(),
        ),
        response(
            200,
            &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": null}).to_string(),
        ),
        // goodnote1234: no snapshot, no updates. A clean pull.
        response(200, &json!({"snapshot": null}).to_string()),
        response(200, &json!({"updates": [], "hasMore": false}).to_string()),
        // stopnote1234: an update this device cannot open, so a stop at the gap.
        response(200, &json!({"snapshot": null}).to_string()),
        response(
            200,
            &json!({"updates": [{"sequenceNum": 1, "data": "AAAA", "signerDeviceId": device_id}], "hasMore": false})
                .to_string(),
        ),
    ]);
    let session = Arc::new(
        AuthSession::new(
            transport.clone(),
            store,
            BASE.to_string(),
            "ios".to_string(),
            DeviceDescriptor {
                name: "Phone".to_string(),
                platform: DevicePlatform::Ios,
                os_version: None,
                app_version: "1.0.0".to_string(),
                vault_id: None,
            },
        )
        .expect("a session"),
    );

    let summary = vault.sync(session).sync_now().await.expect("the pass");

    assert_eq!(summary.bodies, 2, "{summary:?}");
    let owed = side
        .call_blocking(|conn| body_debt::owed(conn))
        .expect("the owed documents");
    assert_eq!(owed, ["stopnote1234"], "only the merged pull settles");
}

/// A vault plus a second handle on its `data.db`, and a session whose calls
/// the transport answers from `script`.
fn vault_with_side(
    label: &str,
    transport: Arc<FakeTransport>,
) -> (Vault, memry_core::storage::Db, Arc<AuthSession>) {
    let (_public, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
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
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-api-sync-pass-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
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
                os_version: None,
                app_version: "1.0.0".to_string(),
                vault_id: None,
            },
        )
        .expect("a session"),
    );
    (vault, side, session)
}

fn devices()
-> Result<memry_core::seams::transport::HttpResponse, memry_core::api::errors::TransportError> {
    let (public, _secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    response(
        200,
        &json!({"devices": [{"id": "server-device-1", "signingPublicKey": BASE64.encode(&public)}]})
            .to_string(),
    )
}

fn legacy_state(side: &memry_core::storage::Db) -> Option<String> {
    side.call_blocking(|conn| {
        memry_core::sync::first_sync_store::read_meta(
            conn,
            memry_core::sync::note_body_feed::META_NOTE_BODY_LEGACY_PULL,
        )
    })
    .expect("read the legacy pull state")
}

/// #2297, #2304: the pull declares `note_body`; the first page that carries
/// `noteBodies` makes the legacy whole-body pull due; a run that delivered
/// pulls every document held here once, then records it done, and the next
/// pass does not repeat it.
#[tokio::test]
async fn the_legacy_body_pull_runs_once_over_held_documents_after_a_delivered_run() {
    let transport = FakeTransport::new(vec![
        devices(),
        response(
            200,
            &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": 3, "noteBodies": []})
                .to_string(),
        ),
        // heldnote1234 holds a body cursor, so no baseline: the probe, then
        // one updates GET.
        probe_page(),
        response(200, &json!({"updates": [], "hasMore": false}).to_string()),
        devices(),
        response(
            200,
            &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": 3, "noteBodies": []})
                .to_string(),
        ),
    ]);
    let (vault, side, session) = vault_with_side("legacy", transport.clone());
    side.call_blocking(|conn| {
        memry_core::sync::store::write_cursor(conn, "crdt:heldnote1234", Some("5"), 1)
    })
    .expect("a held body");

    let first = vault
        .sync(Arc::clone(&session))
        .sync_now()
        .await
        .expect("the first pass");
    assert_eq!(first.bodies, 1, "{first:?}");
    assert_eq!(legacy_state(&side).as_deref(), Some("done"));
    let swept = transport.calls_to("/sync/crdt/updates?note_id=heldnote1234&since=5&limit=100");
    assert_eq!(swept.len(), 1);
    let declared = &transport.calls_to("/sync/changes?limit=500")[0].headers["x-memry-sync-types"];
    assert!(declared.ends_with(",note_body"), "{declared}");

    let second = vault.sync(session).sync_now().await.expect("the next pass");
    assert_eq!(second.bodies, 0, "done is never swept again: {second:?}");
}

/// #2297: a refused page lands nothing, so it owes no legacy pull either;
/// the page and its bodies are pulled again.
#[tokio::test]
async fn a_refused_run_owes_no_legacy_body_pull() {
    let transport = FakeTransport::new(vec![
        devices(),
        response(
            200,
            &json!({"items": [{"id": "abc123def456", "type": "note"}], "deleted": [], "hasMore": false, "nextCursor": 3, "noteBodies": []})
                .to_string(),
        ),
        // Not a pull envelope: the page is refused and its cursor held.
        response(200, &json!({"error": "upstream"}).to_string()),
    ]);
    let (vault, side, session) = vault_with_side("legacy-refused", transport.clone());
    side.call_blocking(|conn| {
        memry_core::sync::store::write_cursor(conn, "crdt:heldnote1234", Some("5"), 1)
    })
    .expect("a held body");

    let summary = vault.sync(session).sync_now().await.expect("the pass");

    assert_eq!(summary.bodies, 0, "{summary:?}");
    assert_eq!(legacy_state(&side), None);
    assert!(owed(&side).is_empty());
}

fn owed(side: &memry_core::storage::Db) -> Vec<String> {
    side.call_blocking(|conn| body_debt::owed(conn))
        .expect("the owed documents")
}

fn updates_page()
-> Result<memry_core::seams::transport::HttpResponse, memry_core::api::errors::TransportError> {
    response(200, &json!({"updates": [], "hasMore": false}).to_string())
}

/// The snapshot-meta probe (§7.8, `POST /sync/crdt/updates/batch`), sent once
/// per chunk of owed documents that hold a body cursor, advertising nothing.
fn probe_page()
-> Result<memry_core::seams::transport::HttpResponse, memry_core::api::errors::TransportError> {
    response(200, &json!({"notes": {}}).to_string())
}

fn empty_changes()
-> Result<memry_core::seams::transport::HttpResponse, memry_core::api::errors::TransportError> {
    response(
        200,
        &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": 3, "noteBodies": []})
            .to_string(),
    )
}

/// #2297 review A-1/B-1: the body step never blocks the push. A `429` in the
/// middle of it ends the step, the push still runs, and the next pass resumes
/// from the debts it left.
#[tokio::test]
async fn a_rate_limited_body_step_still_pushes_and_the_next_pass_resumes_from_the_debts() {
    let transport = FakeTransport::new(vec![]);
    let (vault, side, session) = vault_with_side("rate-limited", transport.clone());
    side.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, 'done')",
            [memry_core::sync::note_body_feed::META_NOTE_BODY_LEGACY_PULL],
        )
        .map_err(|error| memry_core::api::errors::StorageError::Failed {
            what: error.to_string(),
        })?;
        for doc in ["owedaaaa1234", "owedbbbb1234", "owedcccc1234"] {
            memry_core::sync::store::write_cursor(conn, &format!("crdt:{doc}"), Some("5"), 1)?;
            body_debt::owe(conn, doc)?;
        }
        Ok(())
    })
    .expect("three owed bodies");
    let note_id = side
        .call_blocking(|conn| {
            memry_core::domain::notes::create(
                conn,
                &memry_core::domain::notes::NewNote {
                    id: "localnote123",
                    title: "Written on the phone",
                    folder_path: Some("Notes"),
                    content: "",
                    tags: &[],
                    properties: None,
                },
                "device-local",
                1_760_000_000_000,
            )?;
            Ok("localnote123".to_owned())
        })
        .expect("a local write");

    transport.push(devices());
    transport.push(empty_changes());
    // owedaaaa1234 merges; owedbbbb1234 is rate limited, which ends the step.
    transport.push(probe_page());
    transport.push(updates_page());
    transport.push(response(
        429,
        r#"{"error":{"code":"RATE_LIMITED","message":"slow down"}}"#,
    ));
    transport.push(response(
        200,
        &json!({"accepted": [note_id], "rejected": [], "serverTime": 1, "maxCursor": 1})
            .to_string(),
    ));
    let first = vault
        .sync(Arc::clone(&session))
        .sync_now()
        .await
        .expect("the pass survives the 429");

    assert_eq!(first.pushed, 1, "the push ran: {first:?}");
    assert_eq!(owed(&side), ["owedbbbb1234", "owedcccc1234"]);
    assert!(
        transport
            .calls_to("/sync/crdt/updates?note_id=owedcccc1234&since=5&limit=100")
            .is_empty(),
        "no request after the 429"
    );

    transport.push(devices());
    transport.push(empty_changes());
    transport.push(probe_page());
    transport.push(updates_page());
    transport.push(updates_page());
    let second = vault.sync(session).sync_now().await.expect("the next pass");
    assert_eq!(second.bodies, 2, "{second:?}");
    assert!(owed(&side).is_empty());
}

/// #2297 review A-2/B-2: a debt never pulls a deleted body back. The
/// tombstone settles the debt in its own transaction, and a debt on a
/// document already tombstoned is settled rather than pulled.
#[tokio::test]
async fn a_tombstoned_owed_document_is_never_body_pulled() {
    let transport = FakeTransport::new(vec![
        devices(),
        // X is deleted on this page, with no type on the wire (§5.12.1).
        response(
            200,
            &json!({"items": [], "deleted": ["deadnotexxxx"], "hasMore": false, "nextCursor": 3, "noteBodies": []})
                .to_string(),
        ),
        response(200, &json!({"items": []}).to_string()),
    ]);
    let (vault, side, session) = vault_with_side("tombstoned-debt", transport.clone());
    side.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, 'done')",
            [memry_core::sync::note_body_feed::META_NOTE_BODY_LEGACY_PULL],
        )
        .map_err(|error| memry_core::api::errors::StorageError::Failed {
            what: error.to_string(),
        })?;
        memry_core::sync::store::write_cursor(conn, "crdt:deadnotexxxx", Some("1"), 1)?;
        memry_core::crdt::update_log::append_server_update(conn, "deadnotexxxx", 1, &[0, 0], 1)
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })?;
        body_debt::owe(conn, "deadnotexxxx")?;
        // Y was deleted here before its debt was written.
        memry_core::sync::store::mark_deleted(conn, "note", "deadnoteyyyy", 5, None, 5)?;
        body_debt::owe(conn, "deadnoteyyyy")
    })
    .expect("two debts on deleted notes");

    let summary = vault.sync(session).sync_now().await.expect("the pass");

    assert_eq!(summary.bodies, 0, "{summary:?}");
    assert!(transport.calls_to("deadnote").is_empty());
    assert!(
        transport
            .calls()
            .iter()
            .all(|call| !call.url.contains("/sync/crdt/")),
        "no body request for a deleted note"
    );
    assert!(owed(&side).is_empty());
    let rows: i64 = side
        .call_blocking(|conn| {
            conn.query_row(
                "SELECT count(*) FROM yjs_updates WHERE doc_id LIKE 'deadnote%'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })
        })
        .expect("count the rows");
    assert_eq!(rows, 0);
}

/// #2297 review A-5/B-6: a debt is settled only by a pull that reached the
/// server's head and stored everything. One that yields at the page cap keeps
/// its debt, due again next pass; one whose baseline cannot be opened stops
/// there, sends no incremental request past the watermark, and backs off.
#[tokio::test]
async fn a_debt_is_settled_only_by_a_pull_that_reached_the_head() {
    let transport = FakeTransport::new(vec![]);
    let (vault, side, session) = vault_with_side("incomplete", transport.clone());
    side.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, 'done')",
            [memry_core::sync::note_body_feed::META_NOTE_BODY_LEGACY_PULL],
        )
        .map_err(|error| memry_core::api::errors::StorageError::Failed {
            what: error.to_string(),
        })?;
        memry_core::sync::store::write_cursor(conn, "crdt:longnote1234", Some("5"), 1)?;
        body_debt::owe(conn, "longnote1234")?;
        body_debt::owe(conn, "snapbad12345")
    })
    .expect("two debts");

    transport.push(devices());
    transport.push(empty_changes());
    transport.push(probe_page());
    for _ in 0..memry_core::sync::body_pull::MAX_PAGES_PER_DOCUMENT {
        transport.push(response(
            200,
            &json!({"updates": [], "hasMore": true}).to_string(),
        ));
    }
    transport.push(response(
        200,
        &json!({"snapshot": "not base64 !!", "sequenceNum": 9, "revision": "r"}).to_string(),
    ));
    vault
        .sync(Arc::clone(&session))
        .sync_now()
        .await
        .expect("the pass");

    assert_eq!(owed(&side), ["longnote1234", "snapbad12345"]);
    assert!(
        transport
            .calls_to("/sync/crdt/updates?note_id=snapbad12345&since=0&limit=100")
            .is_empty(),
        "nothing past a baseline this device could not use"
    );

    // Next pass: the capped document is due again at once; the stopped one
    // waits a pass.
    transport.push(devices());
    transport.push(empty_changes());
    transport.push(probe_page());
    transport.push(updates_page());
    vault.sync(session).sync_now().await.expect("the next pass");
    assert_eq!(owed(&side), ["snapbad12345"]);
}

/// #2297 review A-1: the body step holds a per-pass request budget well under
/// the server's CRDT pull limit; the documents past it stay owed.
#[tokio::test]
async fn the_body_step_stops_at_its_request_budget() {
    let budget = memry_core::sync::body_step::BODY_REQUEST_BUDGET;
    let transport = FakeTransport::new(vec![]);
    let (vault, side, session) = vault_with_side("budget", transport.clone());
    side.call_blocking(move |conn| {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, 'done')",
            [memry_core::sync::note_body_feed::META_NOTE_BODY_LEGACY_PULL],
        )
        .map_err(|error| memry_core::api::errors::StorageError::Failed {
            what: error.to_string(),
        })?;
        for index in 0..budget + 3 {
            let doc = format!("budget{index:06}");
            memry_core::sync::store::write_cursor(conn, &format!("crdt:{doc}"), Some("5"), 1)?;
            body_debt::owe(conn, &doc)?;
        }
        Ok(())
    })
    .expect("more debts than the budget");

    transport.push(devices());
    transport.push(empty_changes());
    // One probe per hundred documents, each counted: the budget covers
    // `budget - probes` documents.
    let mut pulled = 0;
    let mut requests = 0;
    for index in 0.. {
        if index % 100 == 0 {
            transport.push(probe_page());
            requests += 1;
        }
        if requests >= budget {
            break;
        }
        transport.push(updates_page());
        pulled += 1;
        requests += 1;
    }
    let summary = vault.sync(session).sync_now().await.expect("the pass");

    assert_eq!(summary.bodies as usize, pulled, "{summary:?}");
    assert_eq!(
        transport.calls_to("/sync/crdt/updates/batch").len(),
        budget - pulled
    );
    assert_eq!(owed(&side).len(), budget + 3 - pulled);
}
