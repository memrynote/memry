//! Two desktop vaults syncing through `SyncDriver` (#3534) and the real Worker on miniflare
//! (`--features harness`; `tests/sync-harness/scripts/serve.ts` needs `pnpm install`).
//!
//! | Test                                                   | Rule                                  |
//! | ------------------------------------------------------ | ------------------------------------- |
//! | records converge through the driver                    | notes, tasks, projects, the six Step 16 types |
//! | the driver's seeds carry definitions, tags and locks   | Electron's pull, `seedUnclocked`, push |
//! | a paused driver runs no pass                           | the supervisor's pause                |
//! | a device registered after the driver opened            | ch. 01 §1.4.0, applied in the same pass |
//! | a new signer's record, driver dropped before it settled | re-pulled when the next driver opens |
//! | passes over one vault serialize                        | one pass gate: drivers and `sync_now` |
//! | the driver sends the bound vault id                    | K1: unbound refused, rebinding refused |
//! | a desktop first sync pulls every body                  | > 500 bodies, one older than 30 days; progress phases |
//! | the manifest check pulls a lost row, pushes a lost create | ch. 05 §5.15, at most every 30 min |
//! | a reconnect a day after the last pull reads the feed again | Electron `reconnectSync`, the driver's pass |
//! | a task whose project a peer deleted is deleted and pushed | orphan repair, the driver's pass      |
//! | a body owed a per-note pull arrives in the driver's pass | `body_step`, `note_body_sync` confirmed |
//! | a pass whose pull failed leaves every body debt owed   | `driver/bodies.rs` skip rule          |

#![cfg(feature = "harness")]

#[path = "device_key/mod.rs"]
mod device_key;
#[path = "harness_server/mod.rs"]
mod harness_server;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use harness_server::{NoPins, Online, Server};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::errors::{StorageError, SyncError, TransportError};
use memry_core::api::projects::ProjectDraft;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::api::vault::Vault;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::domain::agent_conversation::{self, NewConversation};
use memry_core::domain::agent_message::{self, NewMessage};
use memry_core::domain::vault_locks::{self, TargetKind};
use memry_core::domain::{canvas_folder, home_page, sticky_draft, tag_mint};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::storage::Db;
use memry_core::sync::body_debt;
use memry_core::sync::driver::progress::{
    InitialSyncPhase, InitialSyncProgress, InitialSyncSink, SilentInitialSync,
};
use memry_core::sync::driver::{DriverConfig, SyncDriver};
use memry_core::sync::engine::{PassReport, PassSeed};
use memry_core::sync::first_sync::{RECENT_BODY_LIMIT, RECENT_WINDOW_MS};
use memry_core::sync::hardening::body_state::{self, SyncStateValue};
use memry_core::sync::hardening::history;
use memry_core::sync::state::PassTrigger;
use memry_desktop::notes::property_definitions::{
    DefinitionType, DefinitionsSeed, PropertyDefinitions,
};
use memry_desktop::seams::transport::app_transport;
use serde_json::{Value, json};
use zeroize::Zeroizing;

const MASTER_KEY: [u8; 32] = [9u8; 32];
const AT_REST: [u8; 32] = [5u8; 32];
const NOW: i64 = 1_760_000_000_000;

/// The server vault every harness device binds (decision K1), unless a case names another.
const VAULT: &str = "harness-vault";

/// One desktop vault and its session, before any driver.
struct Local {
    dir: tempfile::TempDir,
    core: Vault,
    store: Arc<dyn SecureStore>,
    definitions: Arc<PropertyDefinitions>,
    session: Arc<AuthSession>,
}

impl Local {
    /// A vault signed in as the server's device `boot` (the bootstrap's device shape).
    fn new(url: &str, boot: &Value) -> Self {
        Self::over(
            url,
            boot,
            app_transport(&["127.0.0.1".to_owned()], Arc::new(NoPins)),
        )
    }

    /// [`Local::new`] whose session talks over `transport`.
    fn over(url: &str, boot: &Value, transport: Arc<dyn Transport>) -> Self {
        let secret = BASE64
            .decode(boot["signingSecretKey"].as_str().unwrap())
            .unwrap();
        let store = device_key::with_device_key();
        store
            .set(SecureStoreKey::DeviceSigningKey, secret.clone())
            .unwrap();
        let token = boot["accessToken"].as_str().unwrap().as_bytes().to_vec();
        store.set(SecureStoreKey::AccessToken, token).unwrap();
        store
            .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
            .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let vault: PathBuf = dir.path().join("vault");
        let data = vault.join(".memry").join("core");
        std::fs::create_dir_all(&data).unwrap();
        let core = Vault::open("harness".into(), data.to_string_lossy().into_owned()).unwrap();
        core.set_at_rest_key(Some(Zeroizing::new(AT_REST))).unwrap();
        let records = core.property_definition_records(store.clone()).unwrap();
        let definitions = Arc::new(PropertyDefinitions::new(
            vault,
            records,
            Some(core.search().unwrap()),
        ));

        let session = Arc::new(
            AuthSession::new(
                transport,
                store.clone(),
                url.to_owned(),
                "desktop".into(),
                DeviceDescriptor {
                    name: format!("harness-{}", boot["deviceId"].as_str().unwrap()),
                    platform: DevicePlatform::Macos,
                    form_factor: None,
                    os_version: None,
                    app_version: "1.0.0".into(),
                    vault_id: None,
                },
                None,
            )
            .unwrap(),
        );
        Self {
            dir,
            core,
            store,
            definitions,
            session,
        }
    }

