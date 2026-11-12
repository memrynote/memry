//! `VaultSync::sync_inbox_attachments` and `attach_inbox_file` over the
//! exported surface (#4157, §14.7.2).
//!
//! Real `HttpClient`, `AuthSession`, SQLite, the filesystem and chapter 14
//! crypto; only the transport and secure store are fakes.
//!
//! | Test                                                        | Rule                                     |
//! | ----------------------------------------------------------- | ---------------------------------------- |
//! | a pending capture uploads and records its attachment id     | upload on capture, then a local edit     |
//! | a quota refusal leaves the capture local-only, for good     | `STORAGE_QUOTA_EXCEEDED` is permanent    |
//! | any other failure keeps the capture pending                 | retry on the next pass                   |
//! | offline uploads and releases nothing                        | reachability                             |
//! | a missing file or a path outside the folder is dropped      | receiver and sender path rule            |
//! | a peer's capture downloads into its own folder              | download pass, `fetch_attachment` policy |
//! | a metered path defers the download                          | FR-045                                   |
//! | a path outside the capture's folder is never written        | receiver path rule                       |
//! | a deleted capture's chunks are dereferenced after 30 days   | §14.8                                    |
//! | a file a note references is not dereferenced                | filing reuse                             |
//! | filing reuses a cached upload and answers its manifest name | §14.7.2 filing                           |
//! | filing an unsynced capture uploads it into the note         | §14.7.2 filing                           |

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, FakeTransport, body_json, error_response, jwt, response};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::crypto::derive_vault_key;
use memry_core::api::inbox::Inbox;
use memry_core::api::sync::VaultSync;
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::domain::inbox::attachments as files;
use memry_core::domain::notes;
use memry_core::protocol::attachment_manifest;
use memry_core::protocol::attachment_upload::{FramedChunk, build_manifest, frame_chunks};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::reachability::Reachable;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::seams::transport::HttpResponse;
use memry_core::storage::repositories::sync_items::InboundRecord;
use memry_core::sync::apply::apply_inbound;
use serde_json::json;

const BASE: &str = "https://sync.example.com";
const PEER: &str = "peer-device";
const ATTACHMENT: &str = "0123456789abcdef0123456789abcdef";
const MASTER_KEY: [u8; 32] = [7u8; 32];
const SIGNING_SEED: [u8; 32] = [11u8; 32];
const CHUNK: usize = 4;
const THIRTY_ONE_DAYS_MS: i64 = 31 * 24 * 60 * 60 * 1000;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

type Scripted = Result<HttpResponse, memry_core::api::errors::TransportError>;

struct Env {
    vault: Vault,
    dir: PathBuf,
    store: Arc<FakeSecureStore>,
    inbox: Arc<Inbox>,
    sync: Arc<VaultSync>,
    transport: Arc<FakeTransport>,
}

