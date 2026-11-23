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
use memry_core::api::sync::{AttachmentRefusal, QueuedAttachmentNews, VaultSync};
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::domain::attachments::{self, BlockAttachment};
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
    launch_over(dir, store, FakeTransport::new(script))
}

fn launch_over(dir: &Path, store: &Arc<FakeSecureStore>, transport: Arc<FakeTransport>) -> Launch {
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
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
    // Below zero, so even a row with no known size would be evicted.
    let evicted = app
        .vault
        .db_handle()
        .call_blocking(|conn| attachments::evict_to_budget(conn, -1))
        .expect("evict");
    assert!(evicted.paths.is_empty(), "the only copy is never evicted");
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
        app.sync
            .upload_queued_attachments()
            .await
            .expect("drain")
            .uploaded,
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
        app.sync
            .upload_queued_attachments()
            .await
            .expect("again")
            .uploaded,
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
        app.sync
            .upload_queued_attachments()
            .await
            .expect("drain")
            .uploaded,
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
        app.sync
            .upload_queued_attachments()
            .await
            .expect("drain")
            .uploaded,
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
        app.sync
            .upload_queued_attachments()
            .await
            .expect("drain")
            .uploaded,
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

    let mut script = pass_head();
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

fn pass_head() -> Vec<Scripted> {
    let (public, _secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    vec![
        response(
            200,
            &json!({"devices": [{"id": DEVICE, "signingPublicKey": BASE64.encode(&public)}]})
                .to_string(),
        ),
        response(
            200,
            &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": null}).to_string(),
        ),
    ]
}

/// A refusal on a later pass keeps the picture: the bytes are the only copy,
/// so the row stays owed, the block stays bound and the pass reports it.
#[tokio::test]
async fn a_later_refusal_keeps_the_upload_owed_and_the_bytes_bound() {
    let (dir, store) = (scratch_dir(), store());
    let (note, id) = {
        let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
        let note = app.note(&store);
        let id = app.attach(&note).await.expect("kept for later");
        (note, id)
    };

    let mut script = pass_head();
    script.push(error_response(413, "STORAGE_QUOTA_EXCEEDED", "over quota"));
    script.push(response(
        200,
        &json!({"accepted": [note], "rejected": [], "serverTime": 1, "maxCursor": 1}).to_string(),
    ));
    script.push(error_response(413, "STORAGE_QUOTA_EXCEEDED", "over quota"));
    let app = launch(&dir, &store, script);

    let pass = app.sync.sync_now().await.expect("the pass");

    match app.block(&note) {
        BlockAttachment::Bound { attachment } => assert_eq!(attachment.attachment_id, id),
        other => panic!("a refused upload must keep its block, got {other:?}"),
    }
    let evicted = app
        .vault
        .db_handle()
        .call_blocking(|conn| attachments::evict_to_budget(conn, -1))
        .expect("evict");
    assert!(evicted.paths.is_empty(), "the only copy is never evicted");
    assert_eq!(
        std::fs::read(dir.join("images").join(&id)).expect("the bytes"),
        BYTES
    );
    assert!(pass.rejected > 0, "the refusal is visible: {pass:?}");
    let drain = app.sync.upload_queued_attachments().await.expect("drain");
    assert_eq!((drain.uploaded, drain.refused), (0, 1), "still owed");
}

/// A detach that lands while the bytes are going up wins: the note never
/// gains the reference back and the uploaded chunks are released.
#[tokio::test]
async fn a_detach_during_the_upload_leaves_no_reference_and_releases_the_chunks() {
    let (dir, store) = (scratch_dir(), store());
    let (note, id) = {
        let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
        let note = app.note(&store);
        let id = app.attach(&note).await.expect("kept for later");
        (note, id)
    };

    let mut script = upload_script();
    script.push(response(200, &json!({"success": true}).to_string()));
    let app = launch_over(&dir, &store, FakeTransport::slow(script, 50));

    let sync = Arc::clone(&app.sync);
    let drain = tokio::spawn(async move { sync.upload_queued_attachments().await });
    // Wait until the upload is on the wire, then detach under it.
    while app.transport.call_count() < 2 {
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    app.sync
        .detach_attachment(note.clone(), id.clone())
        .await
        .expect("detach");
    let drained = drain.await.expect("join").expect("drain");

    assert_eq!(drained.uploaded, 0, "nothing was referenced");
    assert_eq!(app.manifest_ids(), vec![id], "the upload itself finished");
    assert!(app.references(&note).is_empty(), "no reference to push");
    assert_eq!(
        app.transport
            .calls_to("/sync/attachments/dereference")
            .len(),
        1,
        "the orphaned chunks go back"
    );
}

fn chunk_hashes(initiate: &memry_core::seams::transport::HttpRequest) -> Vec<String> {
    serde_json::from_value(body_json(initiate)["chunkHashes"].clone()).expect("chunk hashes")
}

/// A crash between the manifest PUT and the transaction that references it
/// (#5533). The next pass uploads again under the same id, and the first
/// upload's chunks, which nothing will ever reference, go back exactly once.
/// The chunks the note references are never released.
#[tokio::test]
async fn a_crash_after_the_manifest_put_releases_the_first_upload_once() {
    let (dir, store) = (scratch_dir(), store());
    let (note, id) = {
        let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
        let note = app.note(&store);
        let id = app.attach(&note).await.expect("kept for later");
        (note, id)
    };

    let first = {
        let app = launch_over(&dir, &store, FakeTransport::slow(upload_script(), 50));
        let sync = Arc::clone(&app.sync);
        let drain = tokio::spawn(async move { sync.upload_queued_attachments().await });
        // The process dies while the manifest PUT is on the wire: the server
        // has the manifest and the chunks, this device recorded nothing after.
        while app.manifest_ids().is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        drain.abort();
        assert!(drain.await.expect_err("killed").is_cancelled());
        assert!(app.references(&note).is_empty(), "never referenced");
        chunk_hashes(&app.transport.calls_to("/upload/initiate")[0])
    };

    let mut script = vec![response(200, &json!({"dereferenced": 1}).to_string())];
    script.extend(upload_script());
    let app = launch(&dir, &store, script);
    let drained = app.sync.upload_queued_attachments().await.expect("drain");

    assert_eq!(drained.uploaded, 1);
    assert_eq!(app.manifest_ids(), vec![id.clone()], "the same id again");
    assert_eq!(app.references(&note), vec![id]);
    let second = chunk_hashes(&app.transport.calls_to("/upload/initiate")[0]);
    let released = app.transport.calls_to("/sync/attachments/dereference");
    assert_eq!(released.len(), 1, "the first set goes back once");
    assert_eq!(body_json(&released[0])["chunkHashes"], json!(first));
    assert!(
        second.iter().all(|hash| !first.contains(hash)),
        "the referenced upload shares no chunk with the released one"
    );

    let calls = app.transport.call_count();
    app.sync.upload_queued_attachments().await.expect("again");
    assert_eq!(app.transport.call_count(), calls, "nothing released twice");
}

/// A crash after the chunks went up, then a detach before the next pass: no
/// upload is owed any more, and the chunks still go back.
#[tokio::test]
async fn a_detach_after_a_crashed_upload_still_releases_its_chunks() {
    let (dir, store) = (scratch_dir(), store());
    let (note, id) = {
        let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
        let note = app.note(&store);
        let id = app.attach(&note).await.expect("kept for later");
        (note, id)
    };
    let first = {
        let app = launch_over(&dir, &store, FakeTransport::slow(upload_script(), 50));
        let sync = Arc::clone(&app.sync);
        let drain = tokio::spawn(async move { sync.upload_queued_attachments().await });
        while app.manifest_ids().is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        drain.abort();
        let _ = drain.await;
        chunk_hashes(&app.transport.calls_to("/upload/initiate")[0])
    };

    let app = launch(
        &dir,
        &store,
        vec![response(200, &json!({"dereferenced": 1}).to_string())],
    );
    app.sync
        .detach_attachment(note.clone(), id)
        .await
        .expect("detach");
    app.sync.upload_queued_attachments().await.expect("drain");

    let released = app.transport.calls_to("/sync/attachments/dereference");
    assert_eq!(released.len(), 1);
    assert_eq!(body_json(&released[0])["chunkHashes"], json!(first));
    assert!(app.transport.calls_to("/upload/initiate").is_empty());
}

/// A year, far past the 30-day grace #5573 gave a purged note's picture.
const A_YEAR_MS: i64 = 365 * 24 * 60 * 60 * 1000;

/// Dates the purge of `id`'s note a year back under the key a #5573 or #5604
/// build wrote (`attachment_upload.purged_at:<id>`), as if one ran the
/// pulled delete before this build.
fn plant_an_old_purge(app: &Launch, id: &str) {
    let key = format!("attachment_upload.purged_at:{id}");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("after 1970")
        .as_millis() as i64;
    app.vault
        .db_handle()
        .call_blocking(move |conn| {
            conn.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
                rusqlite::params![key, (now - A_YEAR_MS).to_string()],
            )
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })
        })
        .expect("plant the purge");
}