    /// A desktop driver over this vault: the caller's definitions seed, then `seeds`.
    async fn driver(&self, seeds: Vec<Arc<dyn PassSeed>>) -> Result<SyncDriver, SyncError> {
        let mut all: Vec<Arc<dyn PassSeed>> =
            vec![Arc::new(DefinitionsSeed(Arc::clone(&self.definitions)))];
        all.extend(seeds);
        self.core
            .sync_driver(
                Arc::clone(&self.session),
                Arc::new(Online),
                DriverConfig::desktop(),
                all,
                Vec::new(),
            )
            .await
    }
}

/// One desktop vault, bound to a server vault and synced by a driver.
struct Device {
    _dir: tempfile::TempDir,
    core: Vault,
    store: Arc<dyn SecureStore>,
    definitions: Arc<PropertyDefinitions>,
    session: Arc<AuthSession>,
    driver: SyncDriver,
}

impl Device {
    /// The server's bootstrap device `at`, bound to [`VAULT`].
    async fn new(server: &Server, at: usize) -> Self {
        Self::bound(&server.url, &server.devices[at], VAULT, Vec::new()).await
    }

    async fn bound(url: &str, boot: &Value, vault: &str, seeds: Vec<Arc<dyn PassSeed>>) -> Self {
        Self::from_local(Local::new(url, boot), vault, seeds).await
    }

    /// [`Device::new`] whose session talks over `transport`.
    async fn over(server: &Server, at: usize, transport: Arc<dyn Transport>) -> Self {
        let local = Local::over(&server.url, &server.devices[at], transport);
        Self::from_local(local, VAULT, Vec::new()).await
    }

    async fn from_local(local: Local, vault: &str, seeds: Vec<Arc<dyn PassSeed>>) -> Self {
        local.core.bind_server_vault(vault).unwrap();
        let driver = local.driver(seeds).await.expect("the driver");
        let Local {
            dir,
            core,
            store,
            definitions,
            session,
        } = local;
        Self {
            _dir: dir,
            core,
            store,
            definitions,
            session,
            driver,
        }
    }

    /// A fresh driver over this vault, in place of the one it held.
    async fn reopen(&mut self) {
        self.reopen_on(Arc::new(Online)).await;
    }

    /// [`Device::reopen`] with the driver watching `reachability`.
    async fn reopen_on(&mut self, reachability: Arc<dyn Reachability>) {
        let seeds: Vec<Arc<dyn PassSeed>> =
            vec![Arc::new(DefinitionsSeed(Arc::clone(&self.definitions)))];
        self.driver = self
            .core
            .sync_driver(
                Arc::clone(&self.session),
                reachability,
                DriverConfig::desktop(),
                seeds,
                Vec::new(),
            )
            .await
            .expect("the driver");
    }

    async fn sync(&self) -> PassReport {
        self.driver
            .run_pass(PassTrigger::Explicit)
            .await
            .expect("not paused")
    }

    fn db(&self) -> Db {
        self.core.db_handle()
    }

    /// The live ids of `item_type` this vault holds a record of.
    fn ids(&self, item_type: &str) -> Vec<String> {
        let item_type = item_type.to_owned();
        self.db()
            .call_blocking(move |conn| {
                let mut statement = conn
                    .prepare(
                        "SELECT item_id FROM sync_items
                         WHERE item_type = ?1 AND deleted_at IS NULL ORDER BY item_id",
                    )
                    .map_err(failed)?;
                let ids = statement
                    .query_map([&item_type], |row| row.get(0))
                    .map_err(failed)?
                    .collect::<Result<Vec<String>, _>>()
                    .map_err(failed)?;
                Ok(ids)
            })
            .unwrap()
    }

    /// How many outbox rows wait to be pushed, of any type.
    fn outbox(&self) -> i64 {
        self.db()
            .call_blocking(|conn| {
                conn.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
                    .map_err(failed)
            })
            .unwrap()
    }

    /// How many outbox rows of `item_type` wait to be pushed.
    fn queued(&self, item_type: &str) -> i64 {
        let item_type = item_type.to_owned();
        self.db()
            .call_blocking(move |conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM outbox WHERE item_type = ?1",
                    [&item_type],
                    |row| row.get(0),
                )
                .map_err(failed)
            })
            .unwrap()
    }

    /// The stored payload of a record, as the apply kept it.
    fn stored(&self, item_type: &str, item_id: &str) -> Option<String> {
        let (item_type, item_id) = (item_type.to_owned(), item_id.to_owned());
        self.db()
            .call_blocking(move |conn| {
                conn.query_row(
                    "SELECT payload FROM sync_items
                     WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NULL",
                    [&item_type, &item_id],
                    |row| row.get(0),
                )
                .map(Some)
                .or_else(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(failed(other)),
                })
            })
            .unwrap()
    }
}

impl Device {
    /// Why the record is held corrupt, if it is.
    fn corrupt(&self, item_type: &str, item_id: &str) -> Option<String> {
        let (item_type, item_id) = (item_type.to_owned(), item_id.to_owned());
        self.db()
            .call_blocking(move |conn| {
                conn.query_row(
                    "SELECT corrupt_reason FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
                    [&item_type, &item_id],
                    |row| row.get(0),
                )
                .or_else(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(failed(other)),
                })
            })
            .unwrap()
    }
}

