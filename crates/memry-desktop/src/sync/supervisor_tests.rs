//! The supervisor on a paused tokio clock, over a fake driver and a real `data.db`.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_core::api::errors::{ApiError, SyncError};
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::storage::{Db, open_data};
use memry_core::sync::engine::PassReport;
use memry_core::sync::pause;
use memry_core::sync::policy::ServerClock;
use memry_core::sync::pull::PullReport;
use memry_core::sync::state::{PassTrigger, SyncState};
use tokio::time::{Instant, sleep};

use super::super::backend::{SyncBackend, SyncPasses};
use super::super::gate::{AuthFacts, Entitlement, SyncStartGate, VaultBinding};
use super::super::result::SyncNowBlockedReason;
use super::super::status::{SyncStatus, SyncStatusValue};
use super::{SupervisorParts, SyncSupervisor};
use crate::session::lock;

/// One pass takes this long on the fake, so a request can land while it runs.
const PASS: Duration = Duration::from_millis(50);

#[derive(Default)]
struct FakeDriver {
    passes: Mutex<Vec<PassTrigger>>,
    paused: AtomicBool,
    entitled: Mutex<Option<bool>>,
    /// Errors the next passes fail with, in order.
    errors: Mutex<Vec<SyncError>>,
    clock: Mutex<Option<ServerClock>>,
}

impl FakeDriver {
    fn passes(&self) -> usize {
        lock(&self.passes).len()
    }
}

#[async_trait::async_trait]
impl SyncPasses for FakeDriver {
    async fn run_pass(&self, trigger: PassTrigger) -> Option<PassReport> {
        if self.paused.load(Ordering::SeqCst) {
            return None;
        }
        lock(&self.passes).push(trigger);
        tokio::time::sleep(PASS).await;
        let error = {
            let mut errors = lock(&self.errors);
            (!errors.is_empty()).then(|| errors.remove(0))
        };
        let failed = error.is_some();
        Some(PassReport {
            trigger,
            transitions: vec![SyncState::Pulling, SyncState::Applying, SyncState::Idle],
            final_state: if failed {
                SyncState::Failed
            } else {
                SyncState::Idle
            },
            pull: PullReport::default(),
            parked: false,
            pushed: false,
            error,
        })
    }
    fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
    }
    fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
    }
    fn set_entitled(&self, entitled: bool) {
        *lock(&self.entitled) = Some(entitled);
    }
    fn server_clock(&self) -> Option<ServerClock> {
        *lock(&self.clock)
    }
}

struct FakeBackend {
    driver: Arc<FakeDriver>,
    signed_in: AtomicBool,
    opens: AtomicUsize,
    closes: AtomicUsize,
}

#[async_trait::async_trait]
impl SyncBackend for FakeBackend {
    fn auth_facts(&self) -> AuthFacts {
        AuthFacts {
            signed_in: self.signed_in.load(Ordering::SeqCst),
            key_verified: true,
            recovery_confirmed: true,
        }
    }
    async fn open(&self) -> Result<Arc<dyn SyncPasses>, SyncError> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        // A new `SyncDriver` starts unpaused.
        self.driver.paused.store(false, Ordering::SeqCst);
        Ok(Arc::clone(&self.driver) as Arc<dyn SyncPasses>)
    }
    fn close(&self) {
        self.closes.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct Net {
    observers: Mutex<Vec<Arc<dyn ReachabilityObserver>>>,
    offline: AtomicBool,
}

impl Net {
    fn set(&self, reachable: Reachable) {
        self.offline
            .store(reachable == Reachable::Offline, Ordering::SeqCst);
        for observer in lock(&self.observers).iter() {
            observer.on_change(reachable);
        }
    }
}

impl Reachability for Net {
    fn current(&self) -> Reachable {
        if self.offline.load(Ordering::SeqCst) {
            Reachable::Offline
        } else {
            Reachable::Wifi
        }
    }
    fn observe(&self, observer: Arc<dyn ReachabilityObserver>) {
        lock(&self.observers).push(observer);
    }
}

struct Rig {
    _dir: tempfile::TempDir,
    db: Db,
    backend: Arc<FakeBackend>,
    gate: Arc<SyncStartGate>,
    net: Arc<Net>,
    events: Arc<Mutex<Vec<(Instant, SyncStatus)>>>,
}

impl Rig {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = open_data(&dir.path().join("data.db")).unwrap();
        let gate = Arc::new(SyncStartGate::default());
        gate.set_binding(VaultBinding::Bound);
        gate.set_entitlement(Entitlement::Entitled);
        Self {
            _dir: dir,
            db,
            backend: Arc::new(FakeBackend {
                driver: Arc::default(),
                signed_in: AtomicBool::new(true),
                opens: AtomicUsize::new(0),
                closes: AtomicUsize::new(0),
            }),
            gate,
            net: Arc::default(),
            events: Arc::default(),
        }
    }

    async fn start(&self) -> SyncSupervisor {
        let events = Arc::clone(&self.events);
        let supervisor = SyncSupervisor::start(SupervisorParts {
            backend: Arc::clone(&self.backend) as Arc<dyn SyncBackend>,
            gate: Arc::clone(&self.gate),
            reachability: Arc::clone(&self.net) as Arc<dyn Reachability>,
            power: None,
            db: self.db.clone(),
            on_status: Arc::new(move |status| {
                lock(&events).push((Instant::now(), status.clone()));
            }),
        })
        .await
        .unwrap();
        settle().await;
        supervisor
    }

    fn passes(&self) -> usize {
        self.backend.driver.passes()
    }
}

