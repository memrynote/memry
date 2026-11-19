//! The attachment runners (#3535 S5) against a real `data.db`, a temp vault
//! and a scripted server.
//!
//! | Test                                                        | Rule                                 |
//! | ----------------------------------------------------------- | ------------------------------------ |
//! | a duplicate download joins the running one, no slot of its own | `DownloadQueue.keyOf`              |
//! | a revived note is probed before its file is queued           | §14.8.2, `probeNoteAttachments`      |
//! | a failed probe queues nothing and keeps the note             | `settleRevivedNotes`                 |
//! | record moves survive a crash before the reupload             | S1 plan `move_records`               |
//! | a deleted canvas releases its holds before the dereference   | §14.8.1, `releaseCanvas`             |
//! | a deleted note is freed on day 30, never a live reference    | `releaseExpiredDeletedAssets`        |
//! | a backfill cut off midway converges and keeps retry windows  | `backfillUnsyncedAttachmentsWith`    |

#[allow(unused_imports)]
use crate::http_fakes;
#[allow(unused_imports)]
use crate::support;

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeTransport, RecordingSleeper, body_json, error_response, response};
use memry_core::api::errors::StorageError;
use memry_core::domain::notes::{self, NewNote};
use memry_core::protocol::attachments::SignerResolver;
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use memry_core::storage::Db;
use memry_core::sync::attachments::download::DownloadTarget;
use memry_core::sync::attachments::holds::{NOTE_PROBE_DOMAIN, canvas_asset_holder_id, holder_id};
use memry_core::sync::attachments::plan::RELEASE_GRACE_MS;
use memry_core::sync::attachments::queue::{
    DownloadFn, DownloadQueue, DownloadRequest, DownloadSource, VaultFiles,
};
use memry_core::sync::attachments::release::{CanvasAsset, CanvasAssets, CanvasKept, release_due};
use memry_core::sync::attachments::revival::{mark_revived, revived, settle_revived};
use memry_core::sync::attachments::server::AttachmentServer;
use memry_core::sync::attachments::store::releases::{self, ItemType};
use memry_core::sync::attachments::store::{files, upload_queue};
use memry_core::sync::attachments::transfer::TransferError;
use rusqlite::Connection;
use serde_json::json;
use support::{ScratchDb, hex_field, scratch_data_db, scratch_dir, str_field, vector_file};

const DEVICE: &str = "device-a";
const NOW: i64 = 1_800_000_000_000;
const VAULT: &str = "default";
/// The attachment of the committed manifest vector.
const STORED: &str = "att-single";

struct TempVault(tempfile::TempDir);

impl TempVault {
    fn new() -> Self {
        Self(scratch_dir("runner-vault"))
    }

    fn write(&self, rel: &str, bytes: &[u8]) {
        let path = self.0.path().join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn abs(&self, rel: &str) -> String {
        self.0.path().join(rel).to_string_lossy().into_owned()
    }
}

impl VaultFiles for TempVault {
    fn root(&self) -> &Path {
        self.0.path()
    }

    fn open(&self, rel: &str) -> io::Result<File> {
        if rel.split('/').any(|part| part == "..") {
            return Err(io::Error::other("outside the vault"));
        }
        File::open(self.0.path().join(rel))
    }

    fn list_files(&self, rel_dir: &str) -> io::Result<Vec<String>> {
        let mut names = Vec::new();
        for entry in fs::read_dir(self.0.path().join(rel_dir))? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
        names.sort();
        Ok(names)
    }
}

fn failed(error: impl ToString) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn sql(db: &Db, statement: &'static str) {
    db.call_blocking(move |conn| conn.execute_batch(statement).map_err(failed))
        .unwrap();
}

fn note(db: &Db, id: &'static str, path: &'static str, references: &[&str]) {
    let references: Vec<String> = references.iter().map(|r| (*r).to_owned()).collect();
    db.call_blocking(move |conn| {
        let new = NewNote {
            id,
            title: id,
            folder_path: None,
            content: "",
            tags: &[],
            properties: None,
            emoji: None,
        };
        notes::create(conn, &new, DEVICE, NOW).map_err(failed)?;
        for reference in &references {
            notes::add_attachment_reference(conn, id, reference, DEVICE, NOW)?;
        }
        conn.execute(
            "INSERT INTO note_files (note_id, path, indexed_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![id, path, NOW],
        )
        .map_err(failed)?;
        Ok(())
    })
    .unwrap();
}

fn with<T: Send + 'static>(
    db: &Db,
    f: impl FnOnce(&Connection) -> Result<T, StorageError> + Send + 'static,
) -> T {
    db.call_blocking(|conn| f(conn)).unwrap()
}