fn failed(error: impl std::fmt::Display) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// A makes one record of every type a desktop writes; B's first sync through its driver pulls
/// them all, and an edit B makes reaches A on the next passes.
#[tokio::test(flavor = "multi_thread")]
async fn records_converge_through_the_driver() {
    let server = Server::start();
    let a = Device::new(&server, 0).await;
    let b = Device::new(&server, 1).await;

    let note = a
        .core
        .notes_writer(a.store.clone())
        .unwrap()
        .create("Plan".into(), None)
        .unwrap();
    let tasks = a.core.tasks(a.store.clone()).unwrap();
    let project = tasks
        .create_project(ProjectDraft {
            name: "Launch".into(),
            description: None,
            color: None,
            icon: None,
            statuses: None,
        })
        .unwrap();
    let task = tasks
        .create(NewTaskInput {
            title: "Ship".into(),
            project_id: project.clone(),
            status_id: None,
            parent_id: None,
            priority: 0,
            description: None,
            due_date: None,
            due_time: None,
            start_date: None,
            repeat: None,
            repeat_from: None,
            tags: Vec::new(),
            linked_note_ids: Vec::new(),
            linked_canvas_ids: Vec::new(),
            source_note_id: None,
            position: None,
        })
        .unwrap()
        .created[0]
        .clone();
    let key = a.core.at_rest_key();
    let (conversation, board, draft) = a
        .db()
        .call_blocking(move |conn| {
            let new = NewConversation {
                vault_id: "vault-1",
                title: "Ask",
                backend: "local",
                backend_model: None,
            };
            let conversation =
                agent_conversation::create(conn, &key, &new, "a", NOW).map_err(failed)?;
            let content = json!({"role": "user", "data": {"text": "what is due"}});
            let message = NewMessage {
                id: Some("m1"),
                conversation_id: &conversation.id,
                role: "user",
                content: &content,
                attachments: &json!([]),
                tool_call_id: None,
                status: "completed",
            };
            agent_message::append(conn, &key, &message, "a", NOW).map_err(failed)?;
            canvas_folder::upsert(conn, "vault-1", "Work", Some(Some("star")), "a", NOW)?;
            let board = home_page::create(
                conn,
                &home_page::NewHomePage {
                    name: "Home",
                    icon: None,
                    position: 0.0,
                    widgets: "[]",
                    cover: None,
                },
                "a",
                NOW,
            )?;
            vault_locks::set(conn, TargetKind::Folder, "Private", true, "a", NOW)?;
            let draft =
                sticky_draft::upsert(conn, None, "jot", sticky_draft::StickyKind::Note, "a", NOW)?;
            Ok((conversation.id, board.id, draft.id))
        })
        .unwrap();
    let pushed = a.sync().await;
    assert!(pushed.pushed, "{pushed:?}");

    assert!(b.driver.needs_first_sync().await.unwrap());
    let first = b
        .driver
        .first_sync(Arc::new(SilentInitialSync))
        .await
        .unwrap()
        .expect("not paused");
    assert!(!first.passes.is_empty());
    assert!(!b.driver.needs_first_sync().await.unwrap());

    let records = [
        ("note", note.clone()),
        ("project", project),
        ("task", task.clone()),
        ("agent_conversation", conversation.clone()),
        ("agent_message", "m1".to_owned()),
        ("canvas_folder", canvas_folder::sync_id("Work")),
        ("home_page", board),
        (
            "vault_lock",
            vault_locks::lock_id(TargetKind::Folder, "Private"),
        ),
        ("sticky_draft", draft),
    ];
    for (item_type, item_id) in &records {
        assert!(
            b.stored(item_type, item_id).is_some(),
            "B holds A's {item_type} {item_id}"
        );
    }
    let key = b.core.at_rest_key();
    let on_b = b
        .db()
        .call_blocking(move |conn| {
            agent_message::get_by_conversation(conn, &key, &conversation).map_err(failed)
        })
        .unwrap();
    assert_eq!(on_b.len(), 1, "the message opens under B's key");

    // B's edit reaches A.
    let b_tasks = b.core.tasks(b.store.clone()).unwrap();
    b_tasks
        .set_title(task.clone(), "Ship it".into())
        .expect("rename on B");
    assert!(b.sync().await.pushed);
    a.sync().await;
    assert_eq!(a.stored("task", &task), b.stored("task", &task));
    let on_a = a.core.tasks(a.store.clone()).unwrap().get(task).unwrap();
    assert_eq!(on_a.expect("the task").title, "Ship it");
}

/// What only a seed makes syncable reaches the other device through the driver's pass: a learned
/// property type (the caller's seed), a minted tag definition and a lock written before Step 16
/// (the driver's own).
#[tokio::test(flavor = "multi_thread")]
async fn the_drivers_seeds_carry_definitions_tags_and_locks() {
    let server = Server::start();
    let a = Device::new(&server, 0).await;
    let b = Device::new(&server, 1).await;

    let learned = BTreeMap::from([("rating".to_owned(), DefinitionType::Number)]);
    assert!(a.definitions.learn(learned).unwrap());
    let lock = vault_locks::lock_id(TargetKind::Folder, "Old");
    let unclocked = lock.clone();
    a.db()
        .call_blocking(move |conn| {
            tag_mint::define_used(conn, &["work".to_owned()], NOW)?;
            conn.execute(
                "INSERT INTO vault_locks (id, target_kind, target, locked, created_at, updated_at)
                 VALUES (?1, 'folder', 'Old', 1, ?2, ?2)",
                rusqlite::params![unclocked, NOW],
            )
            .map_err(failed)?;
            Ok(())
        })
        .unwrap();
    for item_type in ["tag_definition", "vault_lock"] {
        assert_eq!(
            a.queued(item_type),
            0,
            "no {item_type} queued before the pass"
        );
    }

    let pushed = a.sync().await;
    assert!(pushed.pushed, "{pushed:?}");
    b.sync().await;
    assert_eq!(b.ids("property_definition"), ["rating"]);
    assert_eq!(
        b.ids("tag_definition").len(),
        1,
        "{:?}",
        b.ids("tag_definition")
    );
    assert!(
        b.stored("vault_lock", &lock).is_some(),
        "the old lock reached B"
    );
    let folders = b
        .db()
        .call_blocking(|conn| vault_locks::list(conn))
        .unwrap()
        .folders;
    assert_eq!(folders, ["Old"]);
}