fn purge_dates(app: &Launch, id: &str) -> i64 {
    count(
        app,
        "SELECT COUNT(*) FROM meta WHERE key = 'attachment_upload.purged_at:' || ?1",
        id,
    )
}

fn count(app: &Launch, sql: &'static str, id: &str) -> i64 {
    let id = id.to_owned();
    app.vault
        .db_handle()
        .call_blocking(move |conn| {
            conn.query_row(sql, [&id], |row| row.get::<_, i64>(0))
                .map_err(|error| memry_core::api::errors::StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .expect("count")
}

fn owed(app: &Launch, id: &str) -> i64 {
    count(
        app,
        "SELECT COUNT(*) FROM note_attachment_uploads WHERE attachment_id = ?1",
        id,
    )
}

fn attachment_rows(app: &Launch, id: &str) -> i64 {
    count(
        app,
        "SELECT COUNT(*) FROM attachments WHERE attachment_id = ?1",
        id,
    )
}

/// Another device's delete, pulled here, purges the note's body. A note can
/// come back under its id at any age (§5.12.3: the server keeps its row, and a
/// create over the marker is accepted), and these bytes are the only copy, so
/// they, the row and the owed upload stay however long the note stays gone.
#[tokio::test]
async fn a_purged_notes_picture_is_kept_however_long_the_note_stays_gone() {
    let (dir, store) = (scratch_dir(), store());
    let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
    let note = app.note(&store);
    let id = app.attach(&note).await.expect("kept for later");

    deliver_a_delete(&app.vault.db_handle(), &note).await;
    plant_an_old_purge(&app, &id);
    let drained = app
        .sync
        .upload_queued_attachments()
        .await
        .expect("drain a year after the purge");

    assert_eq!(drained, Default::default());
    assert_eq!(app.transport.call_count(), 1, "nothing went up");
    assert_eq!(
        std::fs::read(dir.join("images").join(&id)).expect("the bytes stay"),
        BYTES
    );
    assert_eq!(attachment_rows(&app, &id), 1, "the row stays");
    assert_eq!(owed(&app, &id), 1, "the upload stays owed");
}

/// A pulled delete dates nothing for a downgrade to act on: a #5573 build
/// discards an owed upload 30 days after its `attachment_upload.purged_at`
/// date, and these bytes are the only copy.
#[tokio::test]
async fn a_pulled_delete_leaves_no_purge_date_an_older_build_would_discard_by() {
    let (dir, store) = (scratch_dir(), store());
    let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
    let note = app.note(&store);
    let id = app.attach(&note).await.expect("kept for later");

    deliver_a_delete(&app.vault.db_handle(), &note).await;

    assert_eq!(purge_dates(&app, &id), 0);
    assert_eq!(owed(&app, &id), 1, "the upload stays owed");
}

/// A purged note that another device revives under the same id (§14.8.2),
/// even long after the purge, gets its picture back: the next pass uploads
/// the kept bytes once, under the attachment's id, and references it.
#[tokio::test]
async fn a_note_revived_long_after_its_purge_uploads_its_kept_picture_once() {
    let (dir, store) = (scratch_dir(), store());
    let (note, id) = {
        let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
        let note = app.note(&store);
        let id = app.attach(&note).await.expect("kept for later");
        deliver_a_delete(&app.vault.db_handle(), &note).await;
        plant_an_old_purge(&app, &id);
        app.sync.upload_queued_attachments().await.expect("drain");
        assert_eq!(
            app.transport.call_count(),
            1,
            "a purged note uploads nothing"
        );
        deliver_a_revive(&app.vault.db_handle(), &note).await;
        (note, id)
    };

    let app = launch(&dir, &store, upload_script());
    let drained = app.sync.upload_queued_attachments().await.expect("drain");

    assert_eq!(drained.uploaded, 1);
    assert_eq!(app.manifest_ids(), vec![id.clone()]);
    assert_eq!(app.references(&note), vec![id.clone()]);
    let initiate = body_json(&app.transport.calls_to("/upload/initiate")[0]);
    assert_eq!(initiate["attachmentId"], json!(id));
    assert_eq!(initiate["totalSize"], json!(BYTES.len()), "{initiate}");
    assert_eq!(
        std::fs::read(dir.join("images").join(&id)).expect("the bytes"),
        BYTES
    );
    assert_eq!(owed(&app, &id), 0);
    assert_eq!(
        purge_dates(&app, &id),
        0,
        "the old date goes with the upload"
    );

    let calls = app.transport.call_count();
    app.sync.upload_queued_attachments().await.expect("again");
    assert_eq!(app.transport.call_count(), calls, "uploaded once");
    assert_eq!(attachment_rows(&app, &id), 1, "a referenced picture stays");
}

/// A recorded chunk set that will not parse is logged and skipped: it never
/// blocks another attachment's upload.
#[tokio::test]
async fn an_unreadable_chunk_set_does_not_block_another_upload() {
    let (dir, store) = (scratch_dir(), store());
    let (note, id) = {
        let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
        let note = app.note(&store);
        let id = app.attach(&note).await.expect("kept for later");
        app.vault
            .db_handle()
            .call_blocking(|conn| {
                conn.execute(
                    "INSERT INTO meta (key, value) VALUES ('attachment_upload.chunks:elsewhere', 'not json')",
                    [],
                )
                .map_err(|error| memry_core::api::errors::StorageError::Failed {
                    what: error.to_string(),
                })
            })
            .expect("plant");
        (note, id)
    };

    let app = launch(&dir, &store, upload_script());
    let drained = app.sync.upload_queued_attachments().await.expect("drain");

    assert_eq!(drained.uploaded, 1);
    assert_eq!(app.references(&note), vec![id]);
}

/// A note deleted on this device only, with its body still here, keeps its
/// picture owed: the delete can still be undone.
#[tokio::test]
async fn a_deleted_note_whose_body_is_kept_keeps_its_owed_upload() {
    let (dir, store) = (scratch_dir(), store());
    let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
    let note = app.note(&store);
    let id = app.attach(&note).await.expect("kept for later");

    app.vault
        .notes_writer(store.clone())
        .expect("a writer")
        .delete(note.clone())
        .expect("delete");
    let drained = app.sync.upload_queued_attachments().await.expect("drain");

    assert_eq!(drained, Default::default());
    assert_eq!(
        app.transport.call_count(),
        1,
        "a deleted note uploads nothing"
    );
    assert_eq!(owed(&app, &id), 1, "still owed");
    assert_eq!(
        std::fs::read(dir.join("images").join(&id)).expect("the bytes"),
        BYTES
    );
}

/// One real pull page carrying another device's delete of the note, which
/// applies the tombstone and purges the body (§7.15).
async fn deliver_a_delete(db: &memry_core::storage::Db, note_id: &str) {
    use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
    use memry_core::protocol::http::{ClientIdentity, HttpClient};
    use memry_core::protocol::types::Declaration;
    use memry_core::sync::pull::{PullLoop, RecordCipher};

    struct OpensDeletes;
    impl RecordCipher for OpensDeletes {
        fn open(&self, _envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
            Ok(Vec::new())
        }
    }

    let tombstone = json!({
        "id": note_id,
        "type": "note",
        "operation": "update",
        "clientUpdatedAt": 5,
        "encryptedKey": "AAAA",
        "keyNonce": "AAAA",
        "encryptedData": "AAAA",
        "dataNonce": "AAAA",
        "signature": "AAAA",
        "signerDeviceId": "device-desktop",
        "deletedAt": 5,
    });
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"items": [{"id": note_id, "type": "note"}], "deleted": [], "hasMore": false, "nextCursor": "9"})
                .to_string(),
        ),
        response(200, &json!({ "items": [tombstone] }).to_string()),
    ]);
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    let report = PullLoop::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(OpensDeletes),
    )
    .with_clock_device(DEVICE)
    .pull_page()
    .await
    .expect("the page");
    assert!(!report.refused);
    assert_eq!(report.deleted, 1, "{report:?}");
}

