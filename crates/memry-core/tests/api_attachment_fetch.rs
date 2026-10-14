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
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-api-attachment-fetch-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    (vault, dir)
}

fn session(transport: Arc<FakeTransport>) -> Arc<AuthSession> {
    let store = FakeSecureStore::new();
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
    let (public, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let plaintext = b"abcdefghij".to_vec();
    let file_key = vec![3u8; 32];
    let chunks =
        frame_chunks(&plaintext, &file_key, CHUNK, |index| vec![index as u8; 24]).expect("chunks");
    let manifest = build_manifest(
        ATTACHMENT,
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
    vault
        .db_handle()
        .call_blocking(|conn| {
            attachments::merge_note_references(conn, "note-1", Some(&[ATTACHMENT.to_string()]))
        })
        .expect("reference");
}

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
