//! The supervisor's server-side rules against the real Worker on miniflare (#3534 L4a,
//! `--features harness`; `tests/sync-harness/scripts/serve.ts` needs `pnpm install`).
//!
//! | Test                                                   | Rule                                   |
//! | ------------------------------------------------------ | -------------------------------------- |
//! | writes disabled parks the outbox                       | §11.8 kill switch: no attempt, then drains |
//! | an unentitled driver pulls and does not push           | §11.7.1: reads are never gated         |
//! | the supervisor pushes a local write to another device  | `VaultSyncBackend`, `set_binding(Bound)`, `request_push` |
//! | a write floor above the build parks the outbox         | §11.8 `minWriteVersion`: `version_incompatible`, pulls go on |

#![cfg(feature = "harness")]

#[path = "device_key/mod.rs"]
mod device_key;
#[path = "harness_server/mod.rs"]
mod harness_server;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use harness_server::{NoPins, Online, Server};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::errors::StorageError;
use memry_core::api::vault::Vault;
use memry_core::crypto::keys::derive_vault_key;
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::sync::driver::{DriverConfig, SyncDriver};
use memry_core::sync::engine::{PassReport, PassSeed};
use memry_core::sync::state::{PassTrigger, SyncState};
use memry_desktop::notes::property_definitions::{DefinitionsSeed, PropertyDefinitions};
use memry_desktop::seams::transport::app_transport;
use memry_desktop::sync::backend::VaultSyncBackend;
use memry_desktop::sync::error_category::SyncErrorCategory;
use memry_desktop::sync::gate::{SyncStartGate, VaultBinding};
use memry_desktop::sync::supervisor::{SupervisorParts, SyncSupervisor};
use serde_json::Value;
use zeroize::Zeroizing;

const MASTER_KEY: [u8; 32] = [9u8; 32];
const VAULT: &str = "harness-vault";

/// One desktop vault bound to [`VAULT`] and signed in as the server's device `at`; its at-rest
/// key is the vault key, as `VaultSyncBackend` installs it.
struct Device {
    _dir: tempfile::TempDir,
    core: Arc<Vault>,
    store: Arc<dyn SecureStore>,
    definitions: Arc<PropertyDefinitions>,
    session: Arc<AuthSession>,
}

impl Device {
    fn new(server: &Server, at: usize) -> Self {
        let boot: &Value = &server.devices[at];
        let store = device_key::with_device_key();
        let secret = BASE64
            .decode(boot["signingSecretKey"].as_str().unwrap())
            .unwrap();
        store.set(SecureStoreKey::DeviceSigningKey, secret).unwrap();
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
        let vault_key: [u8; 32] = derive_vault_key(&MASTER_KEY)
            .unwrap()
            .as_slice()
            .try_into()
            .unwrap();
        core.set_at_rest_key(Some(Zeroizing::new(vault_key)))
            .unwrap();
        core.bind_server_vault(VAULT).unwrap();
        let records = core.property_definition_records(store.clone()).unwrap();
        let definitions = Arc::new(PropertyDefinitions::new(
            vault,
            records,
            Some(core.search().unwrap()),
        ));

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
        Self {
            _dir: dir,
            core: Arc::new(core),
            store,
            definitions,
            session,
        }
    }

    /// A supervisor over this device's real backend, gated on `gate`.
    fn supervisor(&self, gate: &Arc<SyncStartGate>) -> SyncSupervisor {
        SyncSupervisor::start(
            &tokio::runtime::Handle::current(),
            SupervisorParts {
                backend: Arc::new(VaultSyncBackend::new(
                    Arc::clone(&self.core),
                    Arc::clone(&self.session),
                    Arc::clone(&self.store),
                    Arc::new(Online),
                    self.seeds(),
                    Arc::new(|| (true, true)),
                )),
                gate: Arc::clone(gate),
                reachability: Arc::new(Online),
                power: None,
                keychain_recovered: None,
                db: self.core.db_handle(),
                on_status: Arc::new(|_| {}),
            },
        )
    }

    fn seeds(&self) -> Vec<Arc<dyn PassSeed>> {
        vec![Arc::new(DefinitionsSeed(Arc::clone(&self.definitions)))]
    }

    async fn driver(&self) -> SyncDriver {
        self.core
            .sync_driver(
                Arc::clone(&self.session),
                Arc::new(Online),
                DriverConfig::desktop(),
                self.seeds(),
            )
            .await
            .expect("the driver")
    }

    fn write_note(&self, title: &str) {
        self.core
            .notes_writer(self.store.clone())
            .unwrap()
            .create(title.into(), None)
            .unwrap();
    }

    fn notes(&self) -> i64 {
        self.count(
            "SELECT COUNT(*) FROM sync_items WHERE item_type = 'note' AND deleted_at IS NULL",
        )
    }

    fn outbox(&self) -> i64 {
        self.count("SELECT COUNT(*) FROM outbox")
    }

    fn attempts(&self) -> i64 {
        self.count("SELECT COALESCE(SUM(attempt_count), 0) FROM outbox")
    }

    fn count(&self, sql: &'static str) -> i64 {
        self.core
            .db_handle()
            .call_blocking(move |conn| {
                conn.query_row(sql, [], |row| row.get(0))
                    .map_err(|error| StorageError::Failed {
                        what: error.to_string(),
                    })
            })
            .unwrap()
    }
}