/// One real pull page carrying another device's live copy of the note, which
/// revives it under the same id (§14.8.2).
async fn deliver_a_revive(db: &memry_core::storage::Db, note_id: &str) {
    use memry_core::protocol::envelope::{EnvelopeError, RecordEnvelope};
    use memry_core::protocol::http::{ClientIdentity, HttpClient};
    use memry_core::protocol::types::Declaration;
    use memry_core::sync::pull::{PullLoop, RecordCipher};

    struct OpensTheNote;
    impl RecordCipher for OpensTheNote {
        fn open(&self, _envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
            // Its clock has seen everything this device wrote.
            Ok(
                json!({"title": "Back", "clock": {DEVICE: 1_000, "device-desktop": 3}})
                    .to_string()
                    .into_bytes(),
            )
        }
    }

    let item = json!({
        "id": note_id,
        "type": "note",
        "operation": "update",
        "clientUpdatedAt": 9,
        "encryptedKey": "AAAA",
        "keyNonce": "AAAA",
        "encryptedData": "AAAA",
        "dataNonce": "AAAA",
        "signature": "AAAA",
        "signerDeviceId": "device-desktop",
    });
    let transport = FakeTransport::new(vec![
        response(
            200,
            &json!({"items": [{"id": note_id, "type": "note"}], "deleted": [], "hasMore": false, "nextCursor": "10"})
                .to_string(),
        ),
        response(200, &json!({ "items": [item] }).to_string()),
    ]);
    let http = HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    );
    let report = PullLoop::new(
        Arc::new(http),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(OpensTheNote),
    )
    .with_clock_device(DEVICE)
    .pull_page()
    .await
    .expect("the page");
    assert!(!report.refused, "{report:?}");
    let note = note_id.to_owned();
    let live = db
        .call_blocking(move |conn| {
            memry_core::domain::attachment_uploads::note_is_live(conn, &note)
        })
        .expect("read");
    assert!(live, "revived: {report:?}");
}

