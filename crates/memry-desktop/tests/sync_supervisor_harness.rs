//! The supervisor's server-side rules against the real Worker on miniflare (#3534 L4a,
//! `--features harness`; `tests/sync-harness/scripts/serve.ts` needs `pnpm install`).
//!
//! | Test                                                   | Rule                                   |
//! | ------------------------------------------------------ | -------------------------------------- |
//! | writes disabled parks the outbox                       | §11.8 kill switch: no attempt, then drains |
//! | an unentitled driver pulls and does not push           | §11.7.1: reads are never gated         |
//! | the supervisor pushes a local write to another device  | `VaultSyncBackend`, `set_binding(Bound)`, `request_push` |
//! | a write floor above the build parks the outbox         | §11.8 `minWriteVersion`: `version_incompatible`, pulls go on |
//! | wait_for_pull and outbox_count follow real passes      | L4b test hooks: a pull counted, `synced_settings` 1 then 0 |
//! | ten hints during a held pass give one trailing pass    | chapter 09 hints coalesce into one wake |
//! | real passes tell queue-cleared and no note on the feed | L7 events through the real driver      |
//! | a fresh device's supervisor runs the first sync        | #4893: progress, every body, then passes |
//! | a fresh device's seeded Inbox takes the user's Inbox   | #3538: the refs pass demotes the seed  |
//! | a failed metadata pass does not push the seeded Inbox  | #3538: a demoted seed is not seeded    |
//! | a failed metadata pass does not push a demoted tag mint | a demoted mint is not seeded          |

#![cfg(feature = "harness")]

#[path = "device_key/mod.rs"]
mod device_key;
#[path = "harness_server/mod.rs"]
mod harness_server;