fn references(db: &Db, id: &'static str) -> Vec<String> {
    with(db, move |conn| notes::read_attachment_references(conn, id))
}

fn queued(db: &Db) -> Vec<(String, String)> {
    with(db, upload_queue::list_all)
}

struct Signers {
    device_id: String,
    public_key: Vec<u8>,
}

impl SignerResolver for Signers {
    fn public_key(&self, device_id: &str) -> Option<Vec<u8>> {
        (device_id == self.device_id).then(|| self.public_key.clone())
    }
}

/// The scripted server and the keys of the committed manifest vector.
struct Server {
    transport: Arc<FakeTransport>,
    http: HttpClient,
    vault_key: Vec<u8>,
    signers: Signers,
}

impl Server {
    fn new() -> Self {
        let file = vector_file("attachment-manifest");
        let meta = &file["meta"];
        let transport = FakeTransport::new(Vec::new());
        let http = HttpClient::new(
            transport.clone(),
            "https://sync.example",
            ClientIdentity::new("desktop", "1.2.3").unwrap(),
        )
        .with_sleeper(RecordingSleeper::new());
        Self {
            transport,
            http,
            vault_key: hex_field(meta, "vaultKeyHex"),
            signers: Signers {
                device_id: str_field(meta, "signerDeviceId").to_owned(),
                public_key: BASE64
                    .decode(str_field(meta, "signerPublicKeyB64"))
                    .unwrap(),
            },
        }
    }

    fn view(&self) -> AttachmentServer<'_> {
        AttachmentServer {
            http: &self.http,
            vault_id: VAULT,
            vault_key: &self.vault_key,
            signers: &self.signers,
        }
    }

    fn manifest(&self) {
        let file = vector_file("attachment-manifest");
        let body = serde_json::to_string(&file["cases"][0]["envelope"]).unwrap();
        self.transport.push(response(200, &body));
    }

    fn not_found(&self) {
        self.transport
            .push(error_response(404, "ATTACHMENT_NOT_FOUND", "not found"));
    }

    fn ok(&self, body: &str) {
        self.transport.push(response(200, body));
    }

    /// Request paths in order, without the base url.
    fn paths(&self) -> Vec<String> {
        self.transport
            .calls()
            .into_iter()
            .map(|call| call.url.replace("https://sync.example", ""))
            .collect()
    }

    fn body_of(&self, suffix: &str) -> serde_json::Value {
        body_json(&self.transport.calls_to(suffix)[0])
    }
}