/// A paused driver runs no pass and no first sync; resumed, it syncs what queued meanwhile.
#[tokio::test(flavor = "multi_thread")]
async fn a_paused_driver_runs_no_pass() {
    let server = Server::start();
    let a = Device::new(&server, 0).await;
    let b = Device::new(&server, 1).await;
    a.driver.pause();
    assert!(a.driver.status().paused);
    a.core
        .notes_writer(a.store.clone())
        .unwrap()
        .create("Later".into(), None)
        .unwrap();
    assert!(a.driver.run_pass(PassTrigger::Explicit).await.is_none());
    assert!(a.driver.wake(None).await.is_none());
    assert!(
        a.driver
            .first_sync(Arc::new(SilentInitialSync))
            .await
            .unwrap()
            .is_none()
    );
    b.sync().await;
    assert!(b.ids("note").is_empty(), "nothing left A while paused");

    a.driver.resume();
    assert!(a.sync().await.pushed);
    b.sync().await;
    assert_eq!(b.ids("note").len(), 1);
}

/// A device that registers after A's driver opened, and pushes: A's next pass applies the record
/// (chapter 01 §1.4.0, a signer missing from the directory is the ordinary case), never holding it
/// corrupt behind a cursor that moved past it.
#[tokio::test(flavor = "multi_thread")]
async fn a_device_registered_after_the_driver_opened_is_applied_in_the_same_pass() {
    let mut server = Server::start();
    let a = Device::new(&server, 0).await;
    let late = server.register();
    let c = Device::bound(&server.url, &late, VAULT, Vec::new()).await;
    let note = c
        .core
        .notes_writer(c.store.clone())
        .unwrap()
        .create("Late".into(), None)
        .unwrap();
    assert!(c.sync().await.pushed);

    a.sync().await;
    assert_eq!(a.corrupt("note", &note), None, "not held corrupt");
    assert!(
        a.stored("note", &note).is_some(),
        "applied in the same pass"
    );
}

/// Once armed, holds the next pass at its seed step forever, after its pull committed.
#[derive(Default)]
struct Stall {
    armed: std::sync::atomic::AtomicBool,
    reached: tokio::sync::Notify,
}

#[async_trait::async_trait]
impl PassSeed for Stall {
    async fn seed(&self) -> Result<(), StorageError> {
        if self.armed.swap(false, std::sync::atomic::Ordering::SeqCst) {
            self.reached.notify_one();
            std::future::pending::<()>().await;
        }
        Ok(())
    }
}

/// A's pass stores the late device's record corrupt and moves the cursor past it, then A's driver
/// is dropped before it refetched the directory (a quit or crash): the next driver over the vault
/// re-pulls the record when it opens. B's note shares the page, so the page is not refused
/// (§5.14) and the pass reaches its seeds.
#[tokio::test(flavor = "multi_thread")]
async fn a_new_signers_record_held_corrupt_when_the_driver_dropped_applies_on_reopen() {
    let mut server = Server::start();
    let stall = Arc::new(Stall::default());
    let mut a = Device::bound(&server.url, &server.devices[0], VAULT, vec![stall.clone()]).await;
    let b = Device::new(&server, 1).await;
    let late = server.register();
    let c = Device::bound(&server.url, &late, VAULT, Vec::new()).await;
    b.core
        .notes_writer(b.store.clone())
        .unwrap()
        .create("Known".into(), None)
        .unwrap();
    assert!(b.sync().await.pushed);
    let note = c
        .core
        .notes_writer(c.store.clone())
        .unwrap()
        .create("Late".into(), None)
        .unwrap();
    assert!(c.sync().await.pushed);

    stall.armed.store(true, std::sync::atomic::Ordering::SeqCst);
    tokio::select! {
        _ = a.driver.run_pass(PassTrigger::Explicit) => panic!("the pass outran its stalled seed"),
        () = stall.reached.notified() => {}
    }
    assert!(
        a.corrupt("note", &note).is_some(),
        "held corrupt behind the cursor"
    );

    a.reopen().await;
    assert_eq!(a.corrupt("note", &note), None, "no longer corrupt");
    assert!(a.stored("note", &note).is_some(), "applied on reopen");
}

/// Tries `pass` from inside the outer pass, the first time it runs, and records whether it was
/// still waiting when the outer pass gave up on it.
struct Probe {
    attempts: std::sync::Mutex<Option<Attempts>>,
    blocked: std::sync::Mutex<Vec<&'static str>>,
}

struct Attempts {
    driver: Arc<SyncDriver>,
    vault_sync: Arc<memry_core::api::sync::VaultSync>,
}

#[async_trait::async_trait]
impl PassSeed for Probe {
    async fn seed(&self) -> Result<(), StorageError> {
        let Some(attempts) = self.attempts.lock().unwrap().take() else {
            return Ok(());
        };
        let wait = std::time::Duration::from_secs(5);
        let driver = tokio::time::timeout(wait, attempts.driver.run_pass(PassTrigger::Explicit));
        if driver.await.is_err() {
            self.blocked.lock().unwrap().push("driver");
        }
        if tokio::time::timeout(wait, attempts.vault_sync.sync_now())
            .await
            .is_err()
        {
            self.blocked.lock().unwrap().push("sync_now");
        }
        Ok(())
    }
}

/// A second driver over the same vault, and `VaultSync::sync_now`, wait for a running pass: two
/// overlapping passes would push the same outbox rows twice.
#[tokio::test(flavor = "multi_thread")]
async fn passes_over_one_vault_serialize() {
    let server = Server::start();
    let probe = Arc::new(Probe {
        attempts: std::sync::Mutex::default(),
        blocked: std::sync::Mutex::default(),
    });
    let a = Device::bound(&server.url, &server.devices[0], VAULT, vec![probe.clone()]).await;
    let second = a
        .core
        .sync_driver(
            Arc::clone(&a.session),
            Arc::new(Online),
            DriverConfig::desktop(),
            Vec::new(),
            Vec::new(),
        )
        .await
        .map(Arc::new)
        .expect("a second driver");
    *probe.attempts.lock().unwrap() = Some(Attempts {
        driver: Arc::clone(&second),
        vault_sync: a.core.sync(Arc::clone(&a.session)),
    });

    a.sync().await;
    assert_eq!(*probe.blocked.lock().unwrap(), ["driver", "sync_now"]);
    assert!(second.run_pass(PassTrigger::Explicit).await.is_some());
}

