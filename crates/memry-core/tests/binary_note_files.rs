//! A binary note's own file on a fresh device (#5668).
//!
//! A PDF, image, audio or video note names its bytes by `attachmentId` on the
//! note itself (§13.7.1), not by `attachmentReferences` (§14.7). Desktop
//! materialises that file on pull (`note-handler.ts:750`). Real pull, real
//! chapter 04 and chapter 14 crypto, real SQLite; only the transport and the
//! secure store are fakes.
//!
//! | Test                                              | Rule                          |
//! | ------------------------------------------------- | ----------------------------- |
//! | a pulled binary note's file lands byte-identical  | §14.7 chain, desktop pull     |
//! | the background download waits, opening fetches it | FR-045, Download attachments  |
//! | a peer replacement lands and keeps the old bytes  | #5626, new attachment id      |
//! | a markdown record without the file keeps it       | #5419, desktop pull keeps it  |

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, FakeTransport, error_response, response};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::crypto::derive_vault_key;
use memry_core::api::errors::TransportError;
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::domain::attachments;
use memry_core::protocol::account::{AccountSealer, DeviceSigner};
use memry_core::protocol::attachment_manifest;
use memry_core::protocol::attachment_upload::{FramedChunk, build_manifest, frame_chunks};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::protocol::envelope::SyncOperation;
use memry_core::seams::reachability::Reachable;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::seams::transport::HttpResponse;
use memry_core::storage::repositories::instants;
use memry_core::storage::repositories::sync_items::SyncItemRow;
use memry_core::sync::push::{PendingRecord, PushSealer as _};
use serde_json::{Value as Json, json};

const BASE: &str = "https://sync.example.com";
const NOTE: &str = "pdfnote00001";
const DEVICE: &str = "device-a";
const MASTER_KEY: [u8; 32] = [7u8; 32];
const SIGNING_SEED: [u8; 32] = [11u8; 32];
const CHUNK: usize = 4;
/// Outside the first sync's thirty-day bodies window, so the pull asks for no
/// body: a binary note has none (§13.7.1).
const OLD: &str = "2020-01-01T00:00:00.000Z";
const FIRST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECOND: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

type Scripted = Result<HttpResponse, TransportError>;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch_vault() -> (Vault, PathBuf) {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-binary-note-files-{}-{unique}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    (vault, dir)
}

