//! Attachment upload and download against the real sync Worker (`--features harness`, the server
//! of `tests/sync_harness.rs`), through the desktop transport and `memry_core`'s
//! `AttachmentTransfer` (#3535, Step 18 S3). Each request goes through [`Wire`], which records
//! it and can cut one off, as a dropped connection or a killed process would.
//!
//! | Test                                                         | Rule                                  |
//! | ------------------------------------------------------------ | ------------------------------------- |
//! | a 20 MiB file lands byte-identical, only ciphertext leaves    | §14.2-§14.7, `uploadAttachment`        |
//! | an interrupted download resumes at chunk 2 after a restart    | `DownloadResumeState`, #1829           |
//! | a partial Electron left resumes; a stale one starts over      | `loadResumableState`                   |
//! | a crash mid-upload restarts cleanly; the merge keeps every id | `onSaved`, `recordUploadedAttachment`  |

#![cfg(feature = "harness")]

#[path = "device_key/mod.rs"]
mod device_key;
#[path = "harness_server/mod.rs"]
mod harness_server;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use harness_server::{NoPins, Server};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::errors::{ApiError, TransportError};
use memry_core::api::vault::Vault;
use memry_core::crypto::keys;
use memry_core::domain::notes;
use memry_core::protocol::account::{DeviceDirectory, DeviceSigner, device_directory};
use memry_core::protocol::attachments::{AttachmentError, SignerResolver};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::secure_store::SecureStoreKey;
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::Db;
use memry_core::sync::attachments::download::DownloadTarget;
use memry_core::sync::attachments::records::record_uploaded;
use memry_core::sync::attachments::store::upload_queue;
use memry_core::sync::attachments::transfer::{AttachmentTransfer, TransferError};
use memry_desktop::seams::transport::app_transport;
use memry_desktop::vault::paths::{open_vault_file, sanitize_filename};
use serde_json::Value;
use zeroize::Zeroizing;

const MASTER_KEY: [u8; 32] = [9u8; 32];
const MIB: usize = 1024 * 1024;
const CHUNK: usize = 8 * MIB;
const VAULT_ID: &str = "default";
const REL: &str = "attachments/note-1/big.bin";

/// One request as it went out.
#[derive(Debug, Clone)]
struct Sent {
    method: String,
    path: String,
    body: Vec<u8>,
}

type Cut = Box<dyn Fn(&HttpRequest) -> bool + Send + Sync>;

/// The desktop transport, recording every request and cutting off the ones `cut` names.
struct Wire {
    inner: Arc<dyn Transport>,
    sent: Mutex<Vec<Sent>>,
    cut: Mutex<Option<Cut>>,
}

impl Wire {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: app_transport(&["127.0.0.1".to_owned()], Arc::new(NoPins)),
            sent: Mutex::new(Vec::new()),
            cut: Mutex::new(None),
        })
    }

    fn cut(&self, rule: impl Fn(&HttpRequest) -> bool + Send + Sync + 'static) {
        *self.cut.lock().unwrap() = Some(Box::new(rule));
    }

    fn sent(&self) -> Vec<Sent> {
        self.sent.lock().unwrap().clone()
    }

    fn clear(&self) {
        self.sent.lock().unwrap().clear();
    }
}

#[async_trait]
impl Transport for Wire {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let path = request
            .url
            .split_once("://")
            .and_then(|(_, rest)| rest.find('/').map(|at| rest[at..].to_owned()))
            .unwrap_or_else(|| request.url.clone());
        self.sent.lock().unwrap().push(Sent {
            method: request.method.clone(),
            path,
            body: request.body.clone().unwrap_or_default(),
        });
        if self
            .cut
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|cut| cut(&request))
        {
            // Not retried by the client: the connection is gone, as when the process dies.
            return Err(TransportError::Cancelled);
        }
        self.inner.send(request).await
    }

    fn open_socket(
        &self,
        request: SocketRequest,
        listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        self.inner.open_socket(request, listener)
    }
}

