//! A picture a peer embedded in a note, on a fresh device (#5675).
//!
//! A markdown note names its embedded files by `attachmentReferences`
//! (§14.7), and a body block names one by the manifest's filename (Q4). Real
//! first sync and pull, real chapter 04 and chapter 14 crypto, real SQLite;
//! only the transport and the secure store are fakes.
//!
//! | Test                                                   | Rule                         |
//! | ------------------------------------------------------ | ---------------------------- |
//! | the re-drive fetches a pulled note's picture           | desktop pull, rows on apply  |
//! | opening the note names, binds and fetches it           | Download attachments = Never |
//! | a pulled edit moves the reference                      | §14.7, one owner of note_refs   |
//! | a stale pulled edit moves no reference                 | a skipped record writes no row |
//! | a picture removed here is no longer wanted             | local list edits merge too   |
//! | a deleted note wants none of its pictures              | rows follow the note         |
//! | a pulled tombstone wants none of its pictures          | a `deleted` entry, sync_now  |
//! | an edit then a tombstone on one page wants none        | §5.13 page order             |
//! | an older peer's record without the list keeps the row  | absent is not `[]`           |
//! | a heal run again changes nothing                       | the backfill is idempotent   |
//! | a manifest the server lacks is not asked on every open | ten-minute 404 memory        |
//! | an upgraded device gets rows for notes it applied      | one-time backfill            |

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
use memry_core::domain::attachments::{self, BlockAttachment, CachedAttachment};
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
const NOTE: &str = "earthrise0001";
const DEVICE: &str = "device-a";
const MASTER_KEY: [u8; 32] = [7u8; 32];
const SIGNING_SEED: [u8; 32] = [11u8; 32];
const CHUNK: usize = 4;
/// Outside the first sync's thirty-day bodies window: the block urls below
/// stand in for the body, and the binding reads no body.
const OLD: &str = "2020-01-01T00:00:00.000Z";
const FIRST: &str = "c2aaafaa721c3893a1fb8ca144718a1e";
const SECOND: &str = "d3bbbfbb832d4904b2fc9db255829b2f";
const PHOTO: &str = "photo-earthrise.jpg";
/// What desktop writes into the block: `attachments/<noteId>/<basename>`.
const URL: &str = "attachments/earthrise0001/photo-earthrise.jpg";

type Scripted = Result<HttpResponse, TransportError>;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch_vault() -> (Vault, PathBuf) {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-note-embedded-{}-{unique}",
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

/// Desktop's markdown note record: no `content`, the embedded files named by
/// `attachmentReferences`.
fn note(references: &[&str], counter: u64) -> Json {
    let mut payload = unlisted_note(counter);
    payload["attachmentReferences"] = json!(references);
    seal(SyncOperation::Update, payload, None, counter)
}

/// The payload of a build that predates `attachmentReferences`.
fn unlisted_note(counter: u64) -> Json {
    json!({
        "title": "Earthrise",
        "emoji": null,
        "fileType": "markdown",
        "folderPath": null,
        "clock": { DEVICE: counter },
        "createdAt": OLD,
        "modifiedAt": OLD,
    })
}

/// The note's signed tombstone.
fn tombstone(counter: u64) -> Json {
    seal(
        SyncOperation::Delete,
        unlisted_note(counter),
        Some(1_760_000_000_000),
        counter,
    )
}

fn seal(operation: SyncOperation, payload: Json, deleted_at: Option<i64>, counter: u64) -> Json {
    let (_, secret) = keypair();
    let sealer = AccountSealer::new(
        derive_vault_key(MASTER_KEY.to_vec()).expect("vault key"),
        DeviceSigner::new(DEVICE, secret).expect("a signer"),
    );
    sealer
        .seal_record(&PendingRecord {
            operation,
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
                deleted_at,
                corrupt_reason: None,
                corrupt_at: None,
            },
        })
        .expect("seals")
}

fn changes(version: u64, cursor: u64) -> Scripted {
    changes_deleting(version, cursor, &[])
}

/// A changes page whose `deleted` names `deleted`.
fn changes_deleting(version: u64, cursor: u64, deleted: &[&str]) -> Scripted {
    response(
        200,
        &json!({
            "items": [{
                "id": NOTE, "type": "note", "version": version,
                "modifiedAt": instants::to_epoch_ms(OLD).expect("an instant"),
                "size": 12,
            }],
            "deleted": deleted,
            "hasMore": false,
            "nextCursor": cursor,
        })
        .to_string(),
    )
}