fn stored_chunk_hashes() -> Vec<String> {
    let file = vector_file("attachment-manifest");
    let manifest = &file["cases"][0]["manifest"];
    manifest["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|chunk| chunk["encryptedHash"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_duplicate_download_joins_the_running_one_and_takes_no_slot() {
    let calls = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let (counter, opened) = (calls.clone(), gate.clone());
    let download: DownloadFn = Arc::new(move |_request| {
        counter.fetch_add(1, Ordering::SeqCst);
        let opened = opened.clone();
        Box::pin(async move {
            let _pass = opened.acquire().await;
            Err(TransferError::EmptyFile)
        })
    });
    let queue = DownloadQueue::new(download);
    let request = |dir: &str| DownloadRequest {
        owner_id: "note-1".into(),
        attachment_id: "att-1".into(),
        target: DownloadTarget::Dir(PathBuf::from(dir)),
        source: DownloadSource::Eager,
        size_hint: None,
        recency_hint: None,
    };
    let mut first = Box::pin(queue.enqueue(request("/v/attachments/note-1")));
    let mut elsewhere = Box::pin(queue.enqueue(request("/v/elsewhere")));
    poll_once(&mut first).await;
    poll_once(&mut elsewhere).await;
    for _ in 0..5000 {
        if calls.load(Ordering::SeqCst) == 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    let mut again = request("/v/attachments/note-1");
    again.source = DownloadSource::Interactive;
    let mut duplicate = Box::pin(queue.enqueue(again));
    poll_once(&mut duplicate).await;
    assert_eq!(calls.load(Ordering::SeqCst), 2, "one transfer per key");
    assert_eq!(queue.active(), 2, "the duplicate holds no worker slot");
    assert_eq!(queue.pending(), 0, "the duplicate is not queued");

    gate.add_permits(10);
    let first = first.await.unwrap().unwrap_err();
    let duplicate = duplicate.await.unwrap().unwrap_err();
    elsewhere.await.unwrap().unwrap_err();
    assert!(
        Arc::ptr_eq(&first, &duplicate),
        "both callers got one answer"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

/// Runs `future` up to its first wait: an `enqueue` registers its request.
async fn poll_once<F: std::future::Future + Unpin>(future: &mut F) {
    tokio::select! {
        biased;
        _ = future => panic!("the download finished before its gate opened"),
        () = std::future::ready(()) => {}
    }
}

/// A revived note whose stored attachment is recorded at `rel`.
fn revived_note(db: &Db, vault: &TempVault, rel: &'static str, id: &'static str) {
    note(db, "n1", "n1.md", &[id]);
    vault.write(rel, b"picture");
    with(db, move |conn| {
        files::record(conn, "n1", rel, id, NOW)?;
        mark_revived(conn, "n1", NOW)
    });
}

#[tokio::test]
async fn a_revived_note_is_probed_before_its_file_is_queued() {
    let db: ScratchDb = scratch_data_db("revival-probe");
    let vault = Arc::new(TempVault::new());
    revived_note(&db, &vault, "attachments/n1/abc123-pic.png", STORED);
    let server = Server::new();
    let holder = holder_id(&server.vault_key, NOTE_PROBE_DOMAIN, "n1", STORED).unwrap();
    server.manifest();
    server.ok(&json!({ "missing": [holder] }).to_string());
    server.ok("{}");

    let report = settle_revived(&db, server.view(), vault.clone(), DEVICE)
        .await
        .unwrap();

    let paths = server.paths();
    assert_eq!(paths.len(), 3, "{paths:?}");
    assert!(paths[1].ends_with("/sync/attachments/holds"), "{paths:?}");
    assert!(paths[2].ends_with("/holds/release"), "{paths:?}");
    assert_eq!(
        server.body_of("/sync/attachments/holds")["holds"][0]["chunkHashes"],
        json!(stored_chunk_hashes())
    );
    assert_eq!((report.queued, report.freed), (1, 1));
    assert_eq!(
        queued(&db),
        vec![("n1".to_owned(), vault.abs("attachments/n1/abc123-pic.png"))]
    );
    assert!(references(&db, "n1").is_empty(), "the freed id is dropped");
    assert!(with(&db, revived).is_empty(), "the check settled");
}

#[tokio::test]
async fn a_failed_probe_queues_nothing_and_keeps_the_note() {
    let db = scratch_data_db("revival-failed");
    let vault = Arc::new(TempVault::new());
    revived_note(&db, &vault, "attachments/n1/abc123-pic.png", STORED);
    let server = Server::new();
    server.manifest();
    server
        .transport
        .push(error_response(503, "UNAVAILABLE", "try later"));
    server.ok("{}");

    let report = settle_revived(&db, server.view(), vault.clone(), DEVICE)
        .await
        .unwrap();

    assert_eq!(report.pending.len(), 1, "{report:?}");
    assert!(queued(&db).is_empty());
    assert_eq!(references(&db, "n1"), vec![STORED.to_owned()]);
    assert_eq!(with(&db, revived), vec!["n1".to_owned()]);
}

#[tokio::test]
async fn record_moves_survive_a_crash_before_the_reupload() {
    let db = scratch_data_db("revival-moves");
    let vault = Arc::new(TempVault::new());
    note(&db, "n1", "n1.md", &["att-gone"]);
    vault.write("attachments/n1/abc123-new.png", b"renamed");
    with(&db, |conn| {
        files::record(conn, "n1", "attachments/n1/abc123-old.png", "att-gone", NOW)?;
        mark_revived(conn, "n1", NOW)
    });
    sql(
        &db,
        "CREATE TRIGGER crash BEFORE INSERT ON attachment_upload_queue
         BEGIN SELECT RAISE(ABORT, 'crash'); END;",
    );
    let server = Server::new();
    server.not_found();

    let report = settle_revived(&db, server.view(), vault.clone(), DEVICE)
        .await
        .unwrap();

    assert_eq!(report.pending.len(), 1, "{report:?}");
    let records: Vec<(String, Option<String>)> = with(&db, |conn| files::records(conn, "n1"))
        .into_iter()
        .map(|r| (r.path, r.attachment_id))
        .collect();
    assert_eq!(
        records,
        vec![(
            "attachments/n1/abc123-new.png".to_owned(),
            Some("att-gone".to_owned())
        )],
        "the move was committed before the queue write failed"
    );
    assert_eq!(
        references(&db, "n1"),
        vec!["att-gone".to_owned()],
        "no drop before the queue"
    );
    assert_eq!(with(&db, revived), vec!["n1".to_owned()]);

    sql(&db, "DROP TRIGGER crash;");
    server.not_found();
    let report = settle_revived(&db, server.view(), vault.clone(), DEVICE)
        .await
        .unwrap();

    assert_eq!((report.queued, report.freed), (1, 1));
    assert_eq!(
        queued(&db),
        vec![("n1".to_owned(), vault.abs("attachments/n1/abc123-new.png"))]
    );
    assert!(references(&db, "n1").is_empty());
    assert!(with(&db, revived).is_empty());
}

struct FakeCanvases {
    assets: Vec<CanvasAsset>,
    kept: CanvasKept,
    settled: Mutex<Vec<Vec<CanvasAsset>>>,
}

impl CanvasAssets for FakeCanvases {
    fn is_live(&self, _: &Connection, _: &str) -> Result<bool, StorageError> {
        Ok(false)
    }

    fn assets(&self, _: &Connection, _: &str) -> Result<Vec<CanvasAsset>, StorageError> {
        Ok(self.assets.clone())
    }

    fn kept(&self, _: &Connection, _: i64) -> Result<CanvasKept, StorageError> {
        Ok(self.kept.clone())
    }

    fn settle(&self, _: &Connection, _: &str, freed: &[CanvasAsset]) -> Result<(), StorageError> {
        self.settled.lock().unwrap().push(freed.to_vec());
        Ok(())
    }
}

fn canvases() -> Arc<FakeCanvases> {
    let asset = |hash: &str, id: &str, chunks: &[&str]| CanvasAsset {
        content_hash: hash.into(),
        attachment_id: id.into(),
        chunk_hashes: chunks.iter().map(|c| (*c).to_owned()).collect(),
    };
    Arc::new(FakeCanvases {
        assets: vec![asset("h1", "a1", &["x1", "x2"]), asset("h2", "a2", &["x3"])],
        kept: CanvasKept {
            content_hashes: BTreeSet::from(["h2".to_owned()]),
            attachment_ids: BTreeSet::new(),
        },
        settled: Mutex::default(),
    })
}

fn due_records(db: &Db) -> usize {
    with(db, |conn| releases::due(conn, i64::MAX)).len()
}

#[tokio::test]
async fn a_deleted_canvas_releases_its_holds_before_the_dereference() {
    let db = scratch_data_db("release-canvas");
    with(&db, |conn| {
        releases::record(conn, ItemType::Canvas, "c1", None, NOW - RELEASE_GRACE_MS)
    });
    let server = Server::new();
    let source = canvases();

    server
        .transport
        .push(error_response(503, "UNAVAILABLE", "try later"));
    let report = release_due(&db, server.view(), Some(source.clone()), NOW)
        .await
        .unwrap();
    assert_eq!(report.deferred.len(), 1, "{report:?}");
    assert_eq!(
        server.paths().len(),
        1,
        "no dereference without the release"
    );
    assert_eq!(due_records(&db), 1, "the record waits for the next pass");

    server.ok("{}");
    server.ok("{}");
    let report = release_due(&db, server.view(), Some(source.clone()), NOW)
        .await
        .unwrap();

    assert_eq!(report.settled, 1, "{report:?}");
    let paths = server.paths();
    assert!(paths[1].ends_with("/holds/release"), "{paths:?}");
    assert!(paths[2].ends_with("/dereference"), "{paths:?}");
    let holders: Vec<String> = ["h1", "h2"]
        .iter()
        .map(|hash| canvas_asset_holder_id(&server.vault_key, "c1", hash).unwrap())
        .collect();
    assert_eq!(
        server.body_of("/holds/release")["holderIds"],
        json!(holders)
    );
    assert_eq!(
        server.body_of("/dereference")["chunkHashes"],
        json!(["x1", "x2"])
    );
    assert_eq!(
        source.settled.lock().unwrap()[0],
        vec![source.assets[0].clone()]
    );
    assert_eq!(due_records(&db), 0);
}

#[tokio::test]
async fn a_deleted_note_is_freed_on_day_30_and_never_a_live_reference() {
    let db = scratch_data_db("release-note");
    note(&db, "live", "live.md", &["att-live"]);
    let ids = vec![STORED.to_owned(), "att-live".to_owned()];
    with(&db, move |conn| {
        releases::record(conn, ItemType::Note, "gone", Some(&ids), NOW)
    });
    let server = Server::new();

    let day_29 = release_due(&db, server.view(), None, NOW + RELEASE_GRACE_MS - 1)
        .await
        .unwrap();
    assert_eq!(day_29.settled, 0);
    assert!(server.paths().is_empty());

    server.manifest();
    server.ok("{}");
    let day_30 = release_due(&db, server.view(), None, NOW + RELEASE_GRACE_MS)
        .await
        .unwrap();
    assert_eq!(day_30.settled, 1, "{day_30:?}");
    assert_eq!(server.paths().len(), 2, "att-live is never fetched");
    assert_eq!(
        server.body_of("/dereference")["chunkHashes"],
        json!(stored_chunk_hashes())
    );
    assert_eq!(due_records(&db), 0);
}

#[cfg(feature = "markdown")]
mod backfill {
    use super::*;
    use memry_core::sync::attachments::backfill::{backfill, embedded_files};
    use proptest::prelude::*;

    fn row(db: &Db, owner: &'static str) -> upload_queue::PendingUpload {
        with(db, |conn| upload_queue::list_pending(conn, 100))
            .into_iter()
            .find(|row| row.owner_id == owner)
            .unwrap()
    }

    #[tokio::test]
    async fn a_backfill_cut_off_midway_converges_and_keeps_retry_windows() {
        let db = scratch_data_db("backfill-restart");
        let vault = Arc::new(TempVault::new());
        note(&db, "n1", "n1.md", &[]);
        note(&db, "n2", "notes/n2.md", &[]);
        vault.write("n1.md", b"text");
        vault.write("attachments/n1/a.png", b"a");
        vault.write(
            "notes/n2.md",
            b"![c](../images/c%20d.png) ![x](https://e.x/y.png)",
        );
        vault.write("attachments/n2/b.png", b"b");
        vault.write("images/c d.png", b"c");
        sql(
            &db,
            "CREATE TRIGGER crash BEFORE INSERT ON attachment_upload_queue
             WHEN NEW.note_id = 'n2' BEGIN SELECT RAISE(ABORT, 'crash'); END;",
        );

        let first = backfill(&db, vault.clone()).await.unwrap();
        assert_eq!((first.queued, first.errors.len()), (1, 1), "{first:?}");
        with(&db, |conn| {
            upload_queue::mark_failed(conn, "n1", &row_path(conn), "offline", NOW)
        });
        let window = row(&db, "n1");

        sql(&db, "DROP TRIGGER crash;");
        let second = backfill(&db, vault.clone()).await.unwrap();
        assert_eq!((second.queued, second.errors.len()), (2, 0), "{second:?}");
        assert_eq!(
            row(&db, "n1"),
            window,
            "a queued file keeps its attempts and window"
        );
        let mut all = queued(&db);
        all.sort();
        assert_eq!(
            all,
            vec![
                ("n1".to_owned(), vault.abs("attachments/n1/a.png")),
                ("n2".to_owned(), vault.abs("attachments/n2/b.png")),
                ("n2".to_owned(), vault.abs("images/c d.png")),
            ]
        );
        assert_eq!(backfill(&db, vault.clone()).await.unwrap().queued, 0);
    }

    fn row_path(conn: &Connection) -> String {
        upload_queue::list_all(conn).unwrap()[0].1.clone()
    }

    #[test]
    fn embeds_resolve_like_electron() {
        let body = "![a](pic.png) ![b](<attachments/n1/x y.png> \"t\") ![c](../../up.png) \
                    ![d](/abs.png) ![e](data:x) <!-- file:{\"url\":\"docs/f.pdf\"} --> \
                    <!-- file:not-json -->";
        assert_eq!(
            embedded_files(body, "notes/n.md", "n1"),
            vec!["notes/pic.png", "notes/docs/f.pdf"]
        );
        assert_eq!(
            embedded_files("![b](attachments/n1/y.png)", "deep/n.md", "n1"),
            vec!["attachments/n1/y.png"]
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 512, ..ProptestConfig::default() })]

        /// Peer-written bodies: every result stays inside the vault, and there
        /// are never more results than embeds in the body.
        #[test]
        fn embeds_never_leave_the_vault(body in ".{0,400}", dir in "[a-z./]{0,20}") {
            let note_path = format!("{dir}/n.md");
            let found = embedded_files(&body, &note_path, "n1");
            prop_assert!(found.len() <= body.matches("](").count() + body.matches("file:").count());
            for path in found {
                prop_assert!(!path.is_empty() && !path.starts_with('/'));
                prop_assert!(path.split('/').all(|part| part != ".." && part != "." && !part.is_empty()));
            }
        }
    }
}