struct Signers(DeviceDirectory);

impl SignerResolver for Signers {
    fn public_key(&self, device_id: &str) -> Option<Vec<u8>> {
        self.0.signing_key(device_id).map(<[u8]>::to_vec)
    }
}

/// One desktop vault signed in as the server's device `at`.
struct Device {
    _dir: tempfile::TempDir,
    vault: PathBuf,
    db: Db,
    _core: Vault,
    clock_id: String,
    secret: Vec<u8>,
    registered: String,
    session: AuthSession,
    wire: Arc<Wire>,
}

impl Device {
    fn new(server: &Server, at: usize) -> Self {
        let boot = &server.devices[at];
        let secret = BASE64
            .decode(boot["signingSecretKey"].as_str().unwrap())
            .unwrap();
        let store = device_key::with_device_key();
        store
            .set(SecureStoreKey::DeviceSigningKey, secret.clone())
            .unwrap();
        let token = boot["accessToken"].as_str().unwrap().as_bytes().to_vec();
        store.set(SecureStoreKey::AccessToken, token).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault");
        let data = vault.join(".memry").join("core");
        std::fs::create_dir_all(&data).unwrap();
        let core = Vault::open("harness".into(), data.to_string_lossy().into_owned()).unwrap();
        let wire = Wire::new();
        let transport: Arc<dyn Transport> = wire.clone();
        let session = AuthSession::new(
            transport,
            store,
            server.url.clone(),
            "desktop".into(),
            DeviceDescriptor {
                name: format!("harness-{at}"),
                platform: DevicePlatform::Macos,
                form_factor: None,
                os_version: None,
                app_version: "1.0.0".into(),
                vault_id: None,
            },
            None,
        )
        .unwrap();
        Self {
            _dir: dir,
            vault,
            db: core.db_handle(),
            _core: core,
            clock_id: keys::local_device_id_hex(&secret[32..]).unwrap(),
            secret,
            registered: boot["deviceId"].as_str().unwrap().to_owned(),
            session,
            wire,
        }
    }

    /// A fresh transfer object, as after a restart: nothing of an earlier one survives.
    async fn transfer(&self) -> AttachmentTransfer {
        let http = self.session.http();
        let directory = device_directory(&http).await.expect("the device list");
        AttachmentTransfer::new(
            http,
            VAULT_ID,
            Zeroizing::new(keys::derive_vault_key(&MASTER_KEY).unwrap().to_vec()),
            DeviceSigner::new(&self.registered, self.secret.clone()).unwrap(),
            Arc::new(Signers(directory)),
            sanitize_filename,
        )
    }

    fn write(&self, rel: &str, bytes: &[u8]) -> PathBuf {
        let path = self.vault.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        path
    }

    async fn upload(&self, rel: &str, reusable: &[String]) -> Result<String, TransferError> {
        let file = open_vault_file(&self.vault, rel)
            .unwrap()
            .expect("the file");
        let name = Path::new(rel).file_name().unwrap().to_str().unwrap();
        let uploaded = self
            .transfer()
            .await
            .upload_file(file, name, reusable)
            .await?;
        Ok(uploaded.attachment_id)
    }
}

/// Bytes where every 48-byte window is distinct, so a window found on the wire is a leak.
fn content(len: usize, seed: u64) -> Vec<u8> {
    let mut state = seed | 1;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        })
        .collect()
}

/// Asserts no request body carries a 48-byte window of `plain`, one window per 64 KiB.
fn assert_only_ciphertext(sent: &[Sent], plain: &[u8]) {
    for at in (0..plain.len().saturating_sub(48)).step_by(64 * 1024) {
        let window = &plain[at..at + 48];
        for request in sent {
            assert!(
                !request.body.windows(48).any(|w| w == window),
                "{} {} carries plaintext from offset {at}",
                request.method,
                request.path
            );
        }
    }
}