/// Lets the loop and a pass run to completion. A virtual sleep, not `advance`: the paused clock
/// does not move while the pass's `spawn_blocking` read runs, so the pass finishes first.
async fn settle() {
    for _ in 0..4 {
        sleep(PASS).await;
    }
}

#[tokio::test(start_paused = true)]
async fn the_gate_decides_whether_a_pass_runs_and_a_change_starts_one() {
    let rig = Rig::new();
    rig.gate.set_binding(VaultBinding::Unknown);
    let supervisor = rig.start().await;
    assert_eq!(rig.passes(), 0, "an unknown binding waits");
    assert_eq!(supervisor.status().status, SyncStatusValue::Idle);

    rig.gate.set_binding(VaultBinding::Bound);
    settle().await;
    assert_eq!(rig.passes(), 1, "binding the vault starts sync");
    assert_eq!(rig.backend.opens.load(Ordering::SeqCst), 1);
    assert_eq!(*lock(&rig.backend.driver.entitled), Some(true));

    rig.gate.set_entitlement(Entitlement::Unentitled);
    settle().await;
    assert_eq!(
        rig.backend.closes.load(Ordering::SeqCst),
        1,
        "the driver is closed"
    );
    assert_eq!(supervisor.status().status, SyncStatusValue::LocalOnly);
}

#[tokio::test(start_paused = true)]
async fn pushes_debounce_and_a_request_during_a_pass_queues_one_trailing_pass() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    assert_eq!(rig.passes(), 1, "the start pass");

    for _ in 0..3 {
        supervisor.request_push();
        tokio::task::yield_now().await;
        sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(rig.passes(), 1, "still inside 300 ms of the last request");
    sleep(Duration::from_millis(250)).await;
    tokio::task::yield_now().await;
    assert_eq!(rig.passes(), 2, "one pass for three requests");

    // The pass is running: two requests queue exactly one trailing pass.
    supervisor.foreground();
    supervisor.foreground();
    settle().await;
    settle().await;
    assert_eq!(rig.passes(), 3);
}

#[tokio::test(start_paused = true)]
async fn a_tick_pulls_only_when_the_socket_did_not_stay_connected() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    assert_eq!(rig.passes(), 1);

    sleep(Duration::from_secs(60)).await;
    settle().await;
    assert_eq!(rig.passes(), 2, "no socket: every tick pulls");

    supervisor.note_socket(1, true);
    sleep(Duration::from_secs(60)).await;
    settle().await;
    assert_eq!(
        rig.passes(),
        3,
        "the socket connected during this tick's window"
    );
    for _ in 0..4 {
        sleep(Duration::from_secs(60)).await;
        settle().await;
    }
    assert_eq!(rig.passes(), 3, "a held socket keeps the ticks quiet");
    sleep(Duration::from_secs(60)).await;
    settle().await;
    assert_eq!(rig.passes(), 4, "five minutes since the last pull");

    supervisor.note_socket(1, false);
    sleep(Duration::from_secs(60)).await;
    settle().await;
    assert_eq!(rig.passes(), 5, "the socket dropped");
}