/// Decision K1: the driver of a desktop vault sends the bound server vault id on every request.
/// An unbound vault gets no driver (the server would route it to the account's only vault), and
/// a bound vault cannot be rebound to another id.
#[tokio::test(flavor = "multi_thread")]
async fn the_driver_sends_the_bound_vault_id() {
    let mut server = Server::start();
    let unbound = Local::new(&server.url, &server.devices[0]);
    assert!(unbound.driver(Vec::new()).await.is_err(), "unbound refused");
    unbound.core.bind_server_vault("vault-a").unwrap();
    assert!(unbound.core.bind_server_vault("vault-b").is_err());
    unbound.core.bind_server_vault("vault-a").unwrap();
    assert_eq!(
        unbound.core.server_vault_id().unwrap().as_deref(),
        Some("vault-a")
    );
    drop(unbound);

    let a = Device::bound(&server.url, &server.devices[0], "vault-a", Vec::new()).await;
    let b = Device::bound(&server.url, &server.devices[1], "vault-b", Vec::new()).await;
    let late = server.register();
    let c = Device::bound(&server.url, &late, "vault-a", Vec::new()).await;
    let note = a
        .core
        .notes_writer(a.store.clone())
        .unwrap()
        .create("Mine".into(), None)
        .unwrap();
    assert!(a.sync().await.pushed);
    b.sync().await;
    c.sync().await;
    assert!(b.ids("note").is_empty(), "another server vault");
    assert!(c.stored("note", &note).is_some(), "the same server vault");
}

/// The driver's progress, in order.
#[derive(Default)]
struct RecordedProgress(std::sync::Mutex<Vec<InitialSyncProgress>>);

impl InitialSyncSink for RecordedProgress {
    fn progress(&self, progress: InitialSyncProgress) {
        self.0.lock().unwrap().push(progress);
    }
}

/// How many bodies A writes: past the phone's [`RECENT_BODY_LIMIT`].
const BODIES: usize = RECENT_BODY_LIMIT + 1;

/// Writes notes `range` on `device`, each with one paragraph `body {i}` in block `b-{i}`, and
/// pushes them all.
fn write_bodies(device: &Device, range: std::ops::Range<usize>) -> Vec<String> {
    let writer = device.core.notes_writer(device.store.clone()).unwrap();
    let mut notes = Vec::with_capacity(range.len());
    for i in range {
        let id = writer.create(format!("Note {i}"), None).unwrap();
        let edit = BlockEdit::InsertParagraph {
            after_block_id: None,
            text: format!("body {i}"),
            new_block_id: format!("b-{i}"),
        };
        assert!(writer.edit_block(id.clone(), edit).unwrap());
        notes.push(id);
    }
    notes
}

/// A desktop's first sync takes the whole vault (Electron's full sync): more than the phone's 500
/// bodies, and a body last edited before the phone's 30-day window. Its progress runs `notes`,
/// `packs`, then `tasks` for the outbox the catch-up pushes once its seeds ran, and ends
/// `complete`.
///
/// The bodies come from two devices because the Worker allows one device 300 CRDT pushes a
/// minute (`crdtPushRateLimit`).
#[tokio::test(flavor = "multi_thread")]
async fn a_desktop_first_sync_pulls_every_body_old_or_past_the_phone_limit() {
    let mut server = Server::start();
    let a = Device::new(&server, 0).await;
    // Registered before B's driver opens, so B's directory knows C.
    let boot = server.register();
    let c = Device::bound(&server.url, &boot, VAULT, Vec::new()).await;
    let b = Device::new(&server, 1).await;

    let half = BODIES / 2;
    let mut notes = write_bodies(&a, 0..half);
    notes.extend(write_bodies(&c, half..BODIES));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    // The record the push sends is the `sync_items` payload: its `modifiedAt` dates the note.
    let oldest = notes[0].clone();
    a.db()
        .call_blocking(move |conn| {
            conn.execute(
                "UPDATE sync_items SET payload = json_set(payload,
                   '$.createdAt', '2020-01-01T00:00:00.000Z',
                   '$.modifiedAt', '2020-01-01T00:00:00.000Z')
                 WHERE item_type = 'note' AND item_id = ?1",
                [&oldest],
            )
            .map_err(failed)
        })
        .unwrap();
    for device in [&a, &c] {
        for _ in 0..10 {
            device.sync().await;
            if device.outbox() == 0 {
                break;
            }
        }
        assert_eq!(device.outbox(), 0, "every note and body pushed");
    }

    // A lock only the pass's seed queues: `tasks` counts the outbox after the seeds
    // (Electron's `full-sync-runner.ts:424-451`).
    let lock = vault_locks::lock_id(TargetKind::Folder, "Old");
    b.db()
        .call_blocking(move |conn| {
            conn.execute(
                "INSERT INTO vault_locks (id, target_kind, target, locked, created_at, updated_at)
                 VALUES (?1, 'folder', 'Old', 1, ?2, ?2)",
                rusqlite::params![lock, NOW],
            )
            .map_err(failed)
        })
        .unwrap();
    assert_eq!(b.outbox(), 0, "nothing queued before the seeds");

    let progress = Arc::new(RecordedProgress::default());
    let first = b
        .driver
        .first_sync(Arc::clone(&progress) as Arc<dyn InitialSyncSink>)
        .await
        .unwrap()
        .expect("not paused");
    let pulled = first.first_sync.bodies.documents;
    assert!(pulled >= BODIES, "the first sync pulled {pulled} bodies");

    let id = notes[0].clone();
    let modified: i64 = b
        .db()
        .call_blocking(move |conn| {
            conn.query_row(
                "SELECT modified_at FROM notes WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .map_err(failed)
        })
        .unwrap();
    assert!(
        modified < now - RECENT_WINDOW_MS,
        "the note is outside the phone's window"
    );
    let reader = b.core.notes_writer(b.store.clone()).unwrap();
    for (i, id) in notes.iter().enumerate() {
        let block = reader
            .block_snapshot(id.clone(), format!("b-{i}"))
            .unwrap_or_else(|error| panic!("B lacks note {i}'s body: {error}"))
            .expect("the note is live on B");
        assert!(block.contains(&format!("body {i}")), "{block}");
    }

    let seen = progress.0.lock().unwrap().clone();
    assert!(
        seen.iter().all(|p| p.processed_items <= p.total_items),
        "{seen:?}"
    );
    let phases: Vec<InitialSyncPhase> = seen.iter().map(|p| p.phase).collect();
    let first_of = |phase| phases.iter().position(|p| *p == phase);
    let notes_at = first_of(InitialSyncPhase::Notes).expect("notes");
    let packs_at = first_of(InitialSyncPhase::Packs).expect("packs");
    let tasks_at = first_of(InitialSyncPhase::Tasks).expect("tasks");
    assert!(notes_at < packs_at && packs_at < tasks_at, "{phases:?}");
    assert!(seen[tasks_at].total_items >= 1 && seen[tasks_at].processed_items == 0);
    assert_eq!(
        phases.last(),
        Some(&InitialSyncPhase::Complete),
        "{phases:?}"
    );
    assert_eq!(
        phases
            .iter()
            .filter(|p| **p == InitialSyncPhase::Complete)
            .count(),
        1
    );
}

