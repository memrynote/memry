//! Pulled changes reaching a real vault's files (#3534 L5, `sync::disk`) against the real Worker
//! on miniflare (`--features harness`; `tests/sync-harness/scripts/serve.ts` needs
//! `pnpm install`). Device A is a bare core vault with its driver; device B is a vault opened
//! through the session and the vault tier, with the shipped watcher, consumer and write-back,
//! and a driver that the disk observer hears.
//!
//! | Test                                                     | Rule                                  |
//! | -------------------------------------------------------- | ------------------------------------- |
//! | a pulled edit reaches the file and keeps local typing    | write-back observer, `schedule`       |
//! | an outside edit is never lost to a pulled body           | the write-back's hash rule, versions  |
//! | an owed file is taken once and pushed                    | `takeOwedFile`, the open sweep        |
//! | a pulled lock reaches the file while the lane is held    | lock observer, no rows' lane          |
//! | a note created on A gets its file on B                   | the write-back files an unfiled note  |
//! | an outside file at that name stays, the note is numbered | `free_path`, create-new only          |
//! | a journal day created on A gets its day file on B        | the write-back files an unfiled day   |
//! | a note with no file at open gets its file                | the open reconcile lists it           |
//! | a pulled note's aliases reach its file and survive B's    | the first file's frontmatter          |
//! | a pulled rename, move, tag or property reaches B          | `writeback::place`, `note_events.rs`  |
//! | a pulled rename reaches B's file after a restart          | the pull mark in `data.db`, reconcile |
//! | a note create the server lost reaches a second device     | the manifest check asks, then re-uploads |
//! | a deleted note stays deleted after a run from cursor 0    | a marker answered, nothing re-uploaded |
//! | a deleted note stays deleted after a first sync           | a marker answered, nothing re-uploaded |

#![cfg(feature = "harness")]

#[path = "device_key/mod.rs"]
mod device_key;
#[path = "harness_server/mod.rs"]
mod harness_server;
#[path = "sync_disk_harness/note_events.rs"]
mod note_events;
#[path = "sync_disk_harness/reupload.rs"]
mod reupload;
#[path = "sync_disk_harness/unfiled.rs"]
mod unfiled;
#[path = "vault_env/mod.rs"]
mod vault_env;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use harness_server::{NoPins, Online, Server};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::errors::StorageError;
use memry_core::api::vault::Vault;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::domain::vault_locks::TargetKind;
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::sync::body_debt;
use memry_core::sync::driver::{ApplyObserver, DriverConfig, SyncDriver};
use memry_core::sync::state::PassTrigger;
use memry_desktop::seams::transport::app_transport;
use memry_desktop::sync::disk::DiskObserver;
use memry_desktop::vault::consumer::Applied;
use serde_json::Value;
use vault_env::{Creates, Env, QUIET, WAIT, creates, edit_in_app, env, indexed};
use zeroize::Zeroizing;

const MASTER_KEY: [u8; 32] = [9u8; 32];
const AT_REST: [u8; 32] = [5u8; 32];
const VAULT: &str = "harness-vault";
const FILE: &str = "n.md";

fn auth(server: &Server, at: usize, store: &Arc<dyn SecureStore>) -> Arc<AuthSession> {
    let boot: &Value = &server.devices[at];
    let secret = BASE64
        .decode(boot["signingSecretKey"].as_str().unwrap())
        .unwrap();
    store.set(SecureStoreKey::DeviceSigningKey, secret).unwrap();
    let token = boot["accessToken"].as_str().unwrap().as_bytes().to_vec();
    store.set(SecureStoreKey::AccessToken, token).unwrap();
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .unwrap();
    let transport = app_transport(&["127.0.0.1".to_owned()], Arc::new(NoPins));
    let descriptor = DeviceDescriptor {
        name: format!("harness-{at}"),
        platform: DevicePlatform::Macos,
        form_factor: None,
        os_version: None,
        app_version: "1.0.0".into(),
        vault_id: None,
    };
    Arc::new(
        AuthSession::new(
            transport,
            store.clone(),
            server.url.clone(),
            "desktop".into(),
            descriptor,
            None,
        )
        .unwrap(),
    )
}