async fn pass(driver: &SyncDriver) -> PassReport {
    driver
        .run_pass(PassTrigger::Explicit)
        .await
        .expect("not paused")
}

/// With the `desktop` kill switch on, a pass pulls and parks the outbox: no push attempt, no
/// attempt counted. The first pass after the switch clears polls the policy again (the gate is
/// not `Open`) and drains the outbox to the server.
#[tokio::test(flavor = "multi_thread")]
async fn writes_disabled_parks_the_outbox_and_the_first_pass_after_clearing_drains_it() {
    let mut server = Server::start();
    server.policy(false, None);
    let a = Device::new(&server, 0);
    let b = Device::new(&server, 1);
    let (driver_a, driver_b) = (a.driver().await, b.driver().await);

    a.write_note("Parked");
    assert_eq!(a.outbox(), 1);
    let parked = pass(&driver_a).await;
    assert!(parked.parked, "{parked:?}");
    assert_eq!(parked.final_state, SyncState::ReadOnly);
    assert!(!parked.transitions.contains(&SyncState::Pushing));
    assert_eq!(parked.error(), None, "a parked outbox is not a failure");
    assert_eq!(a.outbox(), 1, "no row removed");
    assert_eq!(a.attempts(), 0, "a parked row accrues no attempt");

    server.policy(true, None);
    let drained = pass(&driver_a).await;
    assert!(drained.pushed, "{drained:?}");
    assert_eq!(drained.final_state, SyncState::Idle);
    assert_eq!(a.outbox(), 0);

    pass(&driver_b).await;
    assert_eq!(b.notes(), 1, "the drained note reached B");
}

/// `set_entitled(false)` parks the push even on a paid account (the real Worker answers `402` to
/// every `/sync/*` of an unpaid one, `middleware/paid-sync.ts`), and the pull still runs.
#[tokio::test(flavor = "multi_thread")]
async fn an_unentitled_driver_pulls_and_does_not_push() {
    let server = Server::start();
    let a = Device::new(&server, 0);
    let b = Device::new(&server, 1);
    let (driver_a, driver_b) = (a.driver().await, b.driver().await);

    b.write_note("From B");
    assert!(pass(&driver_b).await.pushed);

    a.write_note("From A");
    driver_a.set_entitled(false);
    let report = pass(&driver_a).await;
    assert!(report.parked, "{report:?}");
    assert_eq!(report.final_state, SyncState::Unentitled);
    assert!(!report.transitions.contains(&SyncState::Pushing));
    assert_eq!(a.notes(), 2, "B's note was pulled");
    assert_eq!(a.outbox(), 1, "A's note stays queued");
    assert_eq!(a.attempts(), 0);

    pass(&driver_b).await;
    assert_eq!(b.notes(), 1, "nothing of A's reached the server");
}

/// The supervisor over the real backend: nothing runs until the binding owner says `Bound`,
/// then a local write and `request_push` reach another device without a Sync Now.
#[tokio::test(flavor = "multi_thread")]
async fn the_supervisor_pushes_a_local_write_to_another_device() {
    let server = Server::start();
    let a = Device::new(&server, 0);
    let b = Device::new(&server, 1);
    let driver_b = b.driver().await;

    let gate = Arc::new(SyncStartGate::default());
    let supervisor = a.supervisor(&gate);

    // The start pass runs once the binding is known; wait for it so the push below is the
    // request's, not the start's.
    gate.set_binding(VaultBinding::Bound);
    until("the start pass", || {
        supervisor.status().last_sync_at.is_some()
    })
    .await;

    a.write_note("Pushed");
    assert_eq!(a.outbox(), 1);
    supervisor.request_push();
    until("the push pass", || a.outbox() == 0).await;

    pass(&driver_b).await;
    assert_eq!(b.notes(), 1, "A's note reached B");
    supervisor.stop().await;
}

/// A `minWriteVersion` above this build parks A's outbox: the supervisor reports
/// `version_incompatible`, the pull still runs, and nothing is attempted. B pushes nothing here:
/// the server gates every `POST`, and a blob fetch is one (`POST /sync/pull`, reported on the
/// PR).
#[tokio::test(flavor = "multi_thread")]
async fn a_write_floor_above_the_build_parks_the_outbox_and_pulls_continue() {
    let mut server = Server::start();
    server.policy(true, Some("999.0.0"));
    let a = Device::new(&server, 0);
    a.write_note("From A");
    let gate = Arc::new(SyncStartGate::default());
    let supervisor = a.supervisor(&gate);
    gate.set_binding(VaultBinding::Bound);
    until("the version floor parks the outbox", || {
        supervisor.status().error_category == Some(SyncErrorCategory::VersionIncompatible)
    })
    .await;
    supervisor.stop().await;

    let report = pass(&a.driver().await).await;
    assert!(report.parked, "{report:?}");
    assert_eq!(report.final_state, SyncState::BlockedUpgrade);
    assert!(
        report.transitions.contains(&SyncState::Pulling),
        "{report:?}"
    );
    assert!(!report.transitions.contains(&SyncState::Pushing));
    assert_eq!(report.error(), None, "a parked outbox is not a failure");
    assert_eq!(a.outbox(), 1, "A's note stays queued");
    assert_eq!(a.attempts(), 0, "a parked row accrues no attempt");
}

/// Polls `done` every 50 ms, at most 600 times.
async fn until(what: &str, mut done: impl FnMut() -> bool) {
    for _ in 0..600 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("{what} never happened");
}
