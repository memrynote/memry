//! A picture a peer embedded in a journal day, on a fresh device (#5727).
//!
//! A journal record carries no `attachmentReferences` (§13.7.2,
//! `JournalSyncPayloadSchema`). Desktop names a day's pictures in a `note`
//! record under the day's own id: an upload runs `recordOnNote`
//! (`apps/desktop/src/main/sync/note-attachment-metadata.ts`), which pushes
//! the shared `note_metadata` row as a note. That record's list is what gives
//! the day attachment rows here, so the day page's open fetch and the re-drive
//! find its pictures. Real first sync and pull, real chapter 04 and chapter 14
//! crypto, real SQLite; only the transport and the secure store are fakes.
//!
//! | Test                                                | Rule                         |
//! | --------------------------------------------------- | ---------------------------- |
//! | opening the day names, binds and fetches its picture | Download attachments = Never |
//! | the re-drive fetches a pulled day's picture         | rows on apply                |

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
use memry_core::domain::attachments::{self, BlockAttachment};
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
const DAY: &str = "j2020-01-01";
const DATE: &str = "2020-01-01";
const DEVICE: &str = "device-a";
const MASTER_KEY: [u8; 32] = [7u8; 32];
const SIGNING_SEED: [u8; 32] = [11u8; 32];
const CHUNK: usize = 4;
/// Outside the first sync's thirty-day bodies window: the block urls below
/// stand in for the body, and the binding reads no body.
const OLD: &str = "2020-01-01T00:00:00.000Z";
const FIRST: &str = "c2aaafaa721c3893a1fb8ca144718a1e";
const PHOTO: &str = "photo-earthrise.jpg";
/// What desktop writes into the block: `attachments/<noteId>/<basename>`.
const URL: &str = "attachments/j2020-01-01/photo-earthrise.jpg";

type Scripted = Result<HttpResponse, TransportError>;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch_vault() -> (Vault, PathBuf) {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-journal-embedded-{}-{unique}",
        std::process::id()
    ));
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

/// The photo a peer uploaded, sealed as chapter 14 seals it.
struct File {
    plaintext: Vec<u8>,
    chunks: Vec<FramedChunk>,
    manifest_body: String,
}