impl Device {
    /// A project and one task in it, as the user makes them; the task's id.
    fn new_task(&self, title: &str) -> String {
        let tasks = self.core.tasks(self.store.clone()).unwrap();
        let project = tasks
            .create_project(ProjectDraft {
                name: "Launch".into(),
                description: None,
                color: None,
                icon: None,
                statuses: None,
            })
            .unwrap();
        tasks
            .create(NewTaskInput {
                title: title.into(),
                project_id: project,
                status_id: None,
                parent_id: None,
                priority: 0,
                description: None,
                due_date: None,
                due_time: None,
                start_date: None,
                repeat: None,
                repeat_from: None,
                tags: Vec::new(),
                linked_note_ids: Vec::new(),
                linked_canvas_ids: Vec::new(),
                source_note_id: None,
                position: None,
            })
            .unwrap()
            .created[0]
            .clone()
    }

    /// The `(kind, item_count, details)` of each sync history row, oldest first.
    fn history(&self) -> Vec<(String, i64, Option<String>)> {
        let (mut rows, _) = self
            .db()
            .call_blocking(|conn| history::entries(conn, 100, 0))
            .unwrap();
        rows.reverse();
        rows.into_iter()
            .map(|row| (row.kind, row.item_count, row.details))
            .collect()
    }
}

/// A delete queued on A while B edits the same task: B's edit, pulled into A's pass before A's
/// delete pushes, does not resurrect the task. A keeps it deleted, its delete reaches the server,
/// and B and a device that joins later both end with the task deleted (Electron's
/// `pending-deletes`, which the shared apply makes unnecessary, #3534 L3a).
#[tokio::test(flavor = "multi_thread")]
async fn a_queued_delete_survives_a_concurrent_edit_pulled_in_the_same_pass() {
    let mut server = Server::start();
    let a = Device::new(&server, 0).await;
    let b = Device::new(&server, 1).await;
    let task = a.new_task("Ship");
    assert!(a.sync().await.pushed);
    b.sync().await;
    assert!(b.stored("task", &task).is_some());

    a.core
        .tasks(a.store.clone())
        .unwrap()
        .delete(task.clone(), false)
        .expect("delete on A");
    assert_eq!(a.queued("task"), 1, "the delete waits for A's pass");
    b.core
        .tasks(b.store.clone())
        .unwrap()
        .set_title(task.clone(), "Ship it".into())
        .expect("rename on B");
    assert!(b.sync().await.pushed);

    let pass = a.sync().await;
    assert!(a.stored("task", &task).is_none(), "A's task stays deleted");
    let tombstone: String = {
        let task = task.clone();
        a.db()
            .call_blocking(move |conn| {
                conn.query_row(
                    "SELECT payload FROM sync_items WHERE item_type = 'task' AND item_id = ?1",
                    [&task],
                    |row| row.get(0),
                )
                .map_err(|error| memry_core::api::errors::StorageError::Failed {
                    what: error.to_string(),
                })
            })
            .unwrap()
    };
    assert!(
        tombstone.contains("Ship it"),
        "B's edit took the concurrent merge, under the delete: {pass:?}"
    );
    assert_eq!(a.queued("task"), 0, "A's delete pushed");

    b.sync().await;
    assert!(
        b.stored("task", &task).is_none(),
        "B ends with the task deleted"
    );
    let late = server.register();
    let c = Device::bound(&server.url, &late, VAULT, Vec::new()).await;
    c.sync().await;
    assert!(
        c.stored("task", &task).is_none(),
        "the server holds the tombstone"
    );
}