#[tokio::test(start_paused = true)]
async fn a_429_backs_off_and_sync_now_says_when_it_resumes() {
    let rig = Rig::new();
    lock(&rig.backend.driver.errors).push(SyncError::Api {
        source: ApiError::RateLimited {
            retry_after_s: None,
            message: "slow down".into(),
        },
    });
    let supervisor = rig.start().await;
    assert_eq!(rig.passes(), 1);
    let status = supervisor.status();
    assert_eq!(status.status, SyncStatusValue::Error);
    assert_eq!(
        status.error_category,
        Some(super::super::error_category::SyncErrorCategory::RateLimited)
    );

    let refused = supervisor.sync_now().await;
    assert_eq!(refused.reason, Some(SyncNowBlockedReason::Failed));
    assert!(
        refused
            .error
            .as_deref()
            .is_some_and(|e| e.starts_with("Rate limited. Resuming in ")),
        "{refused:?}"
    );
    supervisor.request_push();
    settle().await;
    assert_eq!(rig.passes(), 1, "inside the 5 s window nothing runs");

    sleep(Duration::from_secs(5)).await;
    let ran = supervisor.sync_now();
    let (ran, ()) = tokio::join!(ran, settle());
    assert!(ran.success, "{ran:?}");
    assert_eq!(rig.passes(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_pause_is_persisted_survives_a_reopen_and_sync_now_ends_it() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    supervisor.set_paused(true).await.unwrap();
    assert!(rig.db.read_blocking(pause::read).unwrap());
    supervisor.stop().await;

    let reopened = rig.start().await;
    let passes = rig.passes();
    reopened.request_push();
    sleep(Duration::from_secs(61)).await;
    settle().await;
    assert_eq!(rig.passes(), passes, "paused across the reopen");
    assert_eq!(reopened.status().status, SyncStatusValue::Paused);

    let (result, ()) = tokio::join!(reopened.sync_now(), settle());
    assert!(result.success, "{result:?}");
    assert!(!rig.db.read_blocking(pause::read).unwrap());
    assert_eq!(rig.passes(), passes + 1);
}

#[tokio::test(start_paused = true)]
async fn clock_skew_past_five_minutes_pauses_sync_and_persists_it() {
    let rig = Rig::new();
    *lock(&rig.backend.driver.clock) = Some(ServerClock {
        server_ms: 1_000_000,
        local_ms: 1_000_000 + 300_001,
    });
    let supervisor = rig.start().await;
    assert_eq!(supervisor.status().status, SyncStatusValue::Paused);
    assert!(rig.db.read_blocking(pause::read).unwrap());
    assert!(rig.backend.driver.paused.load(Ordering::SeqCst));

    let rig = Rig::new();
    *lock(&rig.backend.driver.clock) = Some(ServerClock {
        server_ms: 1_000_000,
        local_ms: 1_000_000 - 300_000,
    });
    let supervisor = rig.start().await;
    assert_eq!(
        supervisor.status().status,
        SyncStatusValue::Idle,
        "exactly 300 s is fine"
    );
}

#[tokio::test(start_paused = true)]
async fn sync_now_names_why_it_did_nothing() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    rig.net.set(Reachable::Offline);
    settle().await;
    assert_eq!(supervisor.status().status, SyncStatusValue::Offline);
    let offline = supervisor.sync_now().await;
    assert_eq!(offline.reason, Some(SyncNowBlockedReason::Offline));

    rig.net.set(Reachable::Wifi);
    settle().await;
    rig.gate.set_binding(VaultBinding::Foreign);
    settle().await;
    let gated = supervisor.sync_now().await;
    assert_eq!(gated.reason, Some(SyncNowBlockedReason::Unavailable));

    rig.backend.signed_in.store(false, Ordering::SeqCst);
    let signed_out = supervisor.sync_now().await;
    assert_eq!(signed_out.reason, Some(SyncNowBlockedReason::SignedOut));
}

#[tokio::test(start_paused = true)]
async fn status_events_are_throttled_to_one_per_100_ms_and_the_latest_wins() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    for _ in 0..5 {
        rig.net.set(Reachable::Offline);
        tokio::task::yield_now().await;
        rig.net.set(Reachable::Wifi);
        tokio::task::yield_now().await;
    }
    settle().await;
    settle().await;
    let events = lock(&rig.events).clone();
    for pair in events.windows(2) {
        assert!(
            pair[1].0 - pair[0].0 >= Duration::from_millis(100),
            "two events {:?} apart",
            pair[1].0 - pair[0].0
        );
    }
    assert_eq!(
        events.last().unwrap().1,
        supervisor.status(),
        "the latest status is emitted"
    );
}

#[tokio::test(start_paused = true)]
async fn stop_aborts_the_running_pass_and_closes_the_driver() {
    let rig = Rig::new();
    let supervisor = rig.start().await;
    supervisor.foreground();
    tokio::task::yield_now().await;
    supervisor.stop().await;
    assert_eq!(rig.backend.closes.load(Ordering::SeqCst), 1);
    let after = supervisor.sync_now().await;
    assert_eq!(after.reason, Some(SyncNowBlockedReason::Unavailable));
}