/// A detach while the bytes go up, and the dereference that follows fails:
/// the chunks stay recorded and the next pass releases them, once.
#[tokio::test]
async fn a_failed_release_after_a_detach_is_retried_by_the_next_pass() {
    let (dir, store) = (scratch_dir(), store());
    let (note, id) = {
        let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
        let note = app.note(&store);
        let id = app.attach(&note).await.expect("kept for later");
        (note, id)
    };

    let mut script = upload_script();
    script.push(error_response(429, "RATE_LIMITED", "slow down"));
    let uploaded = {
        let app = launch_over(&dir, &store, FakeTransport::slow(script, 50));
        let sync = Arc::clone(&app.sync);
        let drain = tokio::spawn(async move { sync.upload_queued_attachments().await });
        while app.transport.call_count() < 2 {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        app.sync
            .detach_attachment(note.clone(), id.clone())
            .await
            .expect("detach");
        drain
            .await
            .expect("join")
            .expect("the walk ends, it does not fail");
        assert_eq!(
            app.transport
                .calls_to("/sync/attachments/dereference")
                .len(),
            1
        );
        chunk_hashes(&app.transport.calls_to("/upload/initiate")[0])
    };

    let app = launch(
        &dir,
        &store,
        vec![response(200, &json!({"dereferenced": 1}).to_string())],
    );
    app.sync.upload_queued_attachments().await.expect("drain");
    let released = app.transport.calls_to("/sync/attachments/dereference");
    assert_eq!(released.len(), 1, "released on the next pass");
    assert_eq!(body_json(&released[0])["chunkHashes"], json!(uploaded));
    assert!(app.references(&note).is_empty());

    let calls = app.transport.call_count();
    app.sync.upload_queued_attachments().await.expect("again");
    assert_eq!(app.transport.call_count(), calls, "released once");
}

/// The kept bytes are the only copy: the upload reads them and never writes
/// them. A read-only file with a pinned mtime uploads, and comes out as it went in.
#[cfg(unix)]
#[tokio::test]
async fn a_queued_upload_never_writes_the_kept_bytes() {
    use std::os::unix::fs::PermissionsExt as _;

    let (dir, store) = (scratch_dir(), store());
    let (note, id) = {
        let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
        let note = app.note(&store);
        let id = app.attach(&note).await.expect("kept for later");
        (note, id)
    };
    let path = dir.join("images").join(&id);
    let pinned = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .and_then(|file| file.set_modified(pinned))
        .expect("pin the mtime");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).expect("read-only");

    let app = launch(&dir, &store, upload_script());
    let drained = app.sync.upload_queued_attachments().await.expect("drain");

    assert_eq!(drained.uploaded, 1);
    assert_eq!(app.references(&note), vec![id]);
    let after = std::fs::metadata(&path).expect("still there");
    assert_eq!(after.modified().expect("mtime"), pinned, "never rewritten");
    assert_eq!(after.permissions().mode() & 0o777, 0o444);
    assert_eq!(std::fs::read(&path).expect("the bytes"), BYTES);
}