fn session(transport: Arc<FakeTransport>) -> Arc<AuthSession> {
    let store = FakeSecureStore::new();
    store.put_text(
        SecureStoreKey::AccessToken,
        &http_fakes::jwt(json!({"sub": "user-1", "device_id": DEVICE, "type": "access", "exp": 9_999_999_999u64})),
    );
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

fn keypair() -> (Vec<u8>, Vec<u8>) {
    let (public, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    (public, secret.to_vec())
}

fn devices() -> Scripted {
    let (public, _) = keypair();
    response(
        200,
        &json!({"devices": [{"id": DEVICE, "signingPublicKey": BASE64.encode(&public)}]})
            .to_string(),
    )
}

/// The PDF a peer uploaded, sealed as chapter 14 seals it.
struct File {
    plaintext: Vec<u8>,
    chunks: Vec<FramedChunk>,
    manifest_body: String,
}

fn file(attachment_id: &str, plaintext: &[u8]) -> File {
    let (_, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let file_key = vec![3u8; 32];
    let chunks =
        frame_chunks(plaintext, &file_key, CHUNK, |index| vec![index as u8; 24]).expect("chunks");
    let manifest = build_manifest(
        attachment_id,
        "scan.pdf",
        "application/pdf",
        plaintext,
        &chunks,
        CHUNK,
        1,
    );
    let vault_key = derive_vault_key(MASTER_KEY.to_vec()).expect("vault key");
    let envelope = attachment_manifest::encrypt(
        &manifest, &file_key, &vault_key, &[1u8; 24], &[2u8; 24], &secret, DEVICE,
    )
    .expect("sealed manifest");
    File {
        plaintext: plaintext.to_vec(),
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
    }
}

/// Desktop's binary note record (`note-sync.ts` `buildSnapshotPayload`): no
/// `content`, no `attachmentReferences`, the file named by `attachmentId`.
fn binary_note(attachment_id: &str, counter: u64) -> Json {
    note_record(
        json!({
            "title": "Scan",
            "emoji": null,
            "fileType": "pdf",
            "mimeType": "application/pdf",
            "attachmentId": attachment_id,
            "folderPath": null,
            "clock": { DEVICE: counter },
            "createdAt": OLD,
            "modifiedAt": OLD,
        }),
        counter,
    )
}

/// What shipped desktops pushed for a binary note whose row their write-back
/// had retyped (#5419, `binary-note-record.ts:22-29`): a markdown record that
/// names no file.
fn markdown_record_over_binary(counter: u64) -> Json {
    note_record(
        json!({
            "title": "Scan",
            "content": null,
            "tags": [],
            "properties": {},
            "pinnedTags": [],
            "emoji": null,
            "fileType": "markdown",
            "folderPath": null,
            "clock": { DEVICE: counter },
            "createdAt": OLD,
            "modifiedAt": OLD,
        }),
        counter,
    )
}

fn note_record(payload: Json, counter: u64) -> Json {
    let (_, secret) = keypair();
    let sealer = AccountSealer::new(
        derive_vault_key(MASTER_KEY.to_vec()).expect("vault key"),
        DeviceSigner::new(DEVICE, secret).expect("a signer"),
    );
    sealer
        .seal_record(&PendingRecord {
            operation: SyncOperation::Update,
            row: SyncItemRow {
                item_type: "note".to_owned(),
                item_id: NOTE.to_owned(),
                payload: Some(payload.to_string()),
                payload_state: "full".to_owned(),
                clock: Some(json!({ DEVICE: counter }).to_string()),
                field_clocks: None,
                server_cursor: None,
                signer_device_id: None,
                updated_at: 1,
                deleted_at: None,
                corrupt_reason: None,
                corrupt_at: None,
            },
        })
        .expect("seals")
}

fn changes(version: u64, cursor: u64) -> Scripted {
    response(
        200,
        &json!({
            "items": [{
                "id": NOTE, "type": "note", "version": version,
                "modifiedAt": instants::to_epoch_ms(OLD).expect("an instant"),
                "size": 12,
            }],
            "deleted": [],
            "hasMore": false,
            "nextCursor": cursor,
        })
        .to_string(),
    )
}

/// A fresh device's first sync of one binary note: the bootstrap 501, no
/// record packs, the changes page, the record, and no snapshot listing.
fn first_sync_script(attachment_id: &str) -> Vec<Scripted> {
    vec![
        devices(),
        error_response(501, "BOOTSTRAP_UNAVAILABLE", "no bootstrap key"),
        error_response(404, "NOT_FOUND", "no pack route"),
        changes(1, 10),
        response(
            200,
            &json!({ "items": [binary_note(attachment_id, 1)] }).to_string(),
        ),
        error_response(404, "NOT_FOUND", "no pack route"),
    ]
}

/// One download: the device directory, the manifest, no presign, the chunks.
fn download_script(file: &File) -> Vec<Scripted> {
    let mut script = vec![
        devices(),
        response(200, &file.manifest_body),
        error_response(503, "STORAGE_PRESIGN_UNAVAILABLE", "none here"),
    ];
    script.extend(file.chunks.iter().map(|chunk| {
        Ok(HttpResponse {
            status: 200,
            headers: Default::default(),
            body: chunk.framed.clone(),
        })
    }));
    script
}

#[tokio::test]
async fn a_pulled_binary_note_file_lands_byte_identical() {
    let pdf = file(FIRST, b"%PDF-1.7 a scanned page");
    let (vault, dir) = scratch_vault();
    let mut script = first_sync_script(FIRST);
    script.extend(download_script(&pdf));
    let sync = vault.sync(session(FakeTransport::new(script)));

    sync.first_sync(None).await.expect("the first sync");
    let summary = sync
        .redrive_attachments(Reachable::Wifi)
        .await
        .expect("re-drive");

    assert_eq!((summary.downloaded, summary.failed), (1, 0));
    assert_eq!(
        std::fs::read(dir.join("images").join(FIRST)).expect("the PDF on disk"),
        pdf.plaintext
    );
    let opened = vault.notes().file(NOTE.to_string()).expect("read");
    let opened = opened.expect("a binary note opens as its file");
    assert_eq!(
        (opened.file_type.as_str(), opened.mime_type.as_deref()),
        ("pdf", Some("application/pdf"))
    );
    let cached = opened.attachment.expect("the cache row");
    assert_eq!(
        (cached.local_path.as_deref(), cached.filename.as_deref()),
        (Some(FIRST), Some("scan.pdf"))
    );
    let again = sync
        .redrive_attachments(Reachable::Wifi)
        .await
        .expect("nothing left");
    assert_eq!(again.downloaded + again.deferred + again.failed, 0);
}

#[tokio::test]
async fn the_background_download_waits_and_opening_fetches_it() {
    let pdf = file(FIRST, b"%PDF-1.7 a scanned page");
    let (vault, dir) = scratch_vault();
    let transport = FakeTransport::new(first_sync_script(FIRST));
    let sync = vault.sync(session(transport.clone()));
    sync.first_sync(None).await.expect("the first sync");
    let pulled = transport.call_count();

    let background = sync
        .redrive_attachments(Reachable::Cellular)
        .await
        .expect("re-drive");
    assert_eq!((background.downloaded, background.deferred), (0, 1));
    assert_eq!(transport.call_count(), pulled, "no bytes on metered data");
    let waiting = vault.notes().file(NOTE.to_string()).expect("read");
    assert_eq!(
        waiting.map(|file| (file.attachment_id, file.attachment)),
        Some((FIRST.to_string(), None)),
        "the note names its file before any byte arrives"
    );

    for step in download_script(&pdf) {
        transport.push(step);
    }
    // What the shell passes when the reader opens the note (#5644).
    let opened = sync
        .fetch_attachment(FIRST.to_string(), Reachable::Wifi)
        .await
        .expect("the open fetch");
    assert!(opened.downloaded);
    assert_eq!(
        std::fs::read(dir.join("images").join(FIRST)).expect("the PDF on disk"),
        pdf.plaintext
    );
}

#[tokio::test]
async fn a_peer_replacement_lands_and_keeps_the_old_bytes() {
    let old = file(FIRST, b"%PDF-1.7 the first scan");
    let new = file(SECOND, b"%PDF-1.7 the page scanned again");
    let (vault, dir) = scratch_vault();
    let mut script = first_sync_script(FIRST);
    script.extend(download_script(&old));
    let transport = FakeTransport::new(script);
    let sync = vault.sync(session(transport.clone()));
    sync.first_sync(None).await.expect("the first sync");
    sync.redrive_attachments(Reachable::Wifi)
        .await
        .expect("the first file");

    // The peer replaced the file: a new upload, a new attachment id (#5626).
    transport.push(devices());
    transport.push(changes(2, 11));
    transport.push(response(
        200,
        &json!({ "items": [binary_note(SECOND, 2)] }).to_string(),
    ));
    // The pass's body step asks after the applied note, which has no body.
    transport.push(response(200, &json!({"notes": {}}).to_string()));
    transport.push(error_response(404, "NOT_FOUND", "no snapshot"));
    sync.sync_now().await.expect("the pass");
    let replaced = vault.notes().file(NOTE.to_string()).expect("read");
    assert_eq!(
        replaced.map(|file| file.attachment_id),
        Some(SECOND.to_string())
    );

    for step in download_script(&new) {
        transport.push(step);
    }
    let summary = sync
        .redrive_attachments(Reachable::Wifi)
        .await
        .expect("re-drive");
    assert_eq!((summary.downloaded, summary.failed), (1, 0));
    assert_eq!(
        std::fs::read(dir.join("images").join(SECOND)).expect("the new PDF"),
        new.plaintext
    );
    assert_eq!(
        std::fs::read(dir.join("images").join(FIRST)).expect("the old PDF stays"),
        old.plaintext
    );
    let kept = vault
        .db_handle()
        .call_blocking(|conn| attachments::get(conn, FIRST))
        .expect("read")
        .expect("the old row");
    assert_eq!(kept.local_path.as_deref(), Some(FIRST));
}

#[tokio::test]
async fn a_markdown_record_without_the_file_keeps_it() {
    let (vault, _dir) = scratch_vault();
    let transport = FakeTransport::new(first_sync_script(FIRST));
    let sync = vault.sync(session(transport.clone()));
    sync.first_sync(None).await.expect("the first sync");

    transport.push(devices());
    transport.push(changes(2, 11));
    transport.push(response(
        200,
        &json!({ "items": [markdown_record_over_binary(2)] }).to_string(),
    ));
    transport.push(response(200, &json!({"notes": {}}).to_string()));
    transport.push(error_response(404, "NOT_FOUND", "no snapshot"));
    sync.sync_now().await.expect("the pass");

    let kept = vault.notes().file(NOTE.to_string()).expect("read");
    assert_eq!(
        kept.map(|file| (file.file_type, file.mime_type, file.attachment_id)),
        Some((
            "pdf".to_string(),
            Some("application/pdf".to_string()),
            FIRST.to_string()
        )),
        "the note still opens as its file"
    );
}
