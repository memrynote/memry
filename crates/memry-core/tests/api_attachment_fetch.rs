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
//! | a row that will not read fails alone                | one failure never stops it   |
//! | a manifest naming another attachment is refused     | §14.7 id = manifest id       |
//! | a batched manifest under another id is refused      | §14.7 id = manifest id       |
//! | two fetches of one attachment download it once      | in-flight dedupe (#5247)     |
//! | a waiter downloads what a failed fetch left         | in-flight dedupe, resume     |
//! | an aborted fetch releases the attachment            | in-flight dedupe (#5247)     |
//! | a landed file of another length is fetched again    | size = manifest plaintext    |

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, FakeTransport, body_json, error_response, response};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::crypto::derive_vault_key;
use memry_core::api::errors::SyncError;
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

/// One attachment's downloads after its manifest and the device directory
/// are in hand.
fn download_script(
    fx: &Fixture,
) -> Vec<Result<HttpResponse, memry_core::api::errors::TransportError>> {
    let mut script = vec![no_presign()];
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

/// REVIEW-5587: a note page restarted by a sync pass asks again for the
/// picture its cancelled task is still downloading.
#[tokio::test]
async fn two_fetches_of_one_attachment_download_it_once() {
    let fx = fixture();
    let (vault, dir) = scratch_vault_named("vault-in-flight");
    let mut script = vec![
        response(200, &fx.devices_body),
        response(200, &fx.manifest_body),
        no_presign(),
    ];
    script.extend(fx.chunks.iter().map(|chunk| raw(&chunk.framed)));
    let expected_calls = script.len();
    // Each answer is held, so the second fetch starts while the first runs.
    let transport = FakeTransport::slow(script, 20);
    let sync = vault.sync(session(transport.clone()));

    let (first, second) = tokio::join!(
        sync.fetch_attachment(ATTACHMENT.to_string(), Reachable::Wifi),
        sync.fetch_attachment(ATTACHMENT.to_string(), Reachable::Wifi),
    );

    for summary in [
        first.expect("the first fetch"),
        second.expect("the second fetch"),
    ] {
        assert!(summary.downloaded);
        assert_eq!(summary.local_path.as_deref(), Some(ATTACHMENT));
        assert_eq!(summary.bytes, fx.plaintext.len() as u64);
    }
    assert_eq!(
        transport.call_count(),
        expected_calls,
        "one download, not two"
    );
    let images = dir.join("images");
    assert_eq!(
        std::fs::read(images.join(ATTACHMENT)).expect("bytes on disk"),
        fx.plaintext
    );
    let files: Vec<_> = std::fs::read_dir(&images)
        .expect("images/")
        .map(|entry| entry.expect("an entry"))
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.file_name())
        .collect();
    assert_eq!(
        files,
        vec![ATTACHMENT],
        "no temporary file is left beside it"
    );
}

/// REVIEW-5674: the fetch a second one waited for fails part way. The waiter
/// downloads the attachment itself and asks only for the chunks the failed
/// fetch did not land.
#[tokio::test]
async fn a_waiter_downloads_what_a_failed_fetch_left() {
    let fx = fixture();
    let (vault, dir) = scratch_vault_named("vault-waiter-resumes");
    let transport = FakeTransport::new(vec![
        response(200, &fx.devices_body),
        response(200, &fx.manifest_body),
        no_presign(),
        raw(&fx.chunks[0].framed),
        raw(&fx.chunks[1].framed),
        error_response(404, "NOT_FOUND", "chunk went missing"),
        response(200, &fx.devices_body),
        response(200, &fx.manifest_body),
        no_presign(),
        raw(&fx.chunks[2].framed),
    ]);
    let sync = vault.sync(session(transport.clone()));

    // The first takes the attachment's gate at its first poll; the second
    // waits on it.
    let (first, second) = tokio::join!(
        sync.fetch_attachment(ATTACHMENT.to_string(), Reachable::Wifi),
        sync.fetch_attachment(ATTACHMENT.to_string(), Reachable::Wifi),
    );

    first.expect_err("the third chunk failed");
    let summary = second.expect("the waiter downloads it");
    assert!(summary.downloaded);
    assert_eq!(summary.bytes, fx.plaintext.len() as u64);
    let chunk_calls: Vec<_> = transport.calls()[6..]
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
        "the waiter resumes from the landed chunks"
    );
    assert_eq!(
        std::fs::read(dir.join("images").join(ATTACHMENT)).expect("bytes on disk"),
        fx.plaintext
    );
}