/// #5532: a refusal on a later pass reaches the shell once, naming the note
/// and the reason, not on every pass that retries it, nor again after a
/// relaunch. The upload that later lands is told too, so the shell can take
/// its alert back.
#[tokio::test]
async fn a_later_refusal_is_told_once_and_its_later_upload_is_told_too() {
    let (dir, store) = (scratch_dir(), store());
    let (note, id) = {
        let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
        let note = app.note(&store);
        let id = app.attach(&note).await.expect("kept for later");
        (note, id)
    };
    let refused = QueuedAttachmentNews::Refused {
        attachment_id: id.clone(),
        note_id: note.clone(),
        note_title: "Offline".to_owned(),
        refusal: AttachmentRefusal::StorageFull,
        status: 413,
    };

    let mut script = pass_head();
    script.push(error_response(413, "STORAGE_QUOTA_EXCEEDED", "over quota"));
    script.push(response(
        200,
        &json!({"accepted": [note], "rejected": [], "serverTime": 1, "maxCursor": 1}).to_string(),
    ));
    script.push(error_response(413, "STORAGE_QUOTA_EXCEEDED", "over quota"));
    let app = launch(&dir, &store, script);
    let pass = app.sync.sync_now().await.expect("the pass");
    assert_eq!(pass.attachments, vec![refused], "{pass:?}");
    let again = app.sync.upload_queued_attachments().await.expect("drain");
    assert_eq!((again.refused, again.news.len()), (1, 0), "{again:?}");
    drop(app);

    let mut script = vec![error_response(403, "FORBIDDEN", "not allowed")];
    script.extend(upload_script());
    let app = launch(&dir, &store, script);
    let forbidden = app.sync.upload_queued_attachments().await.expect("drain");
    assert!(
        matches!(
            forbidden.news.as_slice(),
            [QueuedAttachmentNews::Refused {
                refusal: AttachmentRefusal::NotAllowed,
                status: 403,
                ..
            }]
        ),
        "a new reason is a new refusal: {forbidden:?}"
    );
    let landed = app.sync.upload_queued_attachments().await.expect("drain");
    assert_eq!(
        landed.news,
        vec![QueuedAttachmentNews::Uploaded {
            attachment_id: id.clone(),
            note_id: note.clone(),
        }]
    );
    assert_eq!(app.references(&note), vec![id]);
}