fn env(script: Vec<Scripted>) -> Env {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-api-inbox-attachments-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let vault = Vault::open(format!("vault-{unique}"), dir.display().to_string()).expect("open");
    let (_public, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let store = FakeSecureStore::new();
    store.put_text(
        SecureStoreKey::AccessToken,
        &jwt(
            json!({"sub": "user-1", "device_id": PEER, "type": "access", "exp": 9_999_999_999u64}),
        ),
    );
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .expect("plant the master key");
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");
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
    let inbox = vault.inbox(store.clone()).expect("the inbox surface");
    let sync = vault.sync(session);
    Env {
        vault,
        dir,
        store,
        inbox,
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

impl Env {
    /// A capture whose file is on disk at its own folder, as the shell stores it.
    fn capture(&self, name: &str, bytes: &[u8]) -> String {
        let id = self.inbox.new_id();
        let path = format!("attachments/inbox/{id}/{name}");
        std::fs::create_dir_all(self.dir.join(format!("attachments/inbox/{id}"))).expect("dir");
        std::fs::write(self.dir.join(&path), bytes).expect("the file");
        self.inbox
            .capture_file(
                id.clone(),
                "image/png".into(),
                name.into(),
                bytes.len() as u64,
                path,
                None,
                None,
                Some("inline".into()),
            )
            .expect("capture");
        id
    }

    fn pending(&self) -> Vec<String> {
        self.vault
            .db_handle()
            .call_blocking(|conn| files::pending_ids(conn))
            .expect("pending")
    }

    fn attachment_id(&self, item: &str) -> Option<String> {
        self.inbox
            .get(item.to_owned())
            .expect("get")
            .expect("live")
            .attachment_id
    }

    /// A peer's pushed capture, through the real apply path.
    fn peer_capture(&self, path: &str, attachment_id: &str, clock: u64) {
        let payload = json!({
            "type": "image", "title": "a", "attachmentPath": path,
            "attachmentId": attachment_id, "clock": { "desktop": clock },
        });
        self.vault
            .db_handle()
            .call_blocking(|conn| {
                let record = InboundRecord {
                    item_type: "inbox".to_owned(),
                    item_id: "inbox-1".to_owned(),
                    payload_json: payload.to_string(),
                    server_cursor: Some(1),
                    signer_device_id: Some("desktop".to_owned()),
                    updated_at: 1,
                    deleted_at: None,
                };
                apply_inbound(conn, &record, 1)?;
                Ok(())
            })
            .expect("apply");
    }
}

/// A three-chunk attachment sealed as a peer's device would have uploaded it.
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
        &manifest, &file_key, &vault_key, &[1u8; 24], &[2u8; 24], &secret, PEER,
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
            json!({"devices": [{"id": PEER, "signingPublicKey": BASE64.encode(&public)}]})
                .to_string(),
    }
}

fn raw(bytes: &[u8]) -> Scripted {
    Ok(HttpResponse {
        status: 200,
        headers: Default::default(),
        body: bytes.to_vec(),
    })
}

fn download_script(fx: &Fixture) -> Vec<Scripted> {
    let mut script = vec![
        response(200, &fx.devices_body),
        response(200, &fx.manifest_body),
        error_response(503, "STORAGE_PRESIGN_UNAVAILABLE", "none here"),
    ];
    script.extend(fx.chunks.iter().map(|chunk| raw(&chunk.framed)));
    script
}

fn backdate_releases(env: &Env) {
    env.vault
        .db_handle()
        .call_blocking(|conn| {
            conn.execute(
                "UPDATE inbox_attachment_releases SET deleted_at = deleted_at - ?1",
                [THIRTY_ONE_DAYS_MS],
            )
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })?;
            Ok(())
        })
        .expect("backdate");
}

#[tokio::test]
async fn a_pending_capture_uploads_and_records_its_attachment_id() {
    let env = env(upload_script());
    let id = env.capture("a.png", &[1, 2, 3]);
    assert_eq!(env.pending(), vec![id.clone()]);
    env.vault
        .db_handle()
        .call_blocking(|conn| {
            conn.execute("DELETE FROM outbox", []).ok();
            Ok(())
        })
        .expect("drain");

    let summary = env
        .sync
        .sync_inbox_attachments(Reachable::Wifi)
        .await
        .expect("pass");

    assert_eq!((summary.uploaded, summary.failed), (1, 0));
    let attachment_id = env.attachment_id(&id).expect("the id is recorded");
    assert_eq!(
        std::fs::read(env.dir.join("images").join(&attachment_id)).expect("cached bytes"),
        [1, 2, 3]
    );
    assert!(env.pending().is_empty());
    assert_eq!(
        env.sync.pending_changes().expect("depth"),
        1,
        "the id is queued to push"
    );
    let initiate = env
        .transport
        .calls_to("/upload/initiate")
        .pop()
        .expect("an upload session");
    assert_eq!(body_json(&initiate)["filename"], "a.png");

    let calls = env.transport.call_count();
    let again = env
        .sync
        .sync_inbox_attachments(Reachable::Wifi)
        .await
        .expect("pass");
    assert_eq!((again.uploaded, again.failed), (0, 0));
    assert_eq!(env.transport.call_count(), calls, "nothing left to upload");
}

#[tokio::test]
async fn a_quota_refusal_leaves_the_capture_local_only_for_good() {
    let env = env(vec![error_response(413, "STORAGE_QUOTA_EXCEEDED", "full")]);
    let id = env.capture("a.png", &[1, 2, 3]);

    let summary = env
        .sync
        .sync_inbox_attachments(Reachable::Wifi)
        .await
        .expect("pass");

    assert_eq!((summary.uploaded, summary.failed), (0, 0));
    assert_eq!(env.attachment_id(&id), None);
    assert!(env.pending().is_empty(), "no further retries");
    let calls = env.transport.call_count();
    env.sync
        .sync_inbox_attachments(Reachable::Wifi)
        .await
        .expect("pass");
    assert_eq!(env.transport.call_count(), calls);
}