/// Each pass the driver runs leaves its sync history rows: a push that sent rows, a pull that
/// pulled, as Electron's coordinators write them (#3534 L3a).
#[tokio::test(flavor = "multi_thread")]
async fn the_driver_records_each_pass_in_the_sync_history() {
    let server = Server::start();
    let a = Device::new(&server, 0).await;
    let b = Device::new(&server, 1).await;
    a.new_task("Ship");
    let pass = a.sync().await;
    assert!(pass.pushed_items >= 2, "{pass:?}");

    let pushed = a
        .history()
        .into_iter()
        .filter(|(kind, _, _)| kind == "push")
        .collect::<Vec<_>>();
    assert_eq!(
        pushed,
        [("push".to_owned(), pass.pushed_items as i64, None)]
    );

    let pulled = b.sync().await;
    assert!(pulled.pull.applied >= 2, "{pulled:?}");
    let on_b = b.history();
    assert!(
        on_b.contains(&(
            "pull".to_owned(),
            (pulled.pull.applied + pulled.pull.deleted) as i64,
            None
        )),
        "{on_b:?}"
    );
    assert!(on_b.iter().all(|(kind, _, _)| kind != "error"), "{on_b:?}");
}

impl Device {
    /// Runs `sql` on this vault's data database: the harness's way to lose a row.
    fn exec(&self, sql: &'static str, id: &str) -> usize {
        let id = id.to_owned();
        self.db()
            .call_blocking(move |conn| conn.execute(sql, [&id]).map_err(failed))
            .unwrap()
    }
}

/// The manifest check repairs what the feed cannot (#3534 L3b): B loses its row of a task the
/// server still holds, and A loses the push of a task it made. A fresh driver on each (the
/// check runs at most every 30 minutes per driver) pulls B's task back by id and queues A's as
/// `create`, which the next pass pushes and B pulls.
#[tokio::test(flavor = "multi_thread")]
async fn the_manifest_check_pulls_a_lost_row_and_pushes_a_lost_create() {
    let server = Server::start();
    let mut a = Device::new(&server, 0).await;
    let mut b = Device::new(&server, 1).await;
    let kept = a.new_task("Ship");
    assert!(a.sync().await.pushed);
    b.sync().await;
    assert!(b.stored("task", &kept).is_some());

    let lost = "DELETE FROM sync_items WHERE item_type = 'task' AND item_id = ?1";
    assert_eq!(b.exec(lost, &kept), 1);
    b.reopen().await;
    b.sync().await;
    assert!(
        b.stored("task", &kept).is_some(),
        "the server-only task is pulled by id"
    );

    let unsent = a.new_task("Review");
    assert_eq!(
        a.exec(
            "DELETE FROM outbox WHERE item_type = 'task' AND item_id = ?1",
            &unsent
        ),
        1
    );
    a.reopen().await;
    a.sync().await;
    assert_eq!(
        a.queued("task"),
        1,
        "the local-only task is queued as create"
    );
    assert!(a.sync().await.pushed);
    b.sync().await;
    assert!(
        b.stored("task", &unsent).is_some(),
        "the re-pushed task reaches B"
    );
}

/// Online all along; [`Reconnects::reconnect`] tells the driver the network came back.
#[derive(Default)]
struct Reconnects(std::sync::Mutex<Vec<Arc<dyn ReachabilityObserver>>>);

impl Reconnects {
    fn reconnect(&self) {
        for observer in self.0.lock().unwrap().iter() {
            observer.on_change(Reachable::Wifi);
        }
    }
}

impl Reachability for Reconnects {
    fn current(&self) -> Reachable {
        Reachable::Wifi
    }

    fn observe(&self, observer: Arc<dyn ReachabilityObserver>) {
        self.0.lock().unwrap().push(observer);
    }
}

/// The extended-offline reset on the driver's pass (#3534 L3b): B loses its row of a task behind
/// its cursor, and its last pull is 25 hours old. Coming back online, B's next pass reads the
/// feed from the start and the task comes back. One driver throughout, so the manifest check
/// (once per 30 minutes per driver, on the first pass) is not what restores it.
#[tokio::test(flavor = "multi_thread")]
async fn a_reconnect_a_day_after_the_last_pull_reads_the_feed_again() {
    let server = Server::start();
    let a = Device::new(&server, 0).await;
    let mut b = Device::new(&server, 1).await;
    let network = Arc::new(Reconnects::default());
    b.reopen_on(network.clone()).await;
    let task = a.new_task("Ship");
    assert!(a.sync().await.pushed);
    b.sync().await;
    assert!(b.stored("task", &task).is_some());

    let lost = "DELETE FROM sync_items WHERE item_type = 'task' AND item_id = ?1";
    assert_eq!(b.exec(lost, &task), 1);
    b.sync().await;
    assert!(
        b.stored("task", &task).is_none(),
        "the cursor is past the task"
    );

    let day_ago = "UPDATE sync_history SET created_at = created_at - 90000000 WHERE ?1 = ?1";
    assert!(b.exec(day_ago, "") > 0);
    network.reconnect();
    b.sync().await;
    assert!(
        b.stored("task", &task).is_some(),
        "the feed was read from the start"
    );
}