/// #5532: a pass that fails after the walk returns no summary, so the user
/// heard nothing; the next pass tells the refusal instead of keeping quiet.
// Paused: the push's retry ladder sleeps on tokio's clock.
#[tokio::test(start_paused = true)]
async fn a_refusal_in_a_pass_that_failed_is_told_by_the_next_pass() {
    let (dir, store) = (scratch_dir(), store());
    let (note, id) = {
        let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
        let note = app.note(&store);
        let id = app.attach(&note).await.expect("kept for later");
        (note, id)
    };

    let mut script = pass_head();
    script.push(error_response(413, "STORAGE_QUOTA_EXCEEDED", "over quota"));
    // Every attempt the push's retry ladder makes.
    script.extend((0..8).map(|_| Err(TransportError::Offline)));
    let app = launch(&dir, &store, script);
    app.sync.sync_now().await.expect_err("the push failed");
    drop(app);

    let mut script = pass_head();
    script.push(error_response(413, "STORAGE_QUOTA_EXCEEDED", "over quota"));
    script.push(response(
        200,
        &json!({"accepted": [note], "rejected": [], "serverTime": 1, "maxCursor": 1}).to_string(),
    ));
    let app = launch(&dir, &store, script);
    let pass = app.sync.sync_now().await.expect("the pass");
    assert!(
        matches!(
            pass.attachments.as_slice(),
            [QueuedAttachmentNews::Refused { attachment_id, .. }] if *attachment_id == id
        ),
        "{pass:?}"
    );
}

