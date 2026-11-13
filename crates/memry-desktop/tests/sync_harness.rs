//! Two desktop vaults syncing through the real Worker (`--features harness`): the sync server on
//! miniflare with its D1 migrations (`tests/sync-harness/scripts/serve.ts`, which needs
//! `pnpm install`), reached through the desktop transport, the core's `HttpClient`, record sealing,
//! `PullLoop`, `PushCoordinator` and `SyncEngine`, as Step 17's driver will compose them.
//!
//! | Test                                                   | Rule (#4025)                              |
//! | ------------------------------------------------------ | ----------------------------------------- |
//! | a learned type reaches the other device as a definition | Electron's pull, `seedUnclocked`, push    |
//! | a learned name whose deletion was purged stays deleted  | chapter 05 §5.8, §5.12.3                  |
//! | a definition the user creates over a purged deletion    | chapter 05 §5.12.3 (`create`)             |
//! | a definition only the file holds meets the server's     | `rebuildSingleDbCache`, `seedUnclocked` (#4099) |
//! | a definition only the file holds over a purged deletion | chapter 05 §5.12.3 (`create`, #4099)      |
//!
//! Within it: a definition another device pushed first wins over the learned type, a deleted one
//! stays deleted, the record has the shape Electron's seed pushes, a retry pushes nothing twice,
//! and a promotion whose pass stopped before its push is pushed by the next pass.

#![cfg(feature = "harness")]

#[path = "device_key/mod.rs"]
mod device_key;

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::errors::ApiError;
use memry_core::api::vault::Vault;
use memry_core::crypto::keys;
use memry_core::protocol::account::{AccountCipher, AccountSealer, DeviceSigner, device_directory};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::protocol::types::Declaration;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::seams::secure_store::SecureStoreKey;
use memry_core::storage::Db;
use memry_core::storage::repositories::sync_items;
use memry_core::sync::engine::{PassReport, PushWave, SyncEngine};
use memry_core::sync::outbox;
use memry_core::sync::pull::PullLoop;
use memry_core::sync::push::PushCoordinator;
use memry_core::sync::state::PassTrigger;
use memry_desktop::notes::property_definitions::{
    DefinitionInput, DefinitionType, DefinitionsSeed, OptionInput, PropertyDefinitions,
};
use memry_desktop::seams::tls::{PinFailure, PinFailureSink};
use memry_desktop::seams::transport::app_transport;
use serde_json::{Value, json};

const MASTER_KEY: [u8; 32] = [9u8; 32];

/// The Worker, serving until dropped.
struct Server {
    child: Child,
    url: String,
    devices: Vec<Value>,
    replies: Receiver<Value>,
}