/// Orphan repair on the driver's pass (#3534 L3b): A deletes a project and its task's delete is
/// lost before it reaches the server. B pulls the project's tombstone, fetches the task again,
/// tombstones it and pushes the delete, so a device that joins later holds it deleted.
#[tokio::test(flavor = "multi_thread")]
async fn a_task_whose_project_a_peer_deleted_is_deleted_and_its_delete_pushed() {
    let mut server = Server::start();
    let a = Device::new(&server, 0).await;
    let b = Device::new(&server, 1).await;
    let task = a.new_task("Ship");
    assert!(a.sync().await.pushed);
    b.sync().await;
    let stored = b.stored("task", &task).expect("B holds the task");
    let project = serde_json::from_str::<Value>(&stored).unwrap()["projectId"]
        .as_str()
        .expect("the task's project")
        .to_owned();

    let tasks = a.core.tasks(a.store.clone()).unwrap();
    tasks.delete_project(project.clone(), false).unwrap();
    let unsent = "DELETE FROM outbox WHERE item_type = 'task' AND item_id = ?1";
    assert_eq!(a.exec(unsent, &task), 1, "the task's delete is lost");
    assert!(a.sync().await.pushed);

    b.sync().await;
    assert!(b.stored("project", &project).is_none());
    assert!(b.stored("task", &task).is_none(), "the orphan is deleted");
    assert_eq!(b.queued("task"), 0, "its delete was pushed");

    let late = server.register();
    let c = Device::bound(&server.url, &late, VAULT, Vec::new()).await;
    c.sync().await;
    assert!(c.stored("project", &project).is_none());
    assert!(
        c.stored("task", &task).is_none(),
        "the server holds the task deleted"
    );
}

/// A document owed a per-note pull is pulled by the driver's pass (`body_step`, as iOS's
/// `sync_now` does), and the pushing device reads its note's body as confirmed.
#[tokio::test(flavor = "multi_thread")]
async fn a_body_owed_a_per_note_pull_arrives_in_the_drivers_pass() {
    let server = Server::start();
    let a = Device::new(&server, 0).await;
    let b = Device::new(&server, 1).await;
    let note = write_bodies(&a, 0..1).remove(0);
    for _ in 0..3 {
        a.sync().await;
    }
    assert_eq!(a.outbox(), 0, "A pushed the note and its body");
    let state = {
        let note = note.clone();
        a.db()
            .call_blocking(move |conn| {
                // The vault file's row, which the desktop indexer writes.
                conn.execute(
                    "INSERT INTO note_files (note_id, path, indexed_at) VALUES (?1, ?1 || '.md', 0)",
                    [&note],
                )
                .map_err(failed)?;
                body_state::note_sync_state(conn, &note, true)
            })
            .unwrap()
            .expect("A knows its note")
    };
    assert_eq!(state.state, SyncStateValue::Confirmed, "{state:?}");

    b.sync().await;
    assert!(b.stored("note", &note).is_some());
    // B loses the body it pulled and owes the document: only the body step brings it back.
    let doc = note.clone();
    b.db()
        .call_blocking(move |conn| {
            for sql in [
                "DELETE FROM yjs_updates WHERE doc_id = ?1",
                "DELETE FROM yjs_snapshots WHERE doc_id = ?1",
                "DELETE FROM sync_cursors WHERE scope = 'crdt:' || ?1",
            ] {
                conn.execute(sql, [&doc]).map_err(failed)?;
            }
            body_debt::owe(conn, &doc)
        })
        .unwrap();

    b.sync().await;

    let doc = note.clone();
    let (owed, updates) = b
        .db()
        .call_blocking(move |conn| {
            let updates: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM yjs_updates WHERE doc_id = ?1",
                    [&doc],
                    |row| row.get(0),
                )
                .map_err(failed)?;
            Ok((body_debt::owed(conn)?, updates))
        })
        .unwrap();
    assert!(!owed.contains(&note), "the debt settled: {owed:?}");
    assert!(updates > 0, "the body is back on B");
}

/// The app transport, answering every `/sync/changes` with a 500 while `fail` is set and
/// counting every body GET (`/sync/crdt/...`).
struct FailPulls {
    inner: Arc<dyn Transport>,
    fail: AtomicBool,
    body_gets: AtomicUsize,
}

#[async_trait::async_trait]
impl Transport for FailPulls {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        if self.fail.load(Ordering::SeqCst) && request.url.contains("/sync/changes") {
            return Ok(HttpResponse {
                status: 500,
                headers: HashMap::new(),
                body: br#"{"error":{"code":"INTERNAL_ERROR","message":"harness"}}"#.to_vec(),
            });
        }
        if request.method == "GET" && request.url.contains("/sync/crdt/") {
            self.body_gets.fetch_add(1, Ordering::SeqCst);
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

/// A pass whose pull failed runs no body step (`driver/bodies.rs`): no body GET and the debt
/// stays owed. The next pass that reaches the server settles it.
#[tokio::test(flavor = "multi_thread")]
async fn a_pass_whose_pull_failed_leaves_every_body_debt_owed() {
    let server = Server::start();
    let a = Device::new(&server, 0).await;
    let pulls = Arc::new(FailPulls {
        inner: app_transport(&["127.0.0.1".to_owned()], Arc::new(NoPins)),
        fail: AtomicBool::new(false),
        body_gets: AtomicUsize::new(0),
    });
    let b = Device::over(&server, 1, pulls.clone()).await;
    let note = write_bodies(&a, 0..1).remove(0);
    for _ in 0..3 {
        a.sync().await;
    }
    b.sync().await;
    assert!(b.stored("note", &note).is_some());
    let owed = || b.db().call_blocking(|conn| body_debt::owed(conn)).unwrap();
    let doc = note.clone();
    b.db()
        .call_blocking(move |conn| body_debt::owe(conn, &doc))
        .unwrap();

    pulls.fail.store(true, Ordering::SeqCst);
    let before = pulls.body_gets.load(Ordering::SeqCst);
    let pass = b.sync().await;
    assert!(pass.pull_error.is_some(), "the pull failed: {pass:?}");
    assert_eq!(
        pulls.body_gets.load(Ordering::SeqCst),
        before,
        "no body GET"
    );
    assert!(owed().contains(&note), "the debt stays owed");

    pulls.fail.store(false, Ordering::SeqCst);
    b.sync().await;
    assert!(
        pulls.body_gets.load(Ordering::SeqCst) > before,
        "the next pass pulls the body"
    );
    assert!(!owed().contains(&note), "the debt settled");
}