/// REVIEW-5674: a page that leaves drops its fetch mid-download. The
/// attachment's gate goes with it, so the next fetch is not held forever.
/// The clock is paused: a kept gate idles the runtime and the timeout fires
/// at once, while each scripted answer's hold passes in virtual time.
#[tokio::test(start_paused = true)]
async fn an_aborted_fetch_releases_the_attachment() {
    let fx = fixture();
    let (vault, dir) = scratch_vault_named("vault-aborted-fetch");
    let mut script = vec![
        response(200, &fx.devices_body),
        response(200, &fx.devices_body),
        response(200, &fx.manifest_body),
    ];
    script.extend(download_script(&fx));
    let expected_calls = script.len();
    // Each answer is held, so the first fetch is aborted inside its request.
    let transport = FakeTransport::slow(script, 20);
    let sync = vault.sync(session(transport.clone()));

    let aborted = tokio::spawn({
        let sync = Arc::clone(&sync);
        async move {
            sync.fetch_attachment(ATTACHMENT.to_string(), Reachable::Wifi)
                .await
        }
    });
    while transport.call_count() == 0 {
        tokio::task::yield_now().await;
    }
    aborted.abort();
    assert!(aborted.await.expect_err("aborted").is_cancelled());

    let summary = tokio::time::timeout(
        Duration::from_secs(600),
        sync.fetch_attachment(ATTACHMENT.to_string(), Reachable::Wifi),
    )
    .await
    .expect("the aborted fetch released the attachment")
    .expect("the next fetch downloads it");

    assert!(summary.downloaded);
    assert_eq!(transport.call_count(), expected_calls);
    assert_eq!(
        std::fs::read(dir.join("images").join(ATTACHMENT)).expect("bytes on disk"),
        fx.plaintext
    );
}