#[tokio::test]
async fn any_other_failure_keeps_the_capture_pending() {
    let env = env(vec![error_response(400, "VALIDATION_ERROR", "no")]);
    let id = env.capture("a.png", &[1, 2, 3]);

    let summary = env
        .sync
        .sync_inbox_attachments(Reachable::Wifi)
        .await
        .expect("pass");
    assert_eq!((summary.uploaded, summary.failed), (0, 1));
    assert_eq!(env.pending(), vec![id.clone()]);

    for item in upload_script() {
        env.transport.push(item);
    }
    let retry = env
        .sync
        .sync_inbox_attachments(Reachable::Wifi)
        .await
        .expect("pass");
    assert_eq!((retry.uploaded, retry.failed), (1, 0));
    assert!(env.attachment_id(&id).is_some());
}

#[tokio::test]
async fn offline_uploads_and_releases_nothing() {
    let env = env(vec![]);
    let id = env.capture("a.png", &[1, 2, 3]);

    let summary = env
        .sync
        .sync_inbox_attachments(Reachable::Offline)
        .await
        .expect("pass");

    assert_eq!(summary, Default::default());
    assert_eq!(env.transport.call_count(), 0);
    assert_eq!(env.pending(), vec![id]);
}

#[tokio::test]
async fn a_missing_file_or_a_path_outside_the_folder_is_dropped_unread() {
    let env = env(vec![]);
    let missing = env.capture("a.png", &[1]);
    std::fs::remove_file(env.dir.join(format!("attachments/inbox/{missing}/a.png"))).expect("rm");
    let outside = env.inbox.new_id();
    std::fs::write(env.dir.join("secret.png"), [9]).expect("a file outside the folder");
    env.inbox
        .capture_file(
            outside.clone(),
            "image/png".into(),
            "secret.png".into(),
            1,
            "../secret.png".into(),
            None,
            None,
            None,
        )
        .expect("capture");
    let other_folder = env.inbox.new_id();
    std::fs::create_dir_all(env.dir.join("attachments/inbox/elsewhere")).expect("dir");
    std::fs::write(env.dir.join("attachments/inbox/elsewhere/a.png"), [9]).expect("file");
    env.inbox
        .capture_file(
            other_folder,
            "image/png".into(),
            "a.png".into(),
            1,
            "attachments/inbox/elsewhere/a.png".into(),
            None,
            None,
            None,
        )
        .expect("capture");

    let summary = env
        .sync
        .sync_inbox_attachments(Reachable::Wifi)
        .await
        .expect("pass");

    assert_eq!(summary, Default::default());
    assert_eq!(env.transport.call_count(), 0, "nothing is read or uploaded");
    assert!(env.pending().is_empty());
    assert_eq!(env.attachment_id(&outside), None);
}

#[tokio::test]
async fn a_voice_capture_is_pending_too() {
    let env = env(vec![]);
    let id = env.inbox.new_id();
    env.inbox
        .capture_voice(
            id.clone(),
            3.0,
            "m4a".into(),
            10,
            format!("attachments/inbox/{id}/memo.m4a"),
            vec![],
            None,
            None,
        )
        .expect("capture");
    assert_eq!(env.pending(), vec![id]);
}

#[tokio::test]
async fn a_peers_capture_downloads_into_its_own_folder() {
    let fx = fixture();
    let env = env(download_script(&fx));
    env.peer_capture("attachments/inbox/inbox-1/a.png", ATTACHMENT, 1);

    let summary = env
        .sync
        .sync_inbox_attachments(Reachable::Wifi)
        .await
        .expect("pass");

    assert_eq!(
        (summary.downloaded, summary.deferred, summary.failed),
        (1, 0, 0)
    );
    assert_eq!(
        std::fs::read(env.dir.join("attachments/inbox/inbox-1/a.png")).expect("the file"),
        fx.plaintext
    );
    assert!(
        std::fs::read_dir(env.dir.join("attachments/inbox/inbox-1"))
            .expect("dir")
            .all(|entry| entry.expect("entry").file_name() == "a.png"),
        "no temp file is left behind"
    );
    let calls = env.transport.call_count();
    let again = env
        .sync
        .sync_inbox_attachments(Reachable::Wifi)
        .await
        .expect("pass");
    assert_eq!((again.downloaded, again.deferred, again.failed), (0, 0, 0));
    assert_eq!(env.transport.call_count(), calls, "the file is there now");
}