/// #5532 review: only a full quota is storage full. A file past the plan's or
/// the server's per-file limit is too large, which freeing space never fixes,
/// and a 413 with no code the core knows promises neither.
#[tokio::test]
async fn a_413_names_storage_full_only_for_the_quota() {
    for (code, expected) in [
        ("STORAGE_QUOTA_EXCEEDED", AttachmentRefusal::StorageFull),
        ("STORAGE_FILE_TOO_LARGE", AttachmentRefusal::TooLarge),
        ("VALIDATION_BODY_TOO_LARGE", AttachmentRefusal::TooLarge),
        ("SOMETHING_ELSE", AttachmentRefusal::Rejected),
    ] {
        let (dir, store) = (scratch_dir(), store());
        let (note, id) = {
            let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
            let note = app.note(&store);
            let id = app.attach(&note).await.expect("kept for later");
            (note, id)
        };
        let app = launch(&dir, &store, vec![error_response(413, code, "refused")]);
        let drained = app.sync.upload_queued_attachments().await.expect("drain");
        assert_eq!(
            drained.news,
            vec![QueuedAttachmentNews::Refused {
                attachment_id: id,
                note_id: note,
                note_title: "Offline".to_owned(),
                refusal: expected,
                status: 413,
            }],
            "{code}"
        );
    }
}

/// #5532 review: the client gate's kill switch (403 `PLATFORM_WRITES_DISABLED`)
/// and version floor (426 `CLIENT_UPGRADE_REQUIRED`) say nothing about the
/// file. The upload stays owed and silent, and lands once the gate opens.
#[tokio::test]
async fn a_closed_client_gate_keeps_the_upload_owed_and_untold() {
    for (status, code) in [
        (403, "PLATFORM_WRITES_DISABLED"),
        (426, "CLIENT_UPGRADE_REQUIRED"),
    ] {
        let (dir, store) = (scratch_dir(), store());
        let (note, id) = {
            let app = launch(&dir, &store, vec![Err(TransportError::Offline)]);
            let note = app.note(&store);
            let id = app.attach(&note).await.expect("kept for later");
            (note, id)
        };
        let mut script = vec![error_response(status, code, "gate closed")];
        script.extend(upload_script());
        let app = launch(&dir, &store, script);
        let gated = app.sync.upload_queued_attachments().await.expect("drain");
        assert_eq!(
            (gated.refused, gated.news.len()),
            (0, 0),
            "{code}: {gated:?}"
        );
        assert_eq!(owed(&app, &id), 1, "{code}");

        let landed = app.sync.upload_queued_attachments().await.expect("drain");
        assert_eq!(
            (landed.uploaded, landed.news.len()),
            (1, 0),
            "{code}: {landed:?}"
        );
        assert_eq!(app.references(&note), vec![id], "{code}");
    }
}