fn bind(core: &Vault) {
    core.set_at_rest_key(Some(Zeroizing::new(AT_REST))).unwrap();
    core.bind_server_vault(VAULT).unwrap();
}

async fn driver(
    core: &Vault,
    auth: &Arc<AuthSession>,
    observers: Vec<Arc<dyn ApplyObserver>>,
) -> SyncDriver {
    core.sync_driver(
        Arc::clone(auth),
        Arc::new(Online),
        DriverConfig::desktop(),
        Vec::new(),
        observers,
    )
    .await
    .expect("the driver")
}

async fn pass(driver: &SyncDriver) {
    driver
        .run_pass(PassTrigger::Explicit)
        .await
        .expect("not paused");
}

/// Device A: a core vault with no files.
struct Peer {
    _dir: tempfile::TempDir,
    core: Vault,
    store: Arc<dyn SecureStore>,
    driver: SyncDriver,
}

impl Peer {
    async fn new(server: &Server) -> Self {
        Self::at(server, 0).await
    }

    /// A core vault with no files, registered as the server's device `at`.
    async fn at(server: &Server, at: usize) -> Self {
        let store = device_key::with_device_key();
        let auth = auth(server, at, &store);
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("vault/.memry/core");
        std::fs::create_dir_all(&data).unwrap();
        let core = Vault::open("peer".into(), data.to_string_lossy().into_owned()).unwrap();
        bind(&core);
        let driver = driver(&core, &auth, Vec::new()).await;
        Self {
            _dir: dir,
            core,
            store,
            driver,
        }
    }

    async fn sync(&self) {
        pass(&self.driver).await;
    }

    /// A note made on A in `folder` with `body` as its one paragraph.
    fn create(&self, title: &str, folder: Option<&str>, body: &str) -> String {
        let writer = self.core.notes_writer(self.store.clone()).unwrap();
        let id = writer.create_with(title, folder, &[], None, None).unwrap();
        let typed = BlockEdit::InsertParagraph {
            after_block_id: None,
            text: body.into(),
            new_block_id: "a-first".into(),
        };
        assert!(writer.edit_block(id.clone(), typed).unwrap());
        id
    }