/// A fresh device's first sync of one note: the bootstrap 501, no record
/// packs, the changes page, the record, and no body packs.
fn first_sync_script(references: &[&str]) -> Vec<Scripted> {
    vec![
        devices(),
        error_response(501, "BOOTSTRAP_UNAVAILABLE", "no bootstrap key"),
        error_response(404, "NOT_FOUND", "no pack route"),
        changes(1, 10),
        response(200, &json!({ "items": [note(references, 1)] }).to_string()),
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

fn row(vault: &Vault, attachment_id: &'static str) -> Option<CachedAttachment> {
    vault
        .db_handle()
        .call_blocking(move |conn| attachments::get(conn, attachment_id))
        .expect("read")
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
        .attachment_for_block(NOTE.to_string(), URL.to_string())
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

#[tokio::test]
async fn the_redrive_fetches_a_pulled_note_picture() {
    let photo = file(FIRST, b"\xff\xd8\xff the blue marble");
    let (vault, dir) = scratch_vault();
    let transport = FakeTransport::new(first_sync_script(&[FIRST]));
    let sync = vault.sync(session(transport.clone()));

    sync.first_sync(None).await.expect("the first sync");
    assert!(
        transport
            .calls()
            .iter()
            .all(|call| !call.url.contains("/attachments")),
        "the first sync reads no manifest"
    );
    assert_eq!(
        missing(&vault),
        [FIRST],
        "the pulled note's picture is wanted"
    );

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

#[tokio::test]
async fn opening_the_note_names_binds_and_fetches_its_picture() {
    let photo = file(FIRST, b"\xff\xd8\xff the blue marble");
    let (vault, dir) = scratch_vault();
    let transport = FakeTransport::new(first_sync_script(&[FIRST]));
    let sync = vault.sync(session(transport.clone()));
    sync.first_sync(None).await.expect("the first sync");
    // Download attachments = Never: no re-drive ever runs.
    assert_eq!(block(&vault), BlockAttachment::Unknown, "no name yet");

    transport.push(devices());
    transport.push(response(200, &photo.manifest_body));
    let named = sync
        .fetch_note_manifests(NOTE.to_string())
        .await
        .expect("the open reads the manifest");
    assert_eq!(named, 1);
    assert_eq!(bound_path(block(&vault)), None, "bound, bytes not here yet");

    for step in download_script(&photo) {
        transport.push(step);
    }
    // What the shell passes when the reader opens the note (#5644).
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

    let calls = transport.call_count();
    let again = sync
        .fetch_note_manifests(NOTE.to_string())
        .await
        .expect("nothing to name");
    assert_eq!((again, transport.call_count()), (0, calls), "no request");
}

#[tokio::test]
async fn a_pulled_edit_moves_the_reference() {
    let (vault, _dir) = scratch_vault();
    let transport = FakeTransport::new(first_sync_script(&[FIRST]));
    let sync = vault.sync(session(transport.clone()));
    sync.first_sync(None).await.expect("the first sync");

    // The peer swapped the picture.
    transport.push(devices());
    transport.push(changes(2, 11));
    transport.push(response(
        200,
        &json!({ "items": [note(&[SECOND], 2)] }).to_string(),
    ));
    // The pass's body step asks after the applied note.
    transport.push(response(200, &json!({"notes": {}}).to_string()));
    transport.push(error_response(404, "NOT_FOUND", "no snapshot"));
    sync.sync_now().await.expect("the pass");

    let first = row(&vault, FIRST).expect("the old row stays");
    assert!(
        first.note_refs.is_empty(),
        "the old picture is not this note's"
    );
    assert_eq!(row(&vault, SECOND).expect("a row").note_refs, [NOTE]);
    assert_eq!(missing(&vault), [SECOND]);
}

#[tokio::test]
async fn a_stale_pulled_edit_moves_no_reference() {
    let (vault, _dir) = scratch_vault();
    let mut script = first_sync_script(&[FIRST]);
    script[4] = response(200, &json!({ "items": [note(&[FIRST], 2)] }).to_string());
    let transport = FakeTransport::new(script);
    let sync = vault.sync(session(transport.clone()));
    sync.first_sync(None).await.expect("the first sync");

    // A peer's older copy, which names another picture: the page skips it.
    transport.push(devices());
    transport.push(changes(2, 11));
    transport.push(response(
        200,
        &json!({ "items": [note(&[SECOND], 1)] }).to_string(),
    ));
    transport.push(response(200, &json!({"notes": {}}).to_string()));
    transport.push(error_response(404, "NOT_FOUND", "no snapshot"));
    sync.sync_now().await.expect("the pass");

    assert_eq!(row(&vault, FIRST).expect("a row").note_refs, [NOTE]);
    assert!(row(&vault, SECOND).is_none(), "the stale list wrote no row");
    assert_eq!(missing(&vault), [FIRST]);
}

#[tokio::test]
async fn a_picture_removed_here_is_no_longer_wanted() {
    let (vault, _dir) = scratch_vault();
    let transport = FakeTransport::new(first_sync_script(&[FIRST, SECOND]));
    let sync = vault.sync(session(transport));
    sync.first_sync(None).await.expect("the first sync");
    assert_eq!(missing(&vault).len(), 2);

    // What removing the picture's block on this device writes.
    vault
        .db_handle()
        .call_blocking(|conn| {
            memry_core::domain::notes::remove_attachment_reference(conn, NOTE, FIRST, DEVICE, 2)
        })
        .expect("the removal")
        .expect("the list changed");

    assert!(
        row(&vault, FIRST)
            .expect("the row stays")
            .note_refs
            .is_empty()
    );
    assert_eq!(missing(&vault), [SECOND]);
}

#[tokio::test]
async fn a_deleted_note_wants_none_of_its_pictures() {
    let (vault, _dir) = scratch_vault();
    let transport = FakeTransport::new(first_sync_script(&[FIRST]));
    let sync = vault.sync(session(transport));
    sync.first_sync(None).await.expect("the first sync");
    assert_eq!(missing(&vault), [FIRST]);

    // `NotesWriter::delete`'s write.
    vault
        .db_handle()
        .call_blocking(|conn| memry_core::domain::notes::delete(conn, NOTE, DEVICE, 2))
        .expect("the delete");

    assert!(missing(&vault).is_empty());
    assert!(
        row(&vault, FIRST)
            .expect("the row stays")
            .note_refs
            .is_empty()
    );
}

/// One pass that pulls `items` for a page whose `deleted` names the note.
async fn pull_deleting(
    sync: &memry_core::api::sync::VaultSync,
    transport: &FakeTransport,
    items: Json,
) {
    transport.push(devices());
    transport.push(changes_deleting(2, 11, &[NOTE]));
    transport.push(response(200, &json!({ "items": items }).to_string()));
    transport.push(response(200, &json!({"notes": {}}).to_string()));
    transport.push(error_response(404, "NOT_FOUND", "no snapshot"));
    sync.sync_now().await.expect("the pass");
}

fn note_is_deleted(vault: &Vault) -> bool {
    vault
        .db_handle()
        .call_blocking(|conn| {
            conn.query_row(
                "SELECT deleted_at IS NOT NULL FROM notes WHERE id = ?1",
                [NOTE],
                |row| row.get(0),
            )
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })
        })
        .expect("read")
}

#[tokio::test]
async fn a_pulled_tombstone_wants_none_of_its_pictures() {
    let (vault, _dir) = scratch_vault();
    let transport = FakeTransport::new(first_sync_script(&[FIRST]));
    let sync = vault.sync(session(transport.clone()));
    sync.first_sync(None).await.expect("the first sync");

    pull_deleting(&sync, &transport, json!([tombstone(2)])).await;

    assert!(note_is_deleted(&vault), "the tombstone applied");
    assert!(missing(&vault).is_empty());
    assert!(
        row(&vault, FIRST)
            .expect("the row stays")
            .note_refs
            .is_empty()
    );
}

#[tokio::test]
async fn an_edit_then_a_tombstone_on_one_page_wants_none() {
    let (vault, _dir) = scratch_vault();
    let transport = FakeTransport::new(first_sync_script(&[FIRST]));
    let sync = vault.sync(session(transport.clone()));
    sync.first_sync(None).await.expect("the first sync");

    pull_deleting(&sync, &transport, json!([note(&[SECOND], 2), tombstone(3)])).await;

    assert!(note_is_deleted(&vault), "the tombstone applied");
    assert!(missing(&vault).is_empty(), "neither picture is wanted");
    assert!(row(&vault, FIRST).is_none_or(|row| row.note_refs.is_empty()));
    assert!(row(&vault, SECOND).is_none_or(|row| row.note_refs.is_empty()));
}

#[tokio::test]
async fn an_older_peers_record_without_the_list_keeps_the_row() {
    let (vault, _dir) = scratch_vault();
    let transport = FakeTransport::new(first_sync_script(&[FIRST]));
    let sync = vault.sync(session(transport.clone()));
    sync.first_sync(None).await.expect("the first sync");

    // A build that predates `attachmentReferences` edits the title.
    let unlisted = seal(SyncOperation::Update, unlisted_note(2), None, 2);
    for step in [
        devices(),
        changes(2, 11),
        response(200, &json!({ "items": [unlisted] }).to_string()),
        response(200, &json!({"notes": {}}).to_string()),
        error_response(404, "NOT_FOUND", "no snapshot"),
    ] {
        transport.push(step);
    }
    sync.sync_now().await.expect("the pass");
    assert_eq!(
        row(&vault, FIRST).expect("a row").note_refs,
        [NOTE],
        "absent is not empty"
    );
    assert_eq!(missing(&vault), [FIRST]);

    // A later record that says `[]` does drop it.
    for step in [
        devices(),
        changes(3, 12),
        response(200, &json!({ "items": [note(&[], 3)] }).to_string()),
        response(200, &json!({"notes": {}}).to_string()),
        error_response(404, "NOT_FOUND", "no snapshot"),
    ] {
        transport.push(step);
    }
    sync.sync_now().await.expect("the pass");
    assert!(
        row(&vault, FIRST)
            .expect("the row stays")
            .note_refs
            .is_empty()
    );
    assert!(missing(&vault).is_empty());
}

#[tokio::test]
async fn a_heal_run_again_changes_nothing() {
    let (vault, _dir) = scratch_vault();
    let transport = FakeTransport::new(first_sync_script(&[FIRST, SECOND]));
    let sync = vault.sync(session(transport.clone()));
    sync.first_sync(None).await.expect("the first sync");

    for _ in 0..2 {
        vault
            .db_handle()
            .call_blocking(|conn| {
                conn.execute_batch("DELETE FROM meta WHERE key = 'sync.note_refs_heal';")
                    .map_err(|error| memry_core::api::errors::StorageError::Failed {
                        what: error.to_string(),
                    })
            })
            .expect("the heal runs again");
        for step in [
            devices(),
            response(
                200,
                &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": 10})
                    .to_string(),
            ),
            response(200, &json!({"notes": {}}).to_string()),
            error_response(404, "NOT_FOUND", "no snapshot"),
        ] {
            transport.push(step);
        }
        sync.sync_now().await.expect("the pass");

        assert_eq!(row(&vault, FIRST).expect("a row").note_refs, [NOTE]);
        assert_eq!(row(&vault, SECOND).expect("a row").note_refs, [NOTE]);
        let mut wanted = missing(&vault);
        wanted.sort();
        assert_eq!(wanted, [FIRST, SECOND]);
    }
}

#[tokio::test]
async fn a_manifest_the_server_lacks_is_not_asked_on_every_open() {
    // Its own id: the 404 memory is per vault and attachment, process-wide.
    const GONE: &str = "e4cccfcc943e5a15c3ad0eb366930c3a";
    let (vault, _dir) = scratch_vault();
    let transport = FakeTransport::new(first_sync_script(&[GONE]));
    let sync = vault.sync(session(transport.clone()));
    sync.first_sync(None).await.expect("the first sync");

    transport.push(devices());
    transport.push(error_response(404, "NOT_FOUND", "no manifest"));
    let named = sync
        .fetch_note_manifests(NOTE.to_string())
        .await
        .expect("a 404 is logged, not raised");
    assert_eq!(named, 0);

    let calls = transport.call_count();
    let again = sync
        .fetch_note_manifests(NOTE.to_string())
        .await
        .expect("the next open");
    assert_eq!((again, transport.call_count()), (0, calls), "no request");
}

#[tokio::test]
async fn an_upgraded_device_gets_rows_for_notes_it_applied() {
    let photo = file(FIRST, b"\xff\xd8\xff the blue marble");
    let (vault, _dir) = scratch_vault();
    let transport = FakeTransport::new(first_sync_script(&[FIRST]));
    let sync = vault.sync(session(transport.clone()));
    sync.first_sync(None).await.expect("the first sync");
    // What a build before #5675 left: the note's list, no row, and no heal.
    vault
        .db_handle()
        .call_blocking(|conn| {
            conn.execute_batch(
                "DELETE FROM attachments; DELETE FROM meta WHERE key = 'sync.note_refs_heal';",
            )
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })
        })
        .expect("the old state");
    assert!(missing(&vault).is_empty());

    transport.push(devices());
    transport.push(response(
        200,
        &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": 10}).to_string(),
    ));
    // The body step asks after the note the first sync left out of its window.
    transport.push(response(200, &json!({"notes": {}}).to_string()));
    transport.push(error_response(404, "NOT_FOUND", "no snapshot"));
    sync.sync_now()
        .await
        .expect("the first pass after the upgrade");

    assert_eq!(missing(&vault), [FIRST]);
    for step in download_script(&photo) {
        transport.push(step);
    }
    let summary = sync
        .redrive_attachments(Reachable::Wifi)
        .await
        .expect("re-drive");
    assert_eq!((summary.downloaded, summary.failed), (1, 0));
}
