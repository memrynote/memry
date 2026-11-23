//! Attachment download hardening over the exported surface (#1829, #3251).
//!
//! Real `HttpClient`, `AuthSession`, SQLite and chapter 14 crypto; only the
//! transport and secure store are fakes.
//!
//! | Test                                                | Rule                         |
//! | --------------------------------------------------- | ---------------------------- |
//! | a retry asks only for the chunks that never landed  | chunk-level resume           |
//! | the re-driver fetches a referenced, missing picture | re-driver, no note re-apply  |
//! | the re-driver defers on cellular by default         | prefetch on cellular opt-in  |
//! | the re-driver reads its manifests in one batch      | §14.5.2 batched read (#5337) |
//! | the re-driver falls back to single manifest GETs    | §14.5.2 older server         |
//! | a key-store error fails each row, not the re-drive  | one failure never stops it   |

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, FakeTransport, body_json, error_response, response};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::crypto::derive_vault_key;
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::domain::attachments;
use memry_core::protocol::attachment_manifest;
use memry_core::protocol::attachment_upload::{FramedChunk, build_manifest, frame_chunks};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::reachability::Reachable;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::seams::transport::HttpResponse;
use serde_json::json;

const BASE: &str = "https://sync.example.com";
const DEVICE: &str = "device-a";
const ATTACHMENT: &str = "0123456789abcdef0123456789abcdef";
const MASTER_KEY: [u8; 32] = [7u8; 32];
const SIGNING_SEED: [u8; 32] = [11u8; 32];
const CHUNK: usize = 4;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch_vault() -> (Vault, PathBuf) {
    scratch_vault_named("vault-1")
}

fn scratch_vault_named(vault_id: &str) -> (Vault, PathBuf) {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-api-attachment-fetch-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let vault = Vault::open(vault_id.to_string(), dir.display().to_string()).expect("open");
    (vault, dir)
}

fn session(transport: Arc<FakeTransport>) -> Arc<AuthSession> {
    session_over(transport, FakeSecureStore::new())
}

fn session_over(transport: Arc<FakeTransport>, store: Arc<FakeSecureStore>) -> Arc<AuthSession> {
    store.put_text(SecureStoreKey::AccessToken, "access-1");
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .expect("plant the master key");
    Arc::new(
        AuthSession::new(
            transport,
            store,
            BASE.to_string(),
            "ios".to_string(),
            DeviceDescriptor {
                name: "phone".to_string(),
                platform: DevicePlatform::Ios,
                form_factor: None,
                os_version: None,
                app_version: "1.0.0".to_string(),
                vault_id: None,
            },
        )
        .expect("a session"),
    )
}

/// A three-chunk attachment, sealed as a peer would have uploaded it.
struct Fixture {
    plaintext: Vec<u8>,
    chunks: Vec<FramedChunk>,
    manifest_body: String,
    devices_body: String,
}

fn fixture() -> Fixture {
    fixture_for(ATTACHMENT)
}