    fn body(&self, id: &str) -> String {
        let blocks = self.core.notes().blocks(id.to_owned()).unwrap();
        let blocks = blocks.expect("A holds the body");
        blocks
            .iter()
            .flat_map(|block| block.inline.iter().map(|run| run.text.clone()))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Device B: a vault on disk with `n.md`, opened through the vault tier, synced by a driver the
/// disk observer hears.
struct Disk {
    env: Env,
    creates: Arc<Creates>,
    store: Arc<dyn SecureStore>,
    driver: SyncDriver,
    note: String,
}

impl Disk {
    async fn new(server: &Server) -> Self {
        let made = Mutex::new(None);
        let mut env = env(|store| {
            let identity = creates(store);
            *made.lock().unwrap() = Some(identity.clone());
            Some(identity)
        });
        let creates = made.into_inner().unwrap().unwrap();
        let store = creates.store.clone();
        let auth = auth(server, 1, &store);
        env.write(FILE, "first words\n");
        env.open();
        env.facts_until(indexed);
        let core = env.core();
        bind(&core);
        let note = env.rows()[0].0.clone();
        let driver = Self::driver_over(&env, &auth).await;
        Self {
            env,
            creates,
            store,
            driver,
            note,
        }
    }

    async fn driver_over(env: &Env, auth: &Arc<AuthSession>) -> SyncDriver {
        let core = env.core();
        let disk = DiskObserver::new(env.tier.clone(), env.vault.clone(), core.clone());
        driver(&core, auth, vec![Arc::new(disk)]).await
    }

    async fn sync(&self) {
        pass(&self.driver).await;
    }

    fn path(&self) -> PathBuf {
        self.env.vault.join(FILE)
    }

    /// Waits until the file holds `text`.
    fn until_file_holds(&self, text: &str) -> String {
        let deadline = Instant::now() + WAIT;
        loop {
            let file = self.env.read(FILE);
            if file.contains(text) {
                return file;
            }
            assert!(
                Instant::now() < deadline,
                "the file never took {text:?}: {file:?}"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    fn owes(&self) -> bool {
        self.env
            .core()
            .note_files()
            .owes_file_body(&self.note)
            .unwrap()
    }
}

/// Waits until the file at `rel` holds `text`.
fn until_holds(env: &Env, rel: &str, text: &str) -> String {
    let deadline = Instant::now() + WAIT;
    loop {
        let file = std::fs::read_to_string(env.vault.join(rel)).unwrap_or_default();
        if file.contains(text) {
            return file;
        }
        assert!(
            Instant::now() < deadline,
            "{rel} never took {text:?}: {file:?}"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// The row of `id` names `rel` and gets a hash: the file is written, then its row stamped.
fn filed(env: &Env, id: &str, rel: &str) {
    let files = env.core().note_files();
    let deadline = Instant::now() + WAIT;
    loop {
        let row = files.by_id(id).unwrap().expect("a row");
        assert_eq!(row.path, rel);
        if row.content_hash.is_some() {
            return;
        }
        assert!(Instant::now() < deadline, "the row never got a hash");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

fn listed(env: &Env, id: &str) {
    let listed = env.core().note_files().listed_by_id(id).unwrap();
    assert!(listed.is_some(), "the notes list shows it");
}

/// B's note and its body reach A, which then edits the first block and pushes the edit.
async fn edited_on_a(server: &Server, b: &Disk) -> Peer {
    for _ in 0..2 {
        b.sync().await;
    }
    let a = Peer::new(server).await;
    for _ in 0..2 {
        a.sync().await;
    }
    assert!(a.body(&b.note).contains("first words"), "A holds B's body");
    edit_in_app(&a.core, &a.store, &b.note, "edited on A");
    a.sync().await;
    a
}

/// A body edit pulled into B reaches B's file through the write-back, merged with what B typed
/// and has not written to the file yet: the file gets both, never the pulled body alone. Red
/// without the observer: the file keeps `first words`.
#[tokio::test(flavor = "multi_thread")]
async fn a_pulled_edit_reaches_the_file_and_keeps_local_typing() {
    let server = Server::start();
    let b = Disk::new(&server).await;
    let _a = edited_on_a(&server, &b).await;

    let writer = b.env.core().notes_writer(b.store.clone()).unwrap();
    let typed = BlockEdit::InsertParagraph {
        after_block_id: None,
        text: "typed on B".into(),
        new_block_id: "b-typed".into(),
    };
    assert!(writer.edit_block(b.note.clone(), typed).unwrap());
    b.sync().await;

    let file = b.until_file_holds("edited on A");
    assert!(file.contains("typed on B"), "B's typing stays: {file:?}");
}

/// An edit made outside the app on B, which the pull races, is never lost: it is in the file, in
/// the body, or kept as a version when a body went over it.
#[tokio::test(flavor = "multi_thread")]
async fn an_outside_edit_is_never_lost_to_a_pulled_body() {
    let server = Server::start();
    let mut b = Disk::new(&server).await;
    let _a = edited_on_a(&server, &b).await;
    b.env.watcher_live();

    std::fs::write(b.path(), "outside on B\n").unwrap();
    b.sync().await;
    std::thread::sleep(QUIET);

    let held = [
        b.env.read(FILE),
        b.env.body(&b.note),
        b.env.versions(&b.note).join("\n"),
    ];
    assert!(
        held.iter().any(|text| text.contains("outside on B")),
        "the outside edit is gone: {held:?}"
    );
}

/// A file B edited outside the app while its server body was not pulled is owed; the pull that
/// settles the body takes it: the body is the file's, the server body is one version, the
/// marker is gone, A gets the file's text, and a second take (the next open's sweep) keeps no
/// second version. Red without the take: the marker stands and the body is the server's.
#[tokio::test(flavor = "multi_thread")]
async fn an_owed_file_is_taken_once_and_pushed() {
    let server = Server::start();
    let mut b = Disk::new(&server).await;
    let a = edited_on_a(&server, &b).await;
    b.env.watcher_live();

    // B loses its body and owes the document; an outside edit then cannot be fed.
    let doc = b.note.clone();
    b.env
        .core()
        .db_handle()
        .call_blocking(move |conn| {
            for sql in [
                "DELETE FROM yjs_updates WHERE doc_id = ?1",
                "DELETE FROM yjs_snapshots WHERE doc_id = ?1",
                "DELETE FROM sync_cursors WHERE scope = 'crdt:' || ?1",
            ] {
                conn.execute(sql, [&doc])
                    .map_err(|error| StorageError::Failed {
                        what: error.to_string(),
                    })?;
            }
            body_debt::owe(conn, &doc)
        })
        .unwrap();
    std::fs::write(b.path(), "taken from the file\n").unwrap();
    let deadline = Instant::now() + WAIT;
    while !b.owes() {
        assert!(
            Instant::now() < deadline,
            "the outside edit never owed its file"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    b.sync().await;
    assert!(!b.owes(), "the pull that settled the body took the file");
    assert_eq!(b.env.body(&b.note), "taken from the file");
    let server_versions = |env: &Env, note: &str| {
        env.versions(note)
            .iter()
            .filter(|version| version.contains("edited on A"))
            .count()
    };
    assert_eq!(
        server_versions(&b.env, &b.note),
        1,
        "the server body is kept once"
    );
    b.sync().await;

    // The next open sweeps again and finds nothing owed. The app ends the vault's sync before a
    // close, and the driver holds the vault open until it drops.
    let Disk {
        mut env,
        driver,
        note,
        ..
    } = b;
    drop(driver);
    env.close();
    env.open();
    // The consumer runs the open's sweep before it applies any later fact, so a file written now
    // and seen added proves the sweep ran.
    env.write("after-open.md", "after the open\n");
    env.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "after-open.md"));
    assert_eq!(
        server_versions(&env, &note),
        1,
        "a second take keeps no second version"
    );
    assert_eq!(env.body(&note), "taken from the file");
    assert_eq!(env.read(FILE), "taken from the file\n");

    a.sync().await;
    assert_eq!(
        a.body(&note),
        "taken from the file",
        "A gets the file's text"
    );
}

/// A lock set on A reaches B's file attributes while B's rows' lane is held by a slow write: the
/// lock observer takes no lane, so the pass ends. Unlocked on A, the file is writable again. Red
/// without the observer: B's file stays writable.
#[tokio::test(flavor = "multi_thread")]
async fn a_pulled_lock_reaches_the_file_while_the_lane_is_held() {
    let server = Server::start();
    let mut b = Disk::new(&server).await;
    let a = edited_on_a(&server, &b).await;
    let writer = a.core.notes_writer(a.store.clone()).unwrap();
    let device = writer.device_id();
    a.core
        .locks()
        .set(TargetKind::Note, &b.note, true, &device)
        .unwrap();
    a.sync().await;

    // A slow identity offer holds the lane while the pull applies the lock.
    b.env.watcher_live();
    b.creates.hold();
    b.env.write("other.md", "held\n");
    let deadline = Instant::now() + WAIT;
    while b
        .creates
        .offered
        .lock()
        .unwrap()
        .iter()
        .all(|path| path != "other.md")
    {
        assert!(Instant::now() < deadline, "the offer never came");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    b.sync().await;
    let locked = std::fs::metadata(b.path())
        .unwrap()
        .permissions()
        .readonly();
    b.creates.release();
    assert!(locked, "the pulled lock made B's file read-only");

    a.core
        .locks()
        .set(TargetKind::Note, &b.note, false, &device)
        .unwrap();
    a.sync().await;
    b.sync().await;
    let readonly = std::fs::metadata(b.path())
        .unwrap()
        .permissions()
        .readonly();
    assert!(!readonly, "the pulled unlock made B's file writable");
}
