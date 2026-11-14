//! Two desktop vaults syncing through `SyncDriver` (#3534) and the real Worker on miniflare
//! (`--features harness`; `tests/sync-harness/scripts/serve.ts` needs `pnpm install`).
//!
//! | Test                                                   | Rule                                  |
//! | ------------------------------------------------------ | ------------------------------------- |
//! | records converge through the driver                    | notes, tasks, projects, the six Step 16 types |
//! | the driver's seeds carry definitions, tags and locks   | Electron's pull, `seedUnclocked`, push |
//! | a paused driver runs no pass                           | the supervisor's pause                |

#![cfg(feature = "harness")]

#[path = "device_key/mod.rs"]
mod device_key;
#[path = "harness_server/mod.rs"]
mod harness_server;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use harness_server::{NoPins, Online, Server};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::errors::StorageError;
use memry_core::api::projects::ProjectDraft;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::api::vault::Vault;
use memry_core::domain::agent_conversation::{self, NewConversation};
use memry_core::domain::agent_message::{self, NewMessage};
use memry_core::domain::vault_locks::{self, TargetKind};
use memry_core::domain::{canvas_folder, home_page, sticky_draft, tag_mint};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::storage::Db;
use memry_core::sync::driver::{DriverConfig, SyncDriver};
use memry_core::sync::engine::PassReport;
use memry_core::sync::first_sync::SilentProgress;
use memry_core::sync::state::PassTrigger;
use memry_desktop::notes::property_definitions::{
    DefinitionType, DefinitionsSeed, PropertyDefinitions,
};
use memry_desktop::seams::transport::app_transport;
use serde_json::json;
use zeroize::Zeroizing;

const MASTER_KEY: [u8; 32] = [9u8; 32];
const AT_REST: [u8; 32] = [5u8; 32];
const NOW: i64 = 1_760_000_000_000;

/// One desktop vault, registered as the server's device `at`, synced by a driver.
struct Device {
    _dir: tempfile::TempDir,
    core: Vault,
    store: Arc<dyn SecureStore>,
    definitions: Arc<PropertyDefinitions>,
    driver: SyncDriver,
}

impl Device {
    async fn new(server: &Server, at: usize) -> Self {
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
        let definitions = Arc::new(PropertyDefinitions::new(vault, records));

        let transport = app_transport(&["127.0.0.1".to_owned()], Arc::new(NoPins));
        let session = Arc::new(
            AuthSession::new(
                transport,
                store.clone(),
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
            )
            .unwrap(),
        );
        let seeds: Vec<Arc<dyn memry_core::sync::engine::PassSeed>> =
            vec![Arc::new(DefinitionsSeed(Arc::clone(&definitions)))];
        let driver = core
            .sync_driver(session, Arc::new(Online), DriverConfig::desktop(), seeds)
            .await
            .expect("the driver");
        Self {
            _dir: dir,
            core,
            store,
            definitions,
            driver,
        }
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
                    .map_err(failed);
                ids
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
        .first_sync(Arc::new(SilentProgress))
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
        .update_title(task.clone(), "Ship it".into())
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
    assert!(a.ids("tag_definition").is_empty(), "nothing queued yet");

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
            .first_sync(Arc::new(SilentProgress))
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