#[tokio::test]
async fn a_metered_path_defers_the_download() {
    let env = env(vec![]);
    env.peer_capture("attachments/inbox/inbox-1/a.png", ATTACHMENT, 1);

    let summary = env
        .sync
        .sync_inbox_attachments(Reachable::Cellular)
        .await
        .expect("pass");

    assert_eq!((summary.downloaded, summary.deferred), (0, 1));
    assert_eq!(env.transport.call_count(), 0, "no bytes on metered data");
    assert!(!env.dir.join("attachments/inbox/inbox-1/a.png").exists());
}

#[tokio::test]
async fn a_path_outside_the_captures_folder_is_never_written() {
    let env = env(vec![]);
    for (clock, path) in [
        "attachments/inbox/other/a.png",
        "attachments/inbox/inbox-1/../../escape.png",
        "../escape.png",
    ]
    .into_iter()
    .enumerate()
    {
        env.peer_capture(path, ATTACHMENT, clock as u64 + 1);
        let summary = env
            .sync
            .sync_inbox_attachments(Reachable::Wifi)
            .await
            .expect("pass");
        assert_eq!(summary, Default::default(), "{path}");
    }
    assert_eq!(env.transport.call_count(), 0);
    assert!(!env.dir.join("escape.png").exists());
    assert!(!env.dir.join("attachments/inbox/other").exists());
}

#[tokio::test]
async fn a_deleted_captures_chunks_are_dereferenced_after_thirty_days() {
    let mut script = upload_script();
    script.push(response(200, "{}"));
    let env = env(script);
    let id = env.capture("a.png", &[1, 2, 3]);
    env.sync
        .sync_inbox_attachments(Reachable::Wifi)
        .await
        .expect("upload");
    let attachment_id = env.attachment_id(&id).expect("uploaded");
    env.inbox.delete_permanently(id).expect("delete");

    let early = env
        .sync
        .sync_inbox_attachments(Reachable::Wifi)
        .await
        .expect("pass");
    assert_eq!(early.released, 0, "inside the grace");
    assert_eq!(env.transport.calls_to("/dereference").len(), 0);

    backdate_releases(&env);
    let summary = env
        .sync
        .sync_inbox_attachments(Reachable::Wifi)
        .await
        .expect("pass");

    assert_eq!((summary.released, summary.failed), (1, 0));
    let call = env
        .transport
        .calls_to("/dereference")
        .pop()
        .expect("dereferenced");
    let manifest = env
        .vault
        .db_handle()
        .call_blocking(move |conn| memry_core::domain::attachments::get(conn, &attachment_id))
        .expect("row")
        .and_then(|row| row.manifest)
        .expect("cached manifest");
    let manifest: serde_json::Value = serde_json::from_str(&manifest).expect("json");
    let wanted: Vec<_> = manifest["chunks"]
        .as_array()
        .expect("chunks")
        .iter()
        .map(|chunk| chunk["encryptedHash"].clone())
        .collect();
    assert_eq!(body_json(&call)["chunkHashes"], json!(wanted));
    let calls = env.transport.call_count();
    env.sync
        .sync_inbox_attachments(Reachable::Wifi)
        .await
        .expect("pass");
    assert_eq!(env.transport.call_count(), calls, "the release is done");
}