use memry_desktop::session::at_rest_key::AtRestKeys;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use harness_server::{NoPins, Online, Server};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::errors::{StorageError, SyncError, TransportError};
use memry_core::api::vault::Vault;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::crypto::keys::derive_vault_key;
use memry_core::domain::projects::{self, ProjectEdit};
use memry_core::domain::{tag_admin, tag_mint};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_core::sync::driver::progress::{InitialSyncPhase, InitialSyncSink};
use memry_core::sync::driver::{DriverConfig, SyncDriver};
use memry_core::sync::engine::{PassReport, PassSeed};
use memry_core::sync::policy::ServerClock;
use memry_core::sync::socket::{HintSink, parse_frame};
use memry_core::sync::socket_run::TerminalLatch;
use memry_core::sync::state::{PassTrigger, SyncState};
use memry_desktop::notes::property_definitions::{DefinitionsSeed, PropertyDefinitions};
use memry_desktop::seams::transport::app_transport;
use memry_desktop::sync::backend::{SyncBackend, SyncPasses, VaultSyncBackend};
use memry_desktop::sync::error_category::SyncErrorCategory;
use memry_desktop::sync::events::{OnSyncEvent, SyncEvent};
use memry_desktop::sync::gate::AuthFacts;
use memry_desktop::sync::gate::{SyncStartGate, VaultBinding};
use memry_desktop::sync::realtime::{RealtimeSocket, SocketEnd};
use memry_desktop::sync::status::SyncStatusValue;
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
        Self::over(server, at, |transport| transport)
    }

    /// [`Device::new`] with its transport wrapped by `wrap`.
    fn over(
        server: &Server,
        at: usize,
        wrap: impl FnOnce(Arc<dyn Transport>) -> Arc<dyn Transport>,
    ) -> Self {
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

        let transport = wrap(app_transport(&["127.0.0.1".to_owned()], Arc::new(NoPins)));
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
                None,
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
        self.supervisor_over(gate, Arc::new(self.backend()), Arc::new(|_| {}))
    }

    fn backend(&self) -> VaultSyncBackend {
        VaultSyncBackend::new(
            Arc::clone(&self.core),
            Arc::clone(&self.session),
            Arc::clone(&self.store),
            Arc::new(Online),
            self.seeds(),
            Arc::new(|| (true, true)),
            AtRestKeys::new(Arc::clone(&self.store)),
        )
    }

    fn supervisor_over(
        &self,
        gate: &Arc<SyncStartGate>,
        backend: Arc<dyn SyncBackend>,
        on_event: OnSyncEvent,
    ) -> SyncSupervisor {
        SyncSupervisor::start(
            &tokio::runtime::Handle::current(),
            SupervisorParts {
                backend,
                gate: Arc::clone(gate),
                reachability: Arc::new(Online),
                power: None,
                keychain_recovered: None,
                db: self.core.db_handle(),
                telemetry: None,
                signals: memry_desktop::sync::signals::AuthSignals::new(),
                on_status: Arc::new(|_| {}),
                on_event,
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
                Vec::new(),
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

    fn ensure_inbox(&self) {
        let wrote = self
            .core
            .db_handle()
            .call_blocking(|conn| projects::ensure_inbox(conn, 1_000))
            .unwrap();
        assert!(wrote, "a fresh vault seeds its Inbox");
    }

    fn rename_inbox(&self, server: &Server, at: usize, name: &'static str) {
        let device = server.devices[at]["deviceId"].as_str().unwrap().to_owned();
        self.core
            .db_handle()
            .call_blocking(move |conn| {
                let edit = ProjectEdit {
                    name: Some(name),
                    description: None,
                    color: None,
                    icon: None,
                    statuses: None,
                };
                projects::update(conn, projects::INBOX_ID, &edit, &device, 2_000).map(|_| ())
            })
            .unwrap();
    }

    /// The live projects' names, so a second Inbox shows too.
    fn project_names(&self) -> Vec<String> {
        self.core
            .db_handle()
            .call_blocking(|conn| {
                let failed = |error: rusqlite::Error| StorageError::Failed {
                    what: error.to_string(),
                };
                let mut statement = conn
                    .prepare("SELECT name FROM projects ORDER BY id")
                    .map_err(failed)?;
                statement
                    .query_map([], |row| row.get(0))
                    .map_err(failed)?
                    .collect::<Result<Vec<String>, _>>()
                    .map_err(failed)
            })
            .unwrap()
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

/// The test hooks over real passes: `wait_for_pull` returns once a pass pulled B's note, and
/// `outbox_count` sees a settings write queued, then drained by a push.
#[tokio::test(flavor = "multi_thread")]
async fn wait_for_pull_and_outbox_count_follow_real_passes() {
    let server = Server::start();
    let a = Device::new(&server, 0);
    let b = Device::new(&server, 1);
    b.write_note("From B");
    assert!(pass(&b.driver().await).await.pushed);

    let gate = Arc::new(SyncStartGate::default());
    let supervisor = a.supervisor(&gate);
    assert_eq!(supervisor.completed_pulls(), 0);
    gate.set_binding(VaultBinding::Bound);
    let pulls = tokio::time::timeout(Duration::from_secs(30), supervisor.wait_for_pull(0))
        .await
        .expect("a pass pulled");
    assert!(pulls >= 1);
    assert_eq!(a.notes(), 1, "B's note was pulled before the wait returned");

    until("the start pass settled", || {
        supervisor.status().last_sync_at.is_some()
    })
    .await;
    let device = server.devices[0]["deviceId"].as_str().unwrap().to_owned();
    a.core
        .db_handle()
        .call_blocking(move |conn| {
            memry_core::domain::settings::set(
                conn,
                "inbox.reviewReminderEnabled",
                serde_json::json!(true),
                &device,
                1_700_000_000_000,
            )
            .map(|_| ())
        })
        .unwrap();
    assert_eq!(supervisor.outbox_count("synced_settings").await.unwrap(), 1);
    supervisor.request_push();
    for _ in 0..600 {
        if supervisor.outbox_count("synced_settings").await.unwrap() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(supervisor.outbox_count("synced_settings").await.unwrap(), 0);
    supervisor.stop().await;
}

/// The real driver behind a gate that holds a pass while `hold` is set; counts what ran. Its
/// socket stays quiet, so the only hints are the test's.
struct Held {
    inner: Arc<dyn SyncPasses>,
    hold: Arc<AtomicBool>,
    release: Arc<tokio::sync::Notify>,
    ran: Arc<Mutex<Vec<PassTrigger>>>,
}

impl Held {
    async fn gate(&self, trigger: PassTrigger) {
        self.ran.lock().unwrap().push(trigger);
        if self.hold.load(Ordering::SeqCst) {
            self.release.notified().await;
        }
    }
}

#[async_trait::async_trait]
impl SyncPasses for Held {
    async fn run_pass(&self, trigger: PassTrigger) -> Option<PassReport> {
        self.gate(trigger).await;
        self.inner.run_pass(trigger).await
    }
    async fn wake(&self, cursor: Option<i64>) -> Option<PassReport> {
        self.gate(PassTrigger::SocketHint).await;
        self.inner.wake(cursor).await
    }
    async fn needs_first_sync(&self) -> Result<bool, SyncError> {
        self.inner.needs_first_sync().await
    }
    async fn first_sync(
        &self,
        progress: Arc<dyn InitialSyncSink>,
    ) -> Result<Option<PassReport>, SyncError> {
        self.inner.first_sync(progress).await
    }
    fn realtime(
        &self,
        _sink: Arc<dyn HintSink>,
        _latch: Arc<TerminalLatch>,
        _on_connected: Arc<dyn Fn() + Send + Sync>,
    ) -> Arc<dyn RealtimeSocket> {
        Arc::new(Quiet::default())
    }
    fn pause(&self) {
        self.inner.pause();
    }
    fn resume(&self) {
        self.inner.resume();
    }
    fn set_entitled(&self, entitled: bool) {
        self.inner.set_entitled(entitled);
    }
    fn server_clock(&self) -> Option<ServerClock> {
        self.inner.server_clock()
    }
}

#[derive(Default)]
struct Quiet(tokio::sync::Notify);

#[async_trait::async_trait]
impl RealtimeSocket for Quiet {
    async fn run(&self) -> SocketEnd {
        self.0.notified().await;
        SocketEnd::Stopped
    }
    fn stop(&self) {
        self.0.notify_one();
    }
}

struct HeldBackend {
    inner: VaultSyncBackend,
    hold: Arc<AtomicBool>,
    release: Arc<tokio::sync::Notify>,
    ran: Arc<Mutex<Vec<PassTrigger>>>,
}

#[async_trait::async_trait]
impl SyncBackend for HeldBackend {
    async fn auth_facts(&self) -> AuthFacts {
        self.inner.auth_facts().await
    }
    async fn open(
        &self,
        observers: Vec<Arc<dyn memry_core::sync::driver::ApplyObserver>>,
    ) -> Result<Arc<dyn SyncPasses>, SyncError> {
        Ok(Arc::new(Held {
            inner: self.inner.open(observers).await?,
            hold: Arc::clone(&self.hold),
            release: Arc::clone(&self.release),
            ran: Arc::clone(&self.ran),
        }))
    }
    fn refresh_refused(&self) -> bool {
        self.inner.refresh_refused()
    }
    fn close(&self) {
        self.inner.close();
    }
}

/// Ten `changes_available` frames while a pass is held give exactly one trailing pass, a wake.
#[tokio::test(flavor = "multi_thread")]
async fn ten_hints_during_a_held_pass_give_exactly_one_trailing_pass() {
    let server = Server::start();
    let a = Device::new(&server, 0);
    let b = Device::new(&server, 1);
    let backend = Arc::new(HeldBackend {
        inner: a.backend(),
        hold: Arc::default(),
        release: Arc::default(),
        ran: Arc::default(),
    });
    let gate = Arc::new(SyncStartGate::default());
    let supervisor = a.supervisor_over(
        &gate,
        Arc::clone(&backend) as Arc<dyn SyncBackend>,
        Arc::new(|_| {}),
    );
    gate.set_binding(VaultBinding::Bound);
    until("the start pass", || {
        supervisor.status().last_sync_at.is_some()
    })
    .await;
    let ran = || backend.ran.lock().unwrap().clone();
    let before = ran().len();

    backend.hold.store(true, Ordering::SeqCst);
    supervisor.foreground();
    until("the held pass started", || ran().len() == before + 1).await;
    b.write_note("From B");
    assert!(pass(&b.driver().await).await.pushed);
    let sink = supervisor.hint_sink();
    for cursor in 1..=10 {
        let frame = format!(r#"{{"type":"changes_available","payload":{{"cursor":{cursor}}}}}"#);
        sink.hint(parse_frame(frame.as_bytes()).unwrap());
    }
    backend.hold.store(false, Ordering::SeqCst);
    backend.release.notify_one();
    until("B's note arrived", || a.notes() == 1).await;
    until("idle", || {
        supervisor.status().status != SyncStatusValue::Syncing
    })
    .await;
    // Absence: nothing else runs after the trailing pass.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let ran = ran();
    assert_eq!(ran.len(), before + 2, "{ran:?}");
    assert_eq!(ran.last(), Some(&PassTrigger::SocketHint));
    supervisor.stop().await;
}

/// The supervisor's events through a real driver: A's push that empties its outbox tells
/// queue-cleared, and B's pull of the note reaches B's vault but tells the sync feed no note.
#[tokio::test(flavor = "multi_thread")]
async fn real_passes_tell_item_synced_and_queue_cleared() {
    let server = Server::start();
    let a = Device::new(&server, 0);
    let b = Device::new(&server, 1);
    let recorder = |events: &Arc<Mutex<Vec<SyncEvent>>>| -> OnSyncEvent {
        let events = Arc::clone(events);
        Arc::new(move |event| events.lock().unwrap().push(event.clone()))
    };
    let (events_a, events_b) = (Arc::default(), Arc::default());
    let gate = Arc::new(SyncStartGate::default());
    gate.set_binding(VaultBinding::Bound);
    let supervisor_a = a.supervisor_over(&gate, Arc::new(a.backend()), recorder(&events_a));
    until("A's start pass", || {
        supervisor_a.status().last_sync_at.is_some()
    })
    .await;

    a.write_note("Pushed");
    supervisor_a.request_push();
    until("A's push", || a.outbox() == 0).await;
    // A's start pass was its first sync, which told its progress.
    let told = || -> Vec<SyncEvent> {
        events_a
            .lock()
            .unwrap()
            .iter()
            .filter(|event| !matches!(event, SyncEvent::InitialSyncProgress(_)))
            .cloned()
            .collect()
    };
    until("queue-cleared", || !told().is_empty()).await;
    assert!(
        matches!(
            told().as_slice(),
            [SyncEvent::QueueCleared { item_count: 1, .. }]
        ),
        "{events_a:?}"
    );

    let supervisor_b = b.supervisor_over(&gate, Arc::new(b.backend()), recorder(&events_b));
    until("B pulled the note", || b.notes() == 1).await;
    // B is fresh: its first sync's refs pass records the note metadata-only before the
    // metadata pass applies it, so the feed is read once that pass is over.
    until("B's first sync ended", || {
        supervisor_b.status().last_sync_at.is_some()
    })
    .await;
    // The note reached B; its event is the vault tier's, so the sync feed tells no note.
    let notes_told: Vec<SyncEvent> = events_b
        .lock()
        .unwrap()
        .iter()
        .filter(|event| {
            matches!(event, SyncEvent::Pulled(items) if items.iter().any(|item| item.item_type == "note"))
        })
        .cloned()
        .collect();
    assert!(notes_told.is_empty(), "{notes_told:?}");
    supervisor_a.stop().await;
    supervisor_b.stop().await;
}

/// A fresh device's supervisor runs the driver's first sync (#4893): the renderer hears `notes`
/// then one `complete`, every note arrives with its body, `first_sync.completed` is written, and
/// the next Sync Now is an ordinary pass that tells no progress.
#[tokio::test(flavor = "multi_thread")]
async fn a_fresh_devices_supervisor_runs_the_first_sync_then_ordinary_passes() {
    let server = Server::start();
    let a = Device::new(&server, 0);
    let b = Device::new(&server, 1);
    let writer = a.core.notes_writer(a.store.clone()).unwrap();
    let mut notes = Vec::new();
    for i in 0..3 {
        let id = writer.create(format!("Note {i}"), None).unwrap();
        let edit = BlockEdit::InsertParagraph {
            after_block_id: None,
            text: format!("body {i}"),
            new_block_id: format!("b-{i}"),
        };
        assert!(writer.edit_block(id.clone(), edit).unwrap());
        notes.push(id);
    }
    let driver_a = a.driver().await;
    for _ in 0..10 {
        pass(&driver_a).await;
        if a.outbox() == 0 {
            break;
        }
    }
    assert_eq!(a.outbox(), 0, "A pushed the seed");

    let events: Arc<Mutex<Vec<SyncEvent>>> = Arc::default();
    let recorded = Arc::clone(&events);
    let progress = move || -> Vec<(InitialSyncPhase, u64, u64)> {
        recorded
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                SyncEvent::InitialSyncProgress(p) => {
                    Some((p.phase, p.processed_items, p.total_items))
                }
                _ => None,
            })
            .collect()
    };
    let gate = Arc::new(SyncStartGate::default());
    gate.set_binding(VaultBinding::Bound);
    let sink = Arc::clone(&events);
    let supervisor = b.supervisor_over(
        &gate,
        Arc::new(b.backend()),
        Arc::new(move |event| sink.lock().unwrap().push(event.clone())),
    );
    until("the first sync's complete", || {
        progress()
            .iter()
            .any(|(phase, ..)| *phase == InitialSyncPhase::Complete)
    })
    .await;
    until("the first pass answered", || {
        supervisor.status().last_sync_at.is_some()
    })
    .await;

    let seen = progress();
    assert!(
        seen.iter().all(|(_, done, total)| done <= total),
        "{seen:?}"
    );
    let notes_at = seen
        .iter()
        .position(|(phase, ..)| *phase == InitialSyncPhase::Notes)
        .expect("notes");
    assert!(
        seen[notes_at..].iter().any(|(_, _, total)| *total >= 3),
        "{seen:?}"
    );
    assert_eq!(seen.last().map(|p| p.0), Some(InitialSyncPhase::Complete));
    assert_eq!(b.notes(), 3);
    let reader = b.core.notes_writer(b.store.clone()).unwrap();
    for (i, id) in notes.iter().enumerate() {
        let block = reader
            .block_snapshot(id.clone(), format!("b-{i}"))
            .unwrap()
            .expect("the note is live on B");
        assert!(block.contains(&format!("body {i}")), "{block}");
    }
    assert_eq!(
        b.count("SELECT COUNT(*) FROM meta WHERE key = 'first_sync.completed'"),
        1
    );

    // The pass loop has taken over: A's next note arrives through an ordinary pass.
    a.write_note("After");
    pass(&driver_a).await;
    let before = seen.len();
    let result = supervisor.sync_now().await;
    assert!(result.success, "{result:?}");
    assert_eq!(b.notes(), 4);
    assert_eq!(
        progress().len(),
        before,
        "an ordinary pass tells no progress"
    );
    supervisor.stop().await;
}

/// A pushes its Inbox and renames it "Triage"; B seeds its own unclocked Inbox at vault open
/// (`tasks/defaults.rs`). A is A's first device, so B's first sync replaces the seed with
/// "Triage" and never pushes the seed over it.
async fn a_triage_inbox_on_the_server(server: &Server) -> (Device, SyncDriver) {
    let a = Device::new(server, 0);
    a.ensure_inbox();
    let driver_a = a.driver().await;
    pass(&driver_a).await;
    a.rename_inbox(server, 0, "Triage");
    pass(&driver_a).await;
    assert_eq!(a.outbox(), 0, "A pushed its Inbox and the rename");
    (a, driver_a)
}

/// #3538: B's refs pass records the server's Inbox while B holds an unclocked seed at the same
/// id. The seed must not count as the body: the metadata pass fetches the user's Inbox over it.
#[tokio::test(flavor = "multi_thread")]
async fn a_fresh_devices_seeded_inbox_takes_the_users_inbox() {
    let server = Server::start();
    let (a, driver_a) = a_triage_inbox_on_the_server(&server).await;
    let b = Device::new(&server, 1);
    b.ensure_inbox();

    let gate = Arc::new(SyncStartGate::default());
    gate.set_binding(VaultBinding::Bound);
    let supervisor = b.supervisor(&gate);
    until("B's first sync ended", || {
        supervisor.status().last_sync_at.is_some()
    })
    .await;
    until("B idle", || {
        supervisor.status().status != SyncStatusValue::Syncing
    })
    .await;
    supervisor.stop().await;

    assert_eq!(b.project_names(), ["Triage"]);
    assert_eq!(b.outbox(), 0, "B queued no Inbox of its own");
    pass(&driver_a).await;
    assert_eq!(a.project_names(), ["Triage"], "nothing of B's reached A");
}

/// Fails every `POST /sync/pull` while `armed`.
struct FailingPulls {
    inner: Arc<dyn Transport>,
    armed: Arc<AtomicBool>,
    failed: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl Transport for FailingPulls {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        if self.armed.load(Ordering::SeqCst)
            && request.method == "POST"
            && request.url.ends_with("/sync/pull")
        {
            self.failed.fetch_add(1, Ordering::SeqCst);
            return Ok(HttpResponse {
                status: 503,
                headers: Default::default(),
                body: Vec::new(),
            });
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

/// #3538: B's metadata pass fails with a 5xx before it fetches the Inbox, and the pass that
/// drains the outbox after a failed first sync runs the seeds. The Inbox the refs pass demoted
/// stays unseeded, so the next first sync still fetches "Triage" over it.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_metadata_pass_does_not_push_the_seeded_inbox() {
    let server = Server::start();
    let (a, driver_a) = a_triage_inbox_on_the_server(&server).await;
    let (armed, failed) = (Arc::new(AtomicBool::new(true)), Arc::default());
    let b = Device::over(&server, 1, |inner| {
        Arc::new(FailingPulls {
            inner,
            armed: Arc::clone(&armed),
            failed: Arc::clone(&failed),
        })
    });
    b.ensure_inbox();

    let gate = Arc::new(SyncStartGate::default());
    gate.set_binding(VaultBinding::Bound);
    let supervisor = b.supervisor(&gate);
    until("B's first sync failed", || {
        supervisor.status().error_category.is_some()
    })
    .await;
    until("B idle", || {
        supervisor.status().status != SyncStatusValue::Syncing
    })
    .await;
    assert!(
        failed.load(Ordering::SeqCst) > 0,
        "the metadata pass hit the 5xx"
    );
    assert_eq!(b.outbox(), 0, "the drain pass queued no Inbox");

    armed.store(false, Ordering::SeqCst);
    let result = supervisor.sync_now().await;
    assert!(result.success, "{result:?}");
    supervisor.stop().await;

    assert_eq!(b.project_names(), ["Triage"]);
    pass(&driver_a).await;
    assert_eq!(a.project_names(), ["Triage"], "nothing of B's reached A");
}

/// A tag mint is an unclocked seed too (`tag_mint::define_used`): B mints `work` while A's red
/// `work` is on the server, B's metadata pass fails before it fetches A's, and the drain pass
/// runs the seeds. The demoted mint stays unseeded, so A's colour survives on both devices.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_metadata_pass_does_not_push_a_demoted_tag_mint() {
    let server = Server::start();
    let a = Device::new(&server, 0);
    let device_a = server.devices[0]["deviceId"].as_str().unwrap().to_owned();
    a.core
        .db_handle()
        .call_blocking(move |conn| tag_admin::set_color(conn, "work", "red", &device_a, 1_000))
        .unwrap();
    let driver_a = a.driver().await;
    pass(&driver_a).await;
    assert_eq!(a.outbox(), 0, "A pushed its red tag");

    let (armed, failed) = (Arc::new(AtomicBool::new(true)), Arc::default());
    let b = Device::over(&server, 1, |inner| {
        Arc::new(FailingPulls {
            inner,
            armed: Arc::clone(&armed),
            failed: Arc::clone(&failed),
        })
    });
    let minted = b
        .core
        .db_handle()
        .call_blocking(|conn| tag_mint::define_used(conn, &["work".to_owned()], 1_000))
        .unwrap();
    assert_eq!(minted, 1);

    let gate = Arc::new(SyncStartGate::default());
    gate.set_binding(VaultBinding::Bound);
    let supervisor = b.supervisor(&gate);
    until("B's first sync failed", || {
        supervisor.status().error_category.is_some()
    })
    .await;
    until("B idle", || {
        supervisor.status().status != SyncStatusValue::Syncing
    })
    .await;
    assert!(
        failed.load(Ordering::SeqCst) > 0,
        "the metadata pass hit the 5xx"
    );
    assert_eq!(
        b.count(
            "SELECT COUNT(*) FROM sync_items WHERE item_type = 'tag_definition'
               AND clock IS NOT NULL AND signer_device_id IS NULL"
        ),
        0,
        "no mint was clocked"
    );

    armed.store(false, Ordering::SeqCst);
    let result = supervisor.sync_now().await;
    assert!(result.success, "{result:?}");
    supervisor.stop().await;

    pass(&driver_a).await;
    for device in [&a, &b] {
        let color = device
            .core
            .db_handle()
            .call_blocking(|conn| tag_admin::definitions(conn))
            .unwrap()["work"]
            .color
            .clone();
        assert_eq!(color, "red");
    }
}

/// Polls `done` every 50 ms, for at most two minutes: a first sync that fails waits out the
/// pull's whole 5xx retry ladder (14 s) in real time, beside the other tests' Workers.
async fn until(what: &str, mut done: impl FnMut() -> bool) {
    for _ in 0..2_400 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("{what} never happened");
}