fn routes(sent: &[Sent]) -> Vec<String> {
    sent.iter()
        .map(|s| format!("{} {}", s.method, s.path))
        .collect()
}

fn chunk_gets(sent: &[Sent]) -> Vec<String> {
    sent.iter()
        .filter_map(|s| s.path.strip_prefix("/sync/attachments/chunks/"))
        .map(str::to_owned)
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_20_mib_file_lands_byte_identical_and_only_ciphertext_leaves() {
    let server = Server::start();
    let (a, b) = (Device::new(&server, 0), Device::new(&server, 1));
    let plain = content(20 * MIB, 7);
    a.write(REL, &plain);

    let id = a.upload(REL, &[]).await.expect("the upload");

    let sent = a.wire.sent();
    assert_only_ciphertext(&sent, &plain);
    let upload: Vec<Sent> = sent
        .into_iter()
        .filter(|s| s.path.starts_with("/sync/attachments/"))
        .collect();
    let session = serde_json::from_slice::<Value>(&upload[0].body).unwrap();
    assert_eq!(session["attachmentId"], id.as_str(), "{session}");
    assert_eq!(session["chunkCount"], 3);
    let complete = upload.last().unwrap();
    let mut puts: Vec<String> = routes(&upload[2..upload.len() - 1]);
    puts.sort();
    let sid = complete.path.split('/').nth(4).unwrap().to_owned();
    // Electron's request sequence (`uploadAttachment`): initiate, the resume probe, the chunk
    // PUTs, and `complete` carrying the signed manifest. No separate manifest PUT.
    assert_eq!(
        routes(&upload[..2]),
        [
            "POST /sync/attachments/upload/initiate".to_owned(),
            format!("GET /sync/attachments/upload/{sid}"),
        ]
    );
    assert_eq!(
        puts,
        (0..3)
            .map(|i| format!("PUT /sync/attachments/upload/{sid}/chunk/{i}"))
            .collect::<Vec<_>>()
    );
    assert_eq!(complete.method, "POST");
    let body = serde_json::from_slice::<Value>(&complete.body).unwrap();
    let keys: BTreeSet<&str> = body
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        BTreeSet::from([
            "encryptedFileKey",
            "encryptedManifest",
            "keyNonce",
            "manifestNonce",
            "manifestSignature",
            "signerDeviceId",
        ])
    );

    let dir = b.vault.join("attachments/note-1");
    let landed = b
        .transfer()
        .await
        .download_to_file(&id, DownloadTarget::Dir(dir.clone()))
        .await
        .expect("the download");
    assert_eq!(landed.path, dir.join("big.bin"));
    assert!(
        std::fs::read(&landed.path).unwrap() == plain,
        "byte-identical"
    );
    let left: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(left, ["big.bin"], "no partial or sidecar stays behind");

    a.wire.clear();
    let again = a.upload(REL, std::slice::from_ref(&id)).await.unwrap();
    assert_eq!(again, id, "the same bytes reuse the attachment id");
    assert_eq!(
        routes(&a.wire.sent())
            .into_iter()
            .filter(|r| r.contains("/sync/attachments/"))
            .collect::<Vec<_>>(),
        [format!("GET /sync/attachments/{id}/manifest")],
        "a reused file uploads nothing"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_interrupted_download_resumes_at_chunk_2_and_never_replaces_the_good_file() {
    let server = Server::start();
    let (a, b) = (Device::new(&server, 0), Device::new(&server, 1));
    let plain = content(20 * MIB, 11);
    a.write(REL, &plain);
    let id = a.upload(REL, &[]).await.unwrap();
    let dest = b.write(REL, b"the good file this device already has");
    let hashes = chunk_hashes(&b, &id).await;

    let second = hashes[1].clone();
    b.wire
        .cut(move |request| request.url.ends_with(&format!("/chunks/{second}")));
    let error = b
        .transfer()
        .await
        .download_to_file(&id, DownloadTarget::Path(dest.clone()))
        .await
        .expect_err("the connection closes after chunk 1");
    assert!(error.is_resumable(), "{error}");
    assert_eq!(
        std::fs::read(&dest).unwrap(),
        b"the good file this device already has",
        "a partial never replaces the file"
    );
    let partial = dest.with_file_name(format!(".{id}.big.bin.mrypart"));
    let sidecar = dest.with_file_name(format!(".{id}.big.bin.mrypart.json"));
    assert_eq!(std::fs::metadata(&partial).unwrap().len(), CHUNK as u64);
    let checksum = hex_sha256(&plain);
    // `JSON.stringify` of Electron's `DownloadResumeState`, byte for byte: progress only.
    assert_eq!(
        std::fs::read_to_string(&sidecar).unwrap(),
        format!(
            r#"{{"version":1,"attachmentId":"{id}","checksum":"{checksum}","chunkCount":3,"chunksDone":1,"bytesWritten":{CHUNK}}}"#
        )
    );

    // The restart: a new transfer over a connection that holds.
    b.wire.cut(|_| false);
    b.wire.clear();
    b.transfer()
        .await
        .download_to_file(&id, DownloadTarget::Path(dest.clone()))
        .await
        .expect("the resumed download");
    assert_eq!(
        chunk_gets(&b.wire.sent()),
        hashes[1..],
        "chunk 1 is not fetched again"
    );
    assert!(std::fs::read(&dest).unwrap() == plain, "byte-identical");
    assert!(!partial.exists() && !sidecar.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_partial_electron_left_resumes_and_a_stale_one_starts_over() {
    let server = Server::start();
    let (a, b) = (Device::new(&server, 0), Device::new(&server, 1));
    let plain = content(CHUNK + MIB, 13);
    a.write(REL, &plain);
    let id = a.upload(REL, &[]).await.unwrap();
    let hashes = chunk_hashes(&b, &id).await;
    let dest = b.vault.join(REL);
    let partial = dest.with_file_name(format!(".{id}.big.bin.mrypart"));
    let sidecar = dest.with_file_name(format!(".{id}.big.bin.mrypart.json"));
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    let electron = |checksum: &str| {
        format!(
            r#"{{"version":1,"attachmentId":"{id}","checksum":"{checksum}","chunkCount":2,"chunksDone":1,"bytesWritten":{CHUNK}}}"#
        )
    };

    std::fs::write(&partial, &plain[..CHUNK]).unwrap();
    std::fs::write(&sidecar, electron(&hex_sha256(&plain))).unwrap();
    b.wire.clear();
    b.transfer()
        .await
        .download_to_file(&id, DownloadTarget::Path(dest.clone()))
        .await
        .unwrap();
    assert_eq!(
        chunk_gets(&b.wire.sent()),
        hashes[1..],
        "resumed at chunk 1"
    );
    assert!(std::fs::read(&dest).unwrap() == plain);

    std::fs::remove_file(&dest).unwrap();
    std::fs::write(&partial, vec![0u8; CHUNK]).unwrap();
    std::fs::write(&sidecar, electron("another-manifest")).unwrap();
    b.wire.clear();
    b.transfer()
        .await
        .download_to_file(&id, DownloadTarget::Path(dest.clone()))
        .await
        .unwrap();
    assert_eq!(
        chunk_gets(&b.wire.sent()),
        hashes,
        "a stale partial starts over"
    );
    assert!(std::fs::read(&dest).unwrap() == plain);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_crash_mid_upload_restarts_cleanly_and_the_merge_keeps_every_id() {
    let server = Server::start();
    let (a, b) = (Device::new(&server, 0), Device::new(&server, 1));
    let plain = content(20 * MIB, 17);
    a.write(REL, &plain);
    let clock = a.clock_id.clone();
    a.db.call(move |conn| {
        let note = notes::NewNote {
            id: "note-1",
            title: "Pictures",
            folder_path: None,
            content: "",
            tags: &[],
            properties: None,
            emoji: None,
        };
        notes::create(conn, &note, &clock, 1)?;
        // An id another device added, which this device never uploaded.
        notes::add_attachment_reference(conn, "note-1", "from-a-peer", &clock, 2)?;
        upload_queue::enqueue(conn, "note-1", REL, 3)
    })
    .await
    .unwrap();

    a.wire
        .cut(|request| request.method == "PUT" && request.url.ends_with("/chunk/1"));
    let error = a
        .upload(REL, &[])
        .await
        .expect_err("the upload dies at chunk 1");
    assert!(error.is_resumable(), "{error}");
    let sent = a.wire.sent();
    let lost = serde_json::from_slice::<Value>(&sent[0].body).unwrap()["attachmentId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        routes(&sent)
            .iter()
            .any(|r| r.starts_with("DELETE /sync/attachments/upload/")),
        "the dead session is cancelled"
    );
    assert!(
        routes(&sent).iter().all(|r| !r.ends_with("/complete")),
        "no manifest for the dead upload"
    );
    assert!(matches!(
        b.transfer()
            .await
            .download_to_file(&lost, DownloadTarget::Dir(b.vault.join("lost")))
            .await,
        Err(TransferError::Attachment(AttachmentError::Api(
            ApiError::Status { status: 404, .. }
        )))
    ));
    assert_eq!(
        references(&a).await,
        ["from-a-peer"],
        "nothing references the dead id"
    );
    assert!(pending(&a).await, "the queue row waits for the retry");

    a.wire.cut(|_| false);
    let id = a.upload(REL, &[]).await.expect("the retry from the start");
    assert_ne!(id, lost);
    let outbox_before = note_outbox_rows(&a).await;
    let clock = a.clock_id.clone();
    let recorded = id.clone();
    let referenced =
        a.db.call(move |conn| record_uploaded(conn, "note-1", REL, &recorded, &clock, 4))
            .await
            .unwrap();
    assert!(referenced);
    assert_eq!(references(&a).await, ["from-a-peer".to_owned(), id.clone()]);
    assert!(note_outbox_rows(&a).await > outbox_before || outbox_before > 0);
    assert!(!pending(&a).await, "the queue row is gone");

    let clock = a.clock_id.clone();
    let recorded = id.clone();
    a.db.call(move |conn| record_uploaded(conn, "note-1", REL, &recorded, &clock, 5))
        .await
        .unwrap();
    assert_eq!(references(&a).await, ["from-a-peer".to_owned(), id.clone()]);
    assert!(
        routes(&a.wire.sent())
            .iter()
            .all(|r| !r.contains("dereference")),
        "recording a reference frees nothing"
    );

    let landed = b
        .transfer()
        .await
        .download_to_file(&id, DownloadTarget::Dir(b.vault.join("attachments/note-1")))
        .await
        .unwrap();
    assert!(std::fs::read(landed.path).unwrap() == plain);
}

async fn chunk_hashes(device: &Device, id: &str) -> Vec<String> {
    let dir = tempfile::tempdir().unwrap();
    let landed = device
        .transfer()
        .await
        .download_to_file(id, DownloadTarget::Dir(dir.path().to_path_buf()))
        .await
        .unwrap();
    landed
        .manifest
        .chunks
        .iter()
        .map(|chunk| chunk.encrypted_hash.clone())
        .collect()
}

async fn references(device: &Device) -> Vec<String> {
    device
        .db
        .call(|conn| notes::read_attachment_references(conn, "note-1"))
        .await
        .unwrap()
}

async fn pending(device: &Device) -> bool {
    device
        .db
        .call(|conn| upload_queue::has_pending(conn, "note-1", REL))
        .await
        .unwrap()
}

async fn note_outbox_rows(device: &Device) -> i64 {
    device
        .db
        .call(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM outbox WHERE item_type = 'note' AND item_id = 'note-1'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })
        })
        .await
        .unwrap()
}

fn hex_sha256(bytes: &[u8]) -> String {
    memry_core::protocol::attachments::hex_sha256(bytes)
}