#[tokio::test]
async fn a_release_without_a_cached_manifest_fetches_it_first() {
    let fx = fixture();
    let env = env(vec![
        response(200, &fx.devices_body),
        response(200, &fx.manifest_body),
        response(200, "{}"),
    ]);
    env.vault
        .db_handle()
        .call_blocking(|conn| {
            conn.execute(
                "INSERT INTO inbox_attachment_releases (item_id, attachment_id, deleted_at)
                 VALUES ('gone', ?1, 0)",
                [ATTACHMENT],
            )
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })?;
            Ok(())
        })
        .expect("seed");

    let summary = env
        .sync
        .sync_inbox_attachments(Reachable::Wifi)
        .await
        .expect("pass");

    assert_eq!(summary.released, 1);
    let call = env
        .transport
        .calls_to("/dereference")
        .pop()
        .expect("dereferenced");
    let wanted: Vec<_> = fx
        .chunks
        .iter()
        .map(|c| c.reference.encrypted_hash.clone())
        .collect();
    assert_eq!(body_json(&call)["chunkHashes"], json!(wanted));
}

#[tokio::test]
async fn a_file_a_note_references_is_not_dereferenced() {
    let env = env(upload_script());
    let id = env.capture("a.png", &[1, 2, 3]);
    env.sync
        .sync_inbox_attachments(Reachable::Wifi)
        .await
        .expect("upload");
    let attachment_id = env.attachment_id(&id).expect("uploaded");
    let note = env
        .vault
        .notes_writer(env.store.clone())
        .expect("a writer")
        .create("Filed".to_string(), None)
        .expect("create");
    let referenced = attachment_id.clone();
    env.vault
        .db_handle()
        .call_blocking(move |conn| {
            notes::add_attachment_reference(conn, &note, &referenced, "phone", 1)?;
            Ok(())
        })
        .expect("reference");
    env.inbox.delete_permanently(id).expect("delete");
    backdate_releases(&env);
    let calls = env.transport.call_count();

    let summary = env
        .sync
        .sync_inbox_attachments(Reachable::Wifi)
        .await
        .expect("pass");

    assert_eq!((summary.released, summary.failed), (0, 0));
    assert_eq!(env.transport.call_count(), calls, "the note owns the bytes");
    let left: i64 = env
        .vault
        .db_handle()
        .call_blocking(|conn| {
            Ok(conn
                .query_row(
                    "SELECT count(*) FROM inbox_attachment_releases",
                    [],
                    |row| row.get(0),
                )
                .expect("count"))
        })
        .expect("count");
    assert_eq!(left, 0, "the record is dropped");
}

#[tokio::test]
async fn filing_reuses_a_cached_upload_and_answers_its_manifest_name() {
    let env = env(upload_script());
    let id = env.capture("a.png", &[1, 2, 3]);
    env.sync
        .sync_inbox_attachments(Reachable::Wifi)
        .await
        .expect("upload");
    let attachment_id = env.attachment_id(&id).expect("uploaded");
    let note = env
        .vault
        .notes_writer(env.store.clone())
        .expect("a writer")
        .create("Filed".to_string(), None)
        .expect("create");
    let calls = env.transport.call_count();

    let attached = env
        .sync
        .attach_inbox_file(id, note.clone(), "renamed.png".into(), "image/png".into())
        .await
        .expect("attach");

    assert_eq!(attached.attachment_id, attachment_id);
    assert_eq!(
        attached.filename, "a.png",
        "the manifest's name, not the requested one"
    );
    assert_eq!(env.transport.call_count(), calls, "no second upload");
    let references = env
        .vault
        .db_handle()
        .call_blocking(move |conn| notes::read_attachment_references(conn, &note))
        .expect("references");
    assert_eq!(references, vec![attachment_id]);
}

#[tokio::test]
async fn filing_an_unsynced_capture_uploads_it_into_the_note() {
    let env = env(upload_script());
    let id = env.capture("a.png", &[1, 2, 3]);
    let note = env
        .vault
        .notes_writer(env.store.clone())
        .expect("a writer")
        .create("Filed".to_string(), None)
        .expect("create");

    let attached = env
        .sync
        .attach_inbox_file(
            id.clone(),
            note.clone(),
            "chosen.png".into(),
            "image/png".into(),
        )
        .await
        .expect("attach");

    assert_eq!(attached.filename, "chosen.png");
    let references = env
        .vault
        .db_handle()
        .call_blocking(move |conn| notes::read_attachment_references(conn, &note))
        .expect("references");
    assert_eq!(references, vec![attached.attachment_id]);
    assert!(
        env.pending().is_empty(),
        "the capture does not upload again"
    );
    assert_eq!(env.attachment_id(&id), None);
}