/// REVIEW-5674: a file at the row's path whose length is not the manifest's
/// plaintext size, torn or foreign, is downloaded over rather than returned
/// as the attachment.
#[tokio::test]
async fn a_landed_file_of_another_length_is_fetched_again() {
    let fx = fixture();
    let (vault, dir) = scratch_vault_named("vault-torn-file");
    let mut script = vec![
        response(200, &fx.devices_body),
        response(200, &fx.manifest_body),
    ];
    script.extend(download_script(&fx));
    let transport = FakeTransport::new(script);
    let sync = vault.sync(session(transport.clone()));
    sync.fetch_attachment(ATTACHMENT.to_string(), Reachable::Wifi)
        .await
        .expect("the first download");
    let file = dir.join("images").join(ATTACHMENT);
    std::fs::write(&file, &fx.plaintext[..3]).expect("a torn file");
    let first_download = transport.call_count();

    transport.push(response(200, &fx.devices_body));
    transport.push(response(200, &fx.manifest_body));
    for answer in download_script(&fx) {
        transport.push(answer);
    }
    let summary = sync
        .fetch_attachment(ATTACHMENT.to_string(), Reachable::Wifi)
        .await
        .expect("the download over the torn file");

    assert!(summary.downloaded);
    assert_eq!(summary.bytes, fx.plaintext.len() as u64);
    assert!(transport.call_count() > first_download, "downloaded again");
    assert_eq!(std::fs::read(&file).expect("bytes on disk"), fx.plaintext);
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
    let mut script = vec![
        response(
            200,
            &json!({"manifests": {A: manifest(&a), B: manifest(&b)}}).to_string(),
        ),
        response(200, &a.devices_body),
    ];
    script.extend(download_script(&a));
    script.extend(download_script(&b));
    script.push(response(200, &c.manifest_body));
    script.extend(download_script(&c));
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
    assert_eq!(
        transport.calls_to("/auth/devices").len(),
        1,
        "one device directory per re-drive"
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
    script.extend(download_script(&a));
    script.extend([not_found(), not_found()]);
    let transport = FakeTransport::new(script);
    let sync = vault.sync(session(transport.clone()));

    let summary = sync
        .redrive_attachments(Reachable::Wifi)
        .await
        .expect("re-drive");
    assert_eq!((summary.downloaded, summary.failed), (1, 2));

    // B and C are still missing; the older server is not asked again.
    transport.push(response(200, &a.devices_body));
    transport.push(not_found());
    transport.push(not_found());
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
    assert_eq!(
        transport.calls_to("/auth/devices").len(),
        2,
        "one device directory per re-drive"
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

/// REVIEW-5523R2 #7 (#5247): one attachment row SQLite cannot read fails
/// that row, and the rest of the re-drive still downloads.
#[tokio::test]
async fn a_row_that_will_not_read_fails_alone() {
    let (vault, dir) = scratch_vault_named("vault-bad-row");
    reference_all(&vault, &[A, B, C]);
    vault
        .db_handle()
        .call_blocking(|conn| {
            Ok(conn
                .execute(
                    "UPDATE attachments SET unmetered_only = 'not a flag' WHERE attachment_id = ?1",
                    [A],
                )
                .expect("A's row no longer reads"))
        })
        .expect("the update");
    let [b, c] = [B, C].map(fixture_for);
    let manifest =
        |fx: &Fixture| serde_json::from_str::<serde_json::Value>(&fx.manifest_body).unwrap();
    let mut script = vec![
        response(
            200,
            &json!({"manifests": {B: manifest(&b), C: manifest(&c)}}).to_string(),
        ),
        response(200, &b.devices_body),
    ];
    script.extend(download_script(&b));
    script.extend(download_script(&c));
    let transport = FakeTransport::new(script);
    let sync = vault.sync(session(transport.clone()));

    let summary = sync
        .redrive_attachments(Reachable::Wifi)
        .await
        .expect("the re-drive counts the rows");

    assert_eq!((summary.downloaded, summary.failed), (2, 1));
    let batches = transport.calls_to("/sync/attachments/manifests/batch");
    assert_eq!(body_json(&batches[0])["attachmentIds"], json!([B, C]));
    for (id, fx) in [(B, &b), (C, &c)] {
        let on_disk = std::fs::read(dir.join("images").join(id)).expect("bytes on disk");
        assert_eq!(on_disk, fx.plaintext, "{id}");
    }
}

/// K7 leftover (#5247): a server that answers one id with another
/// attachment's manifest would land that file under the id asked for.
#[tokio::test]
async fn a_manifest_naming_another_attachment_is_refused() {
    let other = fixture_for(B);
    let (vault, dir) = scratch_vault();
    let mut script = vec![
        response(200, &other.devices_body),
        response(200, &other.manifest_body),
    ];
    script.extend(download_script(&other));
    let transport = FakeTransport::new(script);
    let sync = vault.sync(session(transport.clone()));

    let error = sync
        .fetch_attachment(ATTACHMENT.to_string(), Reachable::Wifi)
        .await
        .expect_err("the manifest names B");

    assert!(
        matches!(error, SyncError::AttachmentCorrupt { .. }),
        "{error:?}"
    );
    assert_eq!(transport.call_count(), 2, "nothing past the manifest");
    assert!(!dir.join("images").join(ATTACHMENT).exists());
}

/// The batch route's map key is the server's word too (#5247).
#[tokio::test]
async fn a_batched_manifest_under_another_id_is_refused() {
    let (vault, dir) = scratch_vault_named("vault-batch-mismatch");
    reference_all(&vault, &[A, B]);
    let b = fixture_for(B);
    let manifest = serde_json::from_str::<serde_json::Value>(&b.manifest_body).unwrap();
    let mut script = vec![
        response(
            200,
            &json!({"manifests": {A: manifest.clone(), B: manifest}}).to_string(),
        ),
        response(200, &b.devices_body),
    ];
    // Twice, so a re-drive that took the manifest for A finishes and counts.
    script.extend(download_script(&b));
    script.extend(download_script(&b));
    let sync = vault.sync(session(FakeTransport::new(script)));

    let summary = sync
        .redrive_attachments(Reachable::Wifi)
        .await
        .expect("re-drive");

    assert_eq!((summary.downloaded, summary.failed), (1, 1));
    assert!(
        !dir.join("images").join(A).exists(),
        "B's bytes never land as A"
    );
    assert_eq!(
        std::fs::read(dir.join("images").join(B)).expect("B on disk"),
        b.plaintext
    );
}