impl Server {
    fn start() -> Self {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/sync-harness");
        let mut child = Command::new(dir.join("node_modules/.bin/tsx"))
            .arg("scripts/serve.ts")
            .current_dir(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start the harness server (run `pnpm install` first)");
        let mut out = BufReader::new(child.stdout.take().expect("its stdout"));
        let mut line = String::new();
        out.read_line(&mut line).expect("the bootstrap line");
        // The Worker logs to stdout; a closed pipe would end it on its first line.
        let (reply, replies) = channel();
        std::thread::spawn(move || {
            for line in out.lines().map_while(Result::ok) {
                match serde_json::from_str::<Value>(&line) {
                    Ok(value) if value.get("harnessMarkers").is_some() => {
                        let _ = reply.send(value);
                    }
                    _ => eprintln!("[worker] {line}"),
                }
            }
        });
        let boot: Value = serde_json::from_str(&line).expect("the bootstrap is JSON");
        Self {
            child,
            url: boot["url"].as_str().expect("a url").to_owned(),
            devices: boot["devices"].as_array().expect("devices").clone(),
            replies,
        }
    }

    /// Runs the Worker's cron, which sheds every tombstone to a marker (§5.12.3, retention 0 days
    /// for a user with no entitlement). Returns how many markers the server holds.
    fn purge(&mut self) -> u64 {
        let stdin = self.child.stdin.as_mut().expect("its stdin");
        stdin
            .write_all(b"purge\n")
            .and_then(|()| stdin.flush())
            .expect("purge");
        let reply = self.replies.recv().expect("the purge reply");
        reply["harnessMarkers"].as_u64().expect("a marker count")
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct NoPins;

impl PinFailureSink for NoPins {
    fn pin_failed(&self, failure: PinFailure) {
        panic!("a loopback server has no pins: {}", failure.hostname);
    }
}

struct Online;

impl Reachability for Online {
    fn current(&self) -> Reachable {
        Reachable::Wifi
    }
    fn observe(&self, _observer: Arc<dyn ReachabilityObserver>) {}
}

/// The push half of a pass: the outbox, drained by the real coordinator.
struct Wave {
    push: PushCoordinator,
    db: Db,
}

#[async_trait::async_trait]
impl PushWave for Wave {
    async fn pending(&self) -> Result<usize, ApiError> {
        self.db
            .read(outbox::depth)
            .await
            .map_err(|error| ApiError::Storage {
                what: error.to_string(),
            })
    }

    async fn drain(&self) -> Result<(), ApiError> {
        let report = self
            .push
            .drain_wave()
            .await
            .map_err(|error| ApiError::Storage {
                what: error.to_string(),
            })?;
        assert_eq!(report.rejected, 0, "the server took every row: {report:?}");
        Ok(())
    }
}

/// One desktop vault, registered as the server's device `at`.
struct Device {
    _dir: tempfile::TempDir,
    vault: PathBuf,
    core: Vault,
    definitions: Arc<PropertyDefinitions>,
    engine: SyncEngine,
    clock_id: String,
}

impl Device {
    async fn new(server: &Server, at: usize) -> Self {
        let boot = &server.devices[at];
        let secret = BASE64
            .decode(boot["signingSecretKey"].as_str().unwrap())
            .unwrap();
        let registered = boot["deviceId"].as_str().unwrap().to_owned();
        let store = device_key::with_device_key();
        store
            .set(SecureStoreKey::DeviceSigningKey, secret.clone())
            .unwrap();
        let token = boot["accessToken"].as_str().unwrap().as_bytes().to_vec();
        store.set(SecureStoreKey::AccessToken, token).unwrap();
        store
            .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
            .unwrap();
        let clock_id = keys::local_device_id_hex(&secret[32..]).unwrap();

        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault");
        let data = vault.join(".memry").join("core");
        std::fs::create_dir_all(&data).unwrap();
        let core = Vault::open("harness".into(), data.to_string_lossy().into_owned()).unwrap();
        let records = core.property_definition_records(store.clone()).unwrap();
        let definitions = Arc::new(PropertyDefinitions::new(vault.clone(), records));

        let transport = app_transport(&["127.0.0.1".to_owned()], Arc::new(NoPins));
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
        )
        .unwrap();
        let http = session.http();
        let vault_key = keys::derive_vault_key(&MASTER_KEY).unwrap().to_vec();
        let directory = device_directory(&http).await.expect("the device list");
        let db = core.db_handle();
        let pull = PullLoop::new(
            Arc::clone(&http),
            db.clone(),
            Declaration::subscribed(),
            Arc::new(AccountCipher::new(vault_key.clone(), directory)),
        )
        .with_clock_device(&clock_id);
        let signer = DeviceSigner::new(&registered, secret).unwrap();
        let sealer = Arc::new(AccountSealer::new(vault_key, signer));
        let push = PushCoordinator::new(
            Arc::clone(&http),
            db.clone(),
            Declaration::subscribed(),
            sealer,
        );
        let engine = SyncEngine::new(Arc::new(pull), http, Arc::new(Online))
            .with_push(Arc::new(Wave { push, db }))
            .with_seed(Arc::new(DefinitionsSeed(Arc::clone(&definitions))));
        Self {
            _dir: dir,
            vault,
            core,
            definitions,
            engine,
            clock_id,
        }
    }

    async fn sync(&self) -> PassReport {
        self.engine.run_pass(PassTrigger::Explicit).await
    }

    fn learn(&self, pairs: &[(&str, DefinitionType)]) {
        let wanted: BTreeMap<String, DefinitionType> = pairs
            .iter()
            .map(|(name, type_name)| ((*name).to_owned(), *type_name))
            .collect();
        assert!(self.definitions.learn(wanted).unwrap());
    }

    /// Every listed definition's type, by name.
    fn listed(&self) -> BTreeMap<String, String> {
        let listed = self.definitions.list().unwrap();
        listed
            .into_iter()
            .map(|view| {
                let type_name = serde_json::to_value(view.type_name).unwrap();
                (view.name, type_name.as_str().unwrap().to_owned())
            })
            .collect()
    }

    fn file(&self) -> String {
        let path = self.vault.join(".memry").join("properties.md");
        std::fs::read_to_string(path).unwrap_or_default()
    }

    /// `properties.md` as a hand edit, or an Electron install that never synced, left it.
    fn write_file(&self, text: &str) {
        let path = self.vault.join(".memry").join("properties.md");
        std::fs::write(path, text).unwrap();
    }

    /// The stored payload of `name`'s record: what the server delivered, on a device that pulled it.
    fn payload(&self, name: &str) -> Option<Value> {
        let name = name.to_owned();
        let row = self
            .core
            .db_handle()
            .call_blocking(move |c| sync_items::load(c, "property_definition", &name))
            .unwrap()?;
        row.deleted_at
            .is_none()
            .then(|| serde_json::from_str(&row.payload.expect("a payload")).expect("json"))
    }

    fn queued(&self) -> usize {
        self.core
            .db_handle()
            .call_blocking(|c| outbox::depth(c))
            .unwrap()
    }
}

fn types(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(name, type_name)| ((*name).to_owned(), (*type_name).to_owned()))
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_learned_type_reaches_the_other_device_as_a_definition() {
    let server = Server::start();
    let a = Device::new(&server, 0).await;
    let b = Device::new(&server, 1).await;

    // B defines `mood` and `gone`, syncs, deletes `gone` and syncs again.
    let mut mood = DefinitionInput {
        name: "mood".into(),
        type_name: Some(DefinitionType::Select),
        options: Some(vec![OptionInput {
            value: "Calm".into(),
            color: "sage".into(),
            default: None,
        }]),
        default_value: None,
        color: None,
    };
    b.definitions.create(mood.clone()).unwrap();
    mood.name = "gone".into();
    b.definitions.create(mood).unwrap();
    let created = b.sync().await;
    assert!(created.pushed, "{created:?}");
    b.definitions.delete("gone").unwrap();
    let deleted = b.sync().await;
    assert!(deleted.pushed, "{deleted:?}");

    // A, signed out until now, learned all three before it saw any record: each is a
    // definition only its file holds (2b3a512960).
    a.learn(&[
        ("rating", DefinitionType::Number),
        ("mood", DefinitionType::Text),
        ("gone", DefinitionType::Text),
    ]);
    assert_eq!(
        a.listed(),
        types(&[("gone", "text"), ("mood", "text"), ("rating", "number")])
    );

    let first = a.sync().await;
    assert!(first.pushed, "{first:?}");
    assert_eq!(
        a.listed(),
        types(&[("mood", "select"), ("rating", "number")]),
        "B's mood wins and gone stays deleted"
    );
    assert!(
        a.file().contains("rating:\n    type: number"),
        "{}",
        a.file()
    );
    assert_eq!(a.queued(), 0);

    // A retry pushes nothing again.
    let retry = a.sync().await;
    assert!(!retry.pushed, "{retry:?}");

    b.sync().await;
    assert_eq!(
        b.listed(),
        types(&[("mood", "select"), ("rating", "number")])
    );
    assert!(
        b.file().contains("rating:\n    type: number"),
        "{}",
        b.file()
    );
    // What the server delivered: the record Electron's `seedUnclocked` pushes for an unclocked
    // learned row (`{...row, clock}`, in its column order), less the local `syncedAt` column. The
    // row is rebuilt from the file, which writes `options: []`, so its options are `"[]"`.
    let rating = b.payload("rating").expect("B holds A's record");
    assert_eq!(
        rating.as_object().unwrap().keys().collect::<Vec<_>>(),
        [
            "name",
            "type",
            "options",
            "defaultValue",
            "color",
            "createdAt",
            "clock"
        ]
    );
    assert_eq!(rating["name"], json!("rating"));
    assert_eq!(rating["type"], json!("number"));
    assert_eq!(rating["options"], json!("[]"));
    assert_eq!(rating["defaultValue"], Value::Null);
    assert_eq!(rating["color"], Value::Null);
    assert_eq!(rating["clock"], json!({ a.clock_id.clone(): 1 }));
    assert!(b.payload("gone").is_none(), "the delete stays on B");
    // A pushed nothing over B's definition: it seeded after its pull had landed it.
    assert_eq!(
        b.payload("mood").expect("B's mood")["clock"],
        json!({ b.clock_id.clone(): 1 })
    );

    // A promotion whose pass stopped before its push: the next pass pushes it, once.
    a.learn(&[("due", DefinitionType::Date)]);
    assert_eq!(a.definitions.seed().unwrap(), ["due"]);
    assert_eq!(a.queued(), 1);
    let resumed = a.sync().await;
    assert!(resumed.pushed, "{resumed:?}");
    assert_eq!(a.queued(), 0);
    b.sync().await;
    assert_eq!(b.listed().get("due").map(String::as_str), Some("date"));
}

/// A device that never pulled a definition's tombstone, because the server shed it to a marker
/// (§5.12.3) that the core never pulls, learns the name. The learned type is a definition its
/// file holds, pushed as `create` like Electron's `seedUnclocked` pushes a learned row, so the
/// server re-creates it over the marker and every device keeps it.
#[tokio::test(flavor = "multi_thread")]
async fn a_learned_name_over_a_purged_deletion_is_kept_and_synced() {
    let mut server = Server::start();
    let b = Device::new(&server, 1).await;
    b.definitions
        .create(DefinitionInput {
            name: "gone".into(),
            type_name: Some(DefinitionType::Text),
            options: None,
            default_value: None,
            color: None,
        })
        .unwrap();
    assert!(b.sync().await.pushed);
    b.definitions.delete("gone").unwrap();
    assert!(b.sync().await.pushed);
    // The shed takes tombstones whose `deleted_at` second has passed.
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    assert_eq!(server.purge(), 1, "the tombstone is a marker now");

    let a = Device::new(&server, 0).await;
    a.learn(&[("gone", DefinitionType::Text)]);
    let first = a.sync().await;
    assert!(first.pushed, "{first:?}");
    assert_eq!(a.listed(), types(&[("gone", "text")]));
    assert!(a.file().contains("gone:\n    type: text"), "{}", a.file());
    assert_eq!(a.queued(), 0);

    // Retyping the name learns nothing, and the next pass pushes nothing.
    let wanted = BTreeMap::from([("gone".to_owned(), DefinitionType::Number)]);
    assert!(!a.definitions.learn(wanted).unwrap());
    let again = a.sync().await;
    assert!(!again.pushed, "{again:?}");

    b.sync().await;
    assert_eq!(b.listed(), types(&[("gone", "text")]));
}

/// The user's own definition over a purged deletion: pushed as `create`, which the server
/// re-creates over the marker (§5.12.3), so it stays on the device that made it and reaches the
/// others.
#[tokio::test(flavor = "multi_thread")]
async fn a_definition_the_user_creates_over_a_purged_deletion_is_kept_and_synced() {
    let mut server = Server::start();
    let b = Device::new(&server, 1).await;
    let gone = |type_name| DefinitionInput {
        name: "gone".into(),
        type_name: Some(type_name),
        options: None,
        default_value: None,
        color: None,
    };
    b.definitions.create(gone(DefinitionType::Text)).unwrap();
    assert!(b.sync().await.pushed);
    b.definitions.delete("gone").unwrap();
    assert!(b.sync().await.pushed);
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    assert_eq!(server.purge(), 1, "the tombstone is a marker now");

    let a = Device::new(&server, 0).await;
    a.sync().await;
    a.definitions.create(gone(DefinitionType::Number)).unwrap();
    let created = a.sync().await;
    assert!(created.pushed, "{created:?}");
    assert_eq!(a.listed(), types(&[("gone", "number")]));
    assert!(a.file().contains("gone:\n    type: number"), "{}", a.file());
    assert_eq!(a.queued(), 0);

    b.sync().await;
    assert_eq!(b.listed(), types(&[("gone", "number")]));
}

/// #4099: B's `properties.md` holds `mood`, `energy` and `gone`, and no record of any. A pushed
/// `mood: text` (learned) and deleted `gone` before B's first sync. B's pull wins over its file for
/// both, as Electron's pull applies over a row with no clock, and B pushes only `energy`, which
/// reaches A. A second pass pushes nothing.
#[tokio::test(flavor = "multi_thread")]
async fn a_definition_only_the_file_holds_meets_the_servers() {
    let server = Server::start();
    let a = Device::new(&server, 0).await;
    let b = Device::new(&server, 1).await;

    a.definitions
        .create(DefinitionInput {
            name: "gone".into(),
            type_name: Some(DefinitionType::Text),
            options: None,
            default_value: None,
            color: None,
        })
        .unwrap();
    assert!(a.sync().await.pushed);
    a.definitions.delete("gone").unwrap();
    a.learn(&[("mood", DefinitionType::Text)]);
    assert!(a.sync().await.pushed);

    b.write_file(
        "---\nproperties:\n  mood:\n    type: select\n    options:\n      - value: Calm\n        color: sage\n  energy:\n    type: number\n  gone:\n    type: text\n---\n",
    );
    let first = b.sync().await;
    assert!(first.pushed, "{first:?}");
    assert_eq!(
        b.listed(),
        types(&[("energy", "number"), ("mood", "text")]),
        "A's mood and A's delete win over B's file"
    );
    assert!(b.file().contains("mood:\n    type: text"), "{}", b.file());
    assert!(!b.file().contains("gone"), "{}", b.file());
    assert_eq!(
        b.payload("mood").expect("A's mood")["clock"],
        json!({ a.clock_id.clone(): 1 }),
        "B pushed nothing over it"
    );
    assert!(b.payload("gone").is_none(), "the delete stays");
    assert_eq!(b.queued(), 0);
    let again = b.sync().await;
    assert!(!again.pushed, "{again:?}");

    a.sync().await;
    assert_eq!(a.listed(), types(&[("energy", "number"), ("mood", "text")]));
    assert_eq!(
        a.payload("energy").expect("B's energy")["clock"],
        json!({ b.clock_id.clone(): 1 })
    );
}

/// A definition only the file holds is the user's, pushed as `create` like Electron's seed, so the
/// server re-creates it over a purged deletion that this core never pulls (§5.12.3).
#[tokio::test(flavor = "multi_thread")]
async fn a_definition_only_the_file_holds_over_a_purged_deletion_is_kept_and_synced() {
    let mut server = Server::start();
    let b = Device::new(&server, 1).await;
    b.definitions
        .create(DefinitionInput {
            name: "gone".into(),
            type_name: Some(DefinitionType::Text),
            options: None,
            default_value: None,
            color: None,
        })
        .unwrap();
    assert!(b.sync().await.pushed);
    b.definitions.delete("gone").unwrap();
    assert!(b.sync().await.pushed);
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    assert_eq!(server.purge(), 1, "the tombstone is a marker now");

    let a = Device::new(&server, 0).await;
    a.write_file("---\nproperties:\n  gone:\n    type: number\n---\n");
    let first = a.sync().await;
    assert!(first.pushed, "{first:?}");
    assert_eq!(a.listed(), types(&[("gone", "number")]));
    assert!(a.file().contains("gone:\n    type: number"), "{}", a.file());
    assert_eq!(a.queued(), 0);

    b.sync().await;
    assert_eq!(b.listed(), types(&[("gone", "number")]));
}