fn file(attachment_id: &str, plaintext: &[u8]) -> File {
    let (_, secret) = keypair();
    let file_key = vec![3u8; 32];
    let chunks =
        frame_chunks(plaintext, &file_key, CHUNK, |index| vec![index as u8; 24]).expect("chunks");
    let manifest = build_manifest(
        attachment_id,
        PHOTO,
        "image/jpeg",
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

fn sealed(item_type: &str, payload: Json, counter: u64) -> Json {
    let (_, secret) = keypair();
    let sealer = AccountSealer::new(
        derive_vault_key(MASTER_KEY.to_vec()).expect("vault key"),
        DeviceSigner::new(DEVICE, secret).expect("a signer"),
    );
    sealer
        .seal_record(&PendingRecord {
            operation: SyncOperation::Update,
            row: SyncItemRow {
                item_type: item_type.to_owned(),
                item_id: DAY.to_owned(),
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

/// Desktop's journal record (`journal-sync.ts` `buildSnapshotPayload`).
fn journal(counter: u64) -> Json {
    sealed(
        "journal",
        json!({
            "date": DATE,
            "content": null,
            "tags": [],
            "properties": null,
            "clock": { DEVICE: counter },
            "createdAt": OLD,
            "modifiedAt": OLD,
        }),
        counter,
    )
}

/// The `note` record desktop pushes under the day's id once a picture
/// uploads (`note-attachment-metadata.ts` `recordOnNote`).
fn day_note(references: &[&str], counter: u64) -> Json {
    sealed(
        "note",
        json!({
            "title": DATE,
            "fileType": "markdown",
            "attachmentReferences": references,
            "folderPath": "journal",
            "clock": { DEVICE: counter },
            "createdAt": OLD,
            "modifiedAt": OLD,
        }),
        counter,
    )
}

fn changes(types: &[&str], version: u64, cursor: u64) -> Scripted {
    let items: Vec<Json> = types
        .iter()
        .map(|kind| {
            json!({
                "id": DAY, "type": kind, "version": version,
                "modifiedAt": instants::to_epoch_ms(OLD).expect("an instant"),
                "size": 12,
            })
        })
        .collect();
    response(
        200,
        &json!({ "items": items, "deleted": [], "hasMore": false, "nextCursor": cursor })
            .to_string(),
    )
}

/// A fresh device's first sync of `records`: the bootstrap 501, no record
/// packs, the changes page, the records, and no body packs.
fn first_sync_script(types: &[&str], records: Vec<Json>) -> Vec<Scripted> {
    vec![
        devices(),
        error_response(501, "BOOTSTRAP_UNAVAILABLE", "no bootstrap key"),
        error_response(404, "NOT_FOUND", "no pack route"),
        changes(types, 1, 10),
        response(200, &json!({ "items": records }).to_string()),
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

fn missing(vault: &Vault) -> Vec<String> {
    vault
        .db_handle()
        .call_blocking(|conn| attachments::missing_downloads(conn))
        .expect("read")
}

fn block(vault: &Vault) -> BlockAttachment {
    vault
        .notes()
        .attachment_for_block(DAY.to_string(), URL.to_string())
        .expect("resolve")
}

fn bound_path(binding: BlockAttachment) -> Option<String> {
    match binding {
        BlockAttachment::Bound { attachment } => {
            assert_eq!(attachment.filename.as_deref(), Some(PHOTO));
            attachment.local_path
        }
        other => panic!("the block did not bind: {other:?}"),
    }
}

fn desktop_day_script() -> Vec<Scripted> {
    first_sync_script(
        &["journal", "note"],
        vec![journal(1), day_note(&[FIRST], 1)],
    )
}

#[tokio::test]
async fn opening_the_day_names_binds_and_fetches_its_picture() {
    let photo = file(FIRST, b"\xff\xd8\xff the blue marble");
    let (vault, dir) = scratch_vault();
    let transport = FakeTransport::new(desktop_day_script());
    let sync = vault.sync(session(transport.clone()));
    sync.first_sync(None).await.expect("the first sync");
    assert!(
        vault
            .db_handle()
            .call_blocking(|conn| Ok(memry_core::domain::journal::journal_exists(conn, DAY)))
            .expect("read"),
        "the day landed"
    );
    // Download attachments = Never: no re-drive ever runs.
    assert_eq!(block(&vault), BlockAttachment::Unknown, "no name yet");

    // What `NoteReadViewModel.fetchWaitingAttachments` asks with the day's id.
    transport.push(devices());
    transport.push(response(200, &photo.manifest_body));
    let named = sync
        .fetch_note_manifests(DAY.to_string())
        .await
        .expect("the open reads the manifest");
    assert_eq!(named, 1);
    assert_eq!(bound_path(block(&vault)), None, "bound, bytes not here yet");

    for step in download_script(&photo) {
        transport.push(step);
    }
    let opened = sync
        .fetch_attachment(FIRST.to_string(), Reachable::Wifi)
        .await
        .expect("the open fetch");
    assert!(opened.downloaded);
    assert_eq!(
        std::fs::read(dir.join("images").join(FIRST)).expect("the photo on disk"),
        photo.plaintext
    );
    assert_eq!(bound_path(block(&vault)).as_deref(), Some(FIRST));
}

#[tokio::test]
async fn the_redrive_fetches_a_pulled_day_picture() {
    let photo = file(FIRST, b"\xff\xd8\xff the blue marble");
    let (vault, dir) = scratch_vault();
    let transport = FakeTransport::new(desktop_day_script());
    let sync = vault.sync(session(transport.clone()));
    sync.first_sync(None).await.expect("the first sync");
    assert_eq!(missing(&vault), [FIRST], "the day's picture is wanted");

    for step in download_script(&photo) {
        transport.push(step);
    }
    let summary = sync
        .redrive_attachments(Reachable::Wifi)
        .await
        .expect("re-drive");
    assert_eq!((summary.downloaded, summary.failed), (1, 0));
    assert_eq!(
        std::fs::read(dir.join("images").join(FIRST)).expect("the photo on disk"),
        photo.plaintext
    );
    assert_eq!(bound_path(block(&vault)).as_deref(), Some(FIRST));
}