fn fixture_for(attachment_id: &str) -> Fixture {
    let (public, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let plaintext = b"abcdefghij".to_vec();
    let file_key = vec![3u8; 32];
    let chunks =
        frame_chunks(&plaintext, &file_key, CHUNK, |index| vec![index as u8; 24]).expect("chunks");
    let manifest = build_manifest(
        attachment_id,
        "a.png",
        "image/png",
        &plaintext,
        &chunks,
        CHUNK,
        1,
    );
    let vault_key = derive_vault_key(MASTER_KEY.to_vec()).expect("vault key");
    let envelope = attachment_manifest::encrypt(
        &manifest, &file_key, &vault_key, &[1u8; 24], &[2u8; 24], &secret, DEVICE,
    )
    .expect("sealed manifest");
    Fixture {
        plaintext,
        chunks,
        manifest_body: json!({
            "encryptedManifest": envelope.encrypted_manifest,
            "manifestNonce": envelope.manifest_nonce,
            "encryptedFileKey": envelope.encrypted_file_key,
            "keyNonce": envelope.key_nonce,
            "manifestSignature": envelope.manifest_signature,
            "signerDeviceId": envelope.signer_device_id,
        })
        .to_string(),
        devices_body:
            json!({"devices": [{"id": DEVICE, "signingPublicKey": BASE64.encode(&public)}]})
                .to_string(),
    }
}

fn raw(bytes: &[u8]) -> Result<HttpResponse, memry_core::api::errors::TransportError> {
    Ok(HttpResponse {
        status: 200,
        headers: Default::default(),
        body: bytes.to_vec(),
    })
}

fn no_presign() -> Result<HttpResponse, memry_core::api::errors::TransportError> {
    error_response(503, "STORAGE_PRESIGN_UNAVAILABLE", "none here")
}

fn reference(vault: &Vault) {
    reference_all(vault, &[ATTACHMENT]);
}

fn reference_all(vault: &Vault, ids: &[&str]) {
    let ids: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
    vault
        .db_handle()
        .call_blocking(move |conn| attachments::merge_note_references(conn, "note-1", Some(&ids)))
        .expect("reference");
}

/// One attachment's downloads after its manifest is in hand.
fn download_script(
    fx: &Fixture,
) -> Vec<Result<HttpResponse, memry_core::api::errors::TransportError>> {
    let mut script = vec![response(200, &fx.devices_body), no_presign()];
    script.extend(fx.chunks.iter().map(|chunk| raw(&chunk.framed)));
    script
}

const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C: &str = "cccccccccccccccccccccccccccccccc";

#[tokio::test]
async fn a_retry_asks_only_for_the_chunks_that_never_landed() {
    let fx = fixture();
    let (vault, dir) = scratch_vault();
    let transport = FakeTransport::new(vec![
        response(200, &fx.devices_body),
        response(200, &fx.manifest_body),
        no_presign(),
        raw(&fx.chunks[0].framed),
        raw(&fx.chunks[1].framed),
        error_response(404, "NOT_FOUND", "chunk went missing"),
    ]);
    let sync = vault.sync(session(transport.clone()));

    sync.fetch_attachment(ATTACHMENT.to_string(), Reachable::Wifi)
        .await
        .expect_err("the third chunk failed");
    let first_attempt = transport.call_count();

    transport.push(response(200, &fx.devices_body));
    transport.push(response(200, &fx.manifest_body));
    transport.push(no_presign());
    transport.push(raw(&fx.chunks[2].framed));
    let summary = sync
        .fetch_attachment(ATTACHMENT.to_string(), Reachable::Wifi)
        .await
        .expect("the retry completes");

    assert!(summary.downloaded);
    let retry = &transport.calls()[first_attempt..];
    let chunk_calls: Vec<_> = retry
        .iter()
        .filter(|call| call.url.contains("/sync/attachments/chunks/"))
        .map(|call| call.url.clone())
        .collect();
    assert_eq!(
        chunk_calls,
        vec![format!(
            "{BASE}/sync/attachments/chunks/{}",
            fx.chunks[2].reference.encrypted_hash
        )],
        "landed chunks must not be downloaded again"
    );
    let presign = retry
        .iter()
        .find(|call| call.url.ends_with("/presign-batch"))
        .expect("presign asked");
    assert_eq!(
        body_json(presign)["chunkHashes"],
        json!([fx.chunks[2].reference.encrypted_hash])
    );
    assert_eq!(
        std::fs::read(dir.join("images").join(ATTACHMENT)).expect("bytes on disk"),
        fx.plaintext
    );
    assert!(
        !dir.join("images/.partial").join(ATTACHMENT).exists(),
        "landed chunks are cleared once the file is whole"
    );
}

#[tokio::test]
async fn the_redriver_fetches_a_referenced_missing_attachment() {
    let fx = fixture();
    let (vault, dir) = scratch_vault();
    reference(&vault);
    let mut script = vec![
        response(200, &fx.devices_body),
        response(200, &fx.manifest_body),
        no_presign(),
    ];
    script.extend(fx.chunks.iter().map(|chunk| raw(&chunk.framed)));
    let sync = vault.sync(session(FakeTransport::new(script)));

    let summary = sync
        .redrive_attachments(Reachable::Wifi)
        .await
        .expect("re-drive");

    assert_eq!((summary.downloaded, summary.failed), (1, 0));
    assert_eq!(
        std::fs::read(dir.join("images").join(ATTACHMENT)).expect("bytes on disk"),
        fx.plaintext
    );
    let again = sync
        .redrive_attachments(Reachable::Wifi)
        .await
        .expect("nothing left");
    assert_eq!(again.downloaded + again.deferred + again.failed, 0);
}

#[tokio::test]
async fn the_redriver_defers_on_cellular_by_default() {
    let (vault, _dir) = scratch_vault();
    reference(&vault);
    let transport = FakeTransport::new(vec![]);
    let sync = vault.sync(session(transport.clone()));

    let summary = sync
        .redrive_attachments(Reachable::Cellular)
        .await
        .expect("re-drive");

    assert_eq!((summary.downloaded, summary.deferred), (0, 1));
    assert_eq!(transport.call_count(), 0, "no bytes on metered data");
}

#[tokio::test]
async fn the_redriver_reads_its_manifests_in_one_batch() {
    let (vault, dir) = scratch_vault_named("vault-batch");
    reference_all(&vault, &[A, B, C]);
    let [a, b, c] = [A, B, C].map(fixture_for);
    let manifest =
        |fx: &Fixture| serde_json::from_str::<serde_json::Value>(&fx.manifest_body).unwrap();
    // The server has no manifest stored for C, so it is left out.
    let mut script = vec![response(
        200,
        &json!({"manifests": {A: manifest(&a), B: manifest(&b)}}).to_string(),
    )];
    script.extend(download_script(&a));
    script.extend(download_script(&b));
    script.push(response(200, &c.devices_body));
    script.push(response(200, &c.manifest_body));
    script.extend(download_script(&c).into_iter().skip(1));
    let transport = FakeTransport::new(script);
    let sync = vault.sync(session(transport.clone()));

    let summary = sync
        .redrive_attachments(Reachable::Wifi)
        .await
        .expect("re-drive");

    assert_eq!((summary.downloaded, summary.failed), (3, 0));
    let batches = transport.calls_to("/sync/attachments/manifests/batch");
    assert_eq!(batches.len(), 1);
    assert_eq!(body_json(&batches[0])["attachmentIds"], json!([A, B, C]));
    let singles: Vec<_> = transport
        .calls()
        .iter()
        .filter(|call| call.url.ends_with("/manifest"))
        .map(|call| call.url.clone())
        .collect();
    assert_eq!(
        singles,
        vec![format!("{BASE}/sync/attachments/{C}/manifest")]
    );
    for (id, fx) in [(A, &a), (B, &b), (C, &c)] {
        let on_disk = std::fs::read(dir.join("images").join(id)).expect("bytes on disk");
        assert_eq!(on_disk, fx.plaintext, "{id}");
    }
}

#[tokio::test]
async fn the_redriver_falls_back_to_single_manifest_gets_on_an_older_server() {
    let (vault, _dir) = scratch_vault_named("vault-old-server");
    reference_all(&vault, &[A, B, C]);
    let a = fixture_for(A);
    let not_found = || error_response(404, "NOT_FOUND", "no route");
    let mut script = vec![
        not_found(),
        response(200, &a.devices_body),
        response(200, &a.manifest_body),
    ];
    script.extend(download_script(&a).into_iter().skip(1));
    for _ in 0..2 {
        script.push(response(200, &a.devices_body));
        script.push(not_found());
    }
    let transport = FakeTransport::new(script);
    let sync = vault.sync(session(transport.clone()));

    let summary = sync
        .redrive_attachments(Reachable::Wifi)
        .await
        .expect("re-drive");
    assert_eq!((summary.downloaded, summary.failed), (1, 2));

    // B and C are still missing; the older server is not asked again.
    for _ in 0..2 {
        transport.push(response(200, &a.devices_body));
        transport.push(not_found());
    }
    let again = sync
        .redrive_attachments(Reachable::Wifi)
        .await
        .expect("re-drive");
    assert_eq!((again.downloaded, again.failed), (0, 2));
    assert_eq!(
        transport
            .calls_to("/sync/attachments/manifests/batch")
            .len(),
        1
    );
}

#[tokio::test]
async fn a_key_store_error_fails_each_row_and_not_the_redrive() {
    let (vault, _dir) = scratch_vault_named("vault-key-error");
    reference_all(&vault, &[A, B]);
    let transport = FakeTransport::new(vec![]);
    let store = FakeSecureStore::new();
    let sync = vault.sync(session_over(transport.clone(), Arc::clone(&store)));
    store.lock_device();

    let summary = sync
        .redrive_attachments(Reachable::Wifi)
        .await
        .expect("the re-drive counts the rows");

    assert_eq!((summary.downloaded, summary.failed), (0, 2));
    assert_eq!(transport.call_count(), 0);
}
