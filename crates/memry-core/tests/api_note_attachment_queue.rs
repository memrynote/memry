//! A note attach made without a network (#5510, §14.7): the bytes are kept and
//! the block binds at once, a relaunch keeps the upload owed, and a later sync
//! pass uploads it once, under the same id, before it pushes the reference.
//!
//! Real `HttpClient`, `AuthSession`, SQLite, the filesystem and chapter 14
//! crypto; only the transport and secure store are fakes.

mod http_fakes;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, FakeTransport, body_json, error_response, jwt, response};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::errors::{SyncError, TransportError};
use memry_core::api::sync::VaultSync;
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::domain::attachments::BlockAttachment;
use memry_core::domain::notes;
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::seams::transport::HttpResponse;
use serde_json::json;

const BASE: &str = "https://sync.example.com";
const DEVICE: &str = "server-device-1";
const MASTER_KEY: [u8; 32] = [7u8; 32];
const SIGNING_SEED: [u8; 32] = [11u8; 32];
const BYTES: &[u8] = b"a picture taken offline";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

type Scripted = Result<HttpResponse, TransportError>;

fn scratch_dir() -> PathBuf {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-api-note-attachment-queue-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    dir
}

fn store() -> Arc<FakeSecureStore> {
    let (_public, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let store = FakeSecureStore::new();
    store.put_text(
        SecureStoreKey::AccessToken,
        &jwt(json!({"sub": "user-1", "device_id": DEVICE, "type": "access", "exp": 9_999_999_999u64})),
    );
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .expect("plant the master key");
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");
    store
}

/// One app launch over the vault at `dir`.
struct Launch {
    vault: Vault,
    sync: Arc<VaultSync>,
    transport: Arc<FakeTransport>,
}

fn launch(dir: &Path, store: &Arc<FakeSecureStore>, script: Vec<Scripted>) -> Launch {
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    let transport = FakeTransport::new(script);
    let session = Arc::new(
        AuthSession::new(
            transport.clone(),
            store.clone(),
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
    );
    let sync = vault.sync(session);
    Launch {
        vault,
        sync,
        transport,
    }
}

/// The four answers one small upload takes: initiate, one chunk, complete,
/// the manifest.
fn upload_script() -> Vec<Scripted> {
    vec![
        response(
            200,
            &json!({"sessionId": "upload-1", "expiresAt": 9_999_999_999_000i64}).to_string(),
        ),
        response(200, &json!({"success": true}).to_string()),
        response(200, &json!({"success": true}).to_string()),
        response(200, &json!({"success": true}).to_string()),
    ]
}

impl Launch {
    fn note(&self, store: &Arc<FakeSecureStore>) -> String {
        self.vault
            .notes_writer(store.clone())
            .expect("a writer")
            .create("Offline".to_string(), None)
            .expect("create")
    }

    async fn attach(&self, note_id: &str) -> Result<String, SyncError> {
        self.sync
            .upload_attachment(
                note_id.to_owned(),
                "photo.png".to_owned(),
                "image/png".to_owned(),
                BYTES.to_vec(),
            )
            .await
    }

    fn references(&self, note_id: &str) -> Vec<String> {
        let note = note_id.to_owned();
        self.vault
            .db_handle()
            .call_blocking(move |conn| notes::read_attachment_references(conn, &note))
            .expect("references")
    }

    fn block(&self, note_id: &str) -> BlockAttachment {
        self.vault
            .notes()
            .attachment_for_block(
                note_id.to_owned(),
                format!("attachments/{note_id}/photo.png"),
            )
            .expect("resolve")
    }

    fn manifest_ids(&self) -> Vec<String> {
        self.transport
            .calls_to("/manifest")
            .iter()
            .map(|call| {
                let path = call.url.trim_end_matches("/manifest");
                path.rsplit('/').next().unwrap_or_default().to_owned()
            })
            .collect()
    }
}

#[tokio::test]
async fn an_offline_attach_keeps_the_bytes_and_binds_the_block_at_once() {
    let (dir, store) = (scratch_dir(), store());
    let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
    let note = app.note(&store);

    let id = app.attach(&note).await.expect("kept for later");

    assert_eq!(app.transport.call_count(), 1, "one try, no retry ladder");
    assert_eq!(
        std::fs::read(dir.join("images").join(&id)).expect("the bytes"),
        BYTES
    );
    match app.block(&note) {
        BlockAttachment::Bound { attachment } => {
            assert_eq!(attachment.attachment_id, id);
            assert_eq!(attachment.local_path.as_deref(), Some(id.as_str()));
        }
        other => panic!("the block should bind its kept bytes, got {other:?}"),
    }
    assert!(
        app.references(&note).is_empty(),
        "no reference before a manifest"
    );
}

#[tokio::test]
async fn a_relaunch_keeps_the_upload_and_the_next_pass_sends_it_once_under_its_id() {
    let (dir, store) = (scratch_dir(), store());
    let (note, id) = {
        let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
        let note = app.note(&store);
        let id = app.attach(&note).await.expect("kept for later");
        (note, id)
    };

    let app = launch(&dir, &store, upload_script());
    assert_eq!(
        app.sync.upload_queued_attachments().await.expect("drain"),
        1
    );

    assert_eq!(app.manifest_ids(), vec![id.clone()]);
    let initiate = app.transport.calls_to("/upload/initiate");
    assert_eq!(body_json(&initiate[0])["attachmentId"], json!(id));
    assert_eq!(app.references(&note), vec![id.clone()]);
    match app.block(&note) {
        BlockAttachment::Bound { attachment } => assert!(attachment.manifest.is_some()),
        other => panic!("still bound after the upload, got {other:?}"),
    }

    let calls = app.transport.call_count();
    assert_eq!(
        app.sync.upload_queued_attachments().await.expect("again"),
        0
    );
    assert_eq!(app.transport.call_count(), calls, "nothing uploads twice");
}

#[tokio::test]
async fn an_online_attach_uploads_and_references_at_once() {
    let (dir, store) = (scratch_dir(), store());
    let app = launch(&dir, &store, upload_script());
    let note = app.note(&store);

    let id = app.attach(&note).await.expect("uploaded");

    assert_eq!(app.manifest_ids(), vec![id.clone()]);
    assert_eq!(app.references(&note), vec![id]);
    assert_eq!(
        app.sync.upload_queued_attachments().await.expect("drain"),
        0
    );
}

#[tokio::test]
async fn a_refused_attach_is_taken_back_and_keeps_nothing() {
    let (dir, store) = (scratch_dir(), store());
    let app = launch(
        &dir,
        &store,
        vec![error_response(413, "STORAGE_QUOTA_EXCEEDED", "over quota")],
    );
    let note = app.note(&store);

    let error = app.attach(&note).await.expect_err("refused");

    assert!(matches!(error, SyncError::Api { .. }), "{error:?}");
    assert!(matches!(app.block(&note), BlockAttachment::Unknown));
    let images = dir.join("images");
    let left = std::fs::read_dir(&images)
        .map(|dir| dir.count())
        .unwrap_or(0);
    assert_eq!(left, 0, "no bytes kept for a refused attach");
    assert_eq!(
        app.sync.upload_queued_attachments().await.expect("drain"),
        0
    );
}

#[tokio::test]
async fn a_picture_detached_before_its_upload_never_uploads() {
    let (dir, store) = (scratch_dir(), store());
    let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
    let note = app.note(&store);
    let id = app.attach(&note).await.expect("kept for later");

    app.sync
        .detach_attachment(note.clone(), id)
        .await
        .expect("detach");

    assert_eq!(
        app.sync.upload_queued_attachments().await.expect("drain"),
        0
    );
    assert_eq!(app.transport.call_count(), 1, "only the first try went out");
}

/// The pass uploads a kept attachment before its push, so the note leaves with
/// the new reference in the same push.
#[tokio::test]
async fn the_sync_pass_uploads_a_kept_attachment_before_it_pushes_the_reference() {
    let (dir, store) = (scratch_dir(), store());
    let (note, id) = {
        let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
        let note = app.note(&store);
        let id = app.attach(&note).await.expect("kept for later");
        (note, id)
    };

    let (public, _secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let mut script = vec![
        response(
            200,
            &json!({"devices": [{"id": DEVICE, "signingPublicKey": BASE64.encode(&public)}]})
                .to_string(),
        ),
        response(
            200,
            &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": null}).to_string(),
        ),
    ];
    script.extend(upload_script());
    script.push(response(
        200,
        &json!({"accepted": [note], "rejected": [], "serverTime": 1, "maxCursor": 1}).to_string(),
    ));
    let app = launch(&dir, &store, script);

    app.sync.sync_now().await.expect("the pass");

    let urls: Vec<String> = app
        .transport
        .calls()
        .iter()
        .map(|c| c.url.clone())
        .collect();
    let manifest = urls.iter().position(|url| url.ends_with("/manifest"));
    let push = urls.iter().position(|url| url.ends_with("/sync/push"));
    assert!(manifest.is_some() && manifest < push, "{urls:?}");
    assert_eq!(app.manifest_ids(), vec![id.clone()]);
    assert_eq!(app.references(&note), vec![id]);
}
