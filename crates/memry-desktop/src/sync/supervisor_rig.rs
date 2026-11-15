//! The supervisor's test rig: a fake driver, socket and backend over a real `data.db`, run on a
//! paused tokio clock.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_core::api::errors::SyncError;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::storage::{Db, open_data};
use memry_core::sync::engine::PassReport;
use memry_core::sync::policy::ServerClock;
use memry_core::sync::pull::PullReport;
use memry_core::sync::socket::HintSink;
use memry_core::sync::socket_run::TerminalLatch;
use memry_core::sync::state::{PassTrigger, SyncState};
use tokio::sync::broadcast;
use tokio::time::{Instant, sleep};

use super::super::backend::{SyncBackend, SyncPasses};
use super::super::gate::{AuthFacts, Entitlement, SyncStartGate, VaultBinding};
use super::super::realtime::{RealtimeSocket, SocketEnd};
use super::super::signals::AuthSignals;
use super::super::status::SyncStatus;
use super::{SupervisorParts, SyncSupervisor};
pub(crate) use crate::session::lock;

/// One pass takes this long on the fake, so a request can land while it runs.
pub(crate) const PASS: Duration = Duration::from_millis(50);

#[derive(Default)]
pub(crate) struct FakeDriver {
    pub(crate) passes: Mutex<Vec<PassTrigger>>,
    /// When each pass started.
    pub(crate) starts: Mutex<Vec<Instant>>,
    pub(crate) paused: AtomicBool,
    pub(crate) entitled: Mutex<Option<bool>>,
    /// Errors the next passes fail with, in order.
    pub(crate) errors: Mutex<Vec<SyncError>>,
    /// The last reading, kept across passes as `PolicyTier` keeps it.
    pub(crate) clock: Mutex<Option<ServerClock>>,
    /// A pass reads the server clock this far behind the local one, as a status poll does.
    pub(crate) skew_ms: Mutex<Option<i64>>,
    /// Passes end `Refused` with no error, as a non-envelope pull body does.
    pub(crate) refuse: AtomicBool,
    /// The next pass panics.
    pub(crate) panic_next: AtomicBool,
    /// Sockets end at once with this; `None` holds them quietly until stopped.
    pub(crate) socket_end: Mutex<Option<SocketEnd>>,
    /// Sockets opened.
    pub(crate) sockets: AtomicUsize,
    /// Sockets running now, and stops asked of them.
    pub(crate) live: Arc<AtomicUsize>,
    pub(crate) socket_stops: Arc<AtomicUsize>,
    /// Passes that ran to their end, not aborted.
    pub(crate) finished: AtomicUsize,
    pub(crate) observers: Mutex<Vec<Arc<dyn memry_core::sync::driver::ApplyObserver>>>,
}

impl FakeDriver {
    pub(crate) fn passes(&self) -> usize {
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
        lock(&self.starts).push(Instant::now());
        assert!(
            !self.panic_next.swap(false, Ordering::SeqCst),
            "the fake pass panics"
        );
        if let Some(skew) = *lock(&self.skew_ms) {
            let local_ms = super::super::run_loop::now_ms();
            *lock(&self.clock) = Some(ServerClock {
                server_ms: local_ms - skew,
                local_ms,
            });
        }
        tokio::time::sleep(PASS).await;
        let error = {
            let mut errors = lock(&self.errors);
            (!errors.is_empty()).then(|| errors.remove(0))
        };
        self.finished.fetch_add(1, Ordering::SeqCst);
        let failed = error.is_some();
        Some(PassReport {
            trigger,
            transitions: vec![SyncState::Pulling, SyncState::Applying, SyncState::Idle],
            final_state: if failed {
                SyncState::Failed
            } else if self.refuse.load(Ordering::SeqCst) {
                SyncState::Refused
            } else {
                SyncState::Idle
            },
            pull: PullReport::default(),
            parked: false,
            pushed: false,
            pushed_items: 0,
            pull_error: error,
            push_error: None,
        })
    }
    async fn wake(&self, _cursor: Option<i64>) -> Option<PassReport> {
        self.run_pass(PassTrigger::SocketHint).await
    }
    fn realtime(
        &self,
        _sink: Arc<dyn HintSink>,
        _latch: Arc<TerminalLatch>,
        _on_connected: Arc<dyn Fn() + Send + Sync>,
    ) -> Arc<dyn RealtimeSocket> {
        self.sockets.fetch_add(1, Ordering::SeqCst);
        Arc::new(FakeSocket {
            end: *lock(&self.socket_end),
            stopped: tokio::sync::Notify::new(),
            live: Arc::clone(&self.live),
            stops: Arc::clone(&self.socket_stops),
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
    fn observe(&self, observer: Arc<dyn memry_core::sync::driver::ApplyObserver>) {
        lock(&self.observers).push(observer);
    }
}

/// A socket that ends at once with `end`, or never connects and ends only when stopped.
struct FakeSocket {
    end: Option<SocketEnd>,
    stopped: tokio::sync::Notify,
    live: Arc<AtomicUsize>,
    stops: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl RealtimeSocket for FakeSocket {
    async fn run(&self) -> SocketEnd {
        if let Some(end) = self.end {
            return end;
        }
        self.live.fetch_add(1, Ordering::SeqCst);
        self.stopped.notified().await;
        // Closing takes a moment, as a real socket's close does.
        sleep(Duration::from_millis(1)).await;
        self.live.fetch_sub(1, Ordering::SeqCst);
        SocketEnd::Stopped
    }
    fn stop(&self) {
        self.stops.fetch_add(1, Ordering::SeqCst);
        self.stopped.notify_one();
    }
}

pub(crate) struct FakeBackend {
    pub(crate) driver: Arc<FakeDriver>,
    pub(crate) signed_in: AtomicBool,
    /// The gate read never returns, as a keychain access prompt nobody answers.
    pub(crate) stall_facts: AtomicBool,
    /// The keychain does not answer the master-key read.
    pub(crate) keychain_locked: AtomicBool,
    /// When each gate read ran.
    pub(crate) fact_reads: Mutex<Vec<Instant>>,
    /// `open` fails, as it does offline or on an unbound vault: with `open_error`, else `Locked`.
    pub(crate) fail_open: AtomicBool,
    pub(crate) open_error: Mutex<Option<SyncError>>,
    /// The session's token manager says the server refused the refresh token for good.
    pub(crate) refresh_refused: AtomicBool,
    pub(crate) opens: Mutex<Vec<Instant>>,
    pub(crate) closes: AtomicUsize,
}

impl FakeBackend {
    pub(crate) fn opens(&self) -> usize {
        lock(&self.opens).len()
    }
}

#[async_trait::async_trait]
impl SyncBackend for FakeBackend {
    async fn auth_facts(&self) -> AuthFacts {
        lock(&self.fact_reads).push(Instant::now());
        if self.stall_facts.load(Ordering::SeqCst) {
            std::future::pending::<()>().await;
        }
        let locked = self.keychain_locked.load(Ordering::SeqCst);
        AuthFacts {
            signed_in: self.signed_in.load(Ordering::SeqCst),
            key_verified: !locked,
            recovery_confirmed: true,
            keychain_unavailable: locked,
        }
    }
    async fn open(&self) -> Result<Arc<dyn SyncPasses>, SyncError> {
        lock(&self.opens).push(Instant::now());
        if self.fail_open.load(Ordering::SeqCst) {
            return Err(lock(&self.open_error).clone().unwrap_or(SyncError::Locked));
        }
        // A new `SyncDriver` starts unpaused.
        self.driver.paused.store(false, Ordering::SeqCst);
        Ok(Arc::clone(&self.driver) as Arc<dyn SyncPasses>)
    }
    fn refresh_refused(&self) -> bool {
        self.refresh_refused.load(Ordering::SeqCst)
    }
    fn close(&self) {
        self.closes.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
pub(crate) struct Net {
    observers: Mutex<Vec<Arc<dyn ReachabilityObserver>>>,
    offline: AtomicBool,
}

impl Net {
    pub(crate) fn set(&self, reachable: Reachable) {
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

pub(crate) struct Rig {
    _dir: tempfile::TempDir,
    pub(crate) db: Db,
    pub(crate) backend: Arc<FakeBackend>,
    pub(crate) gate: Arc<SyncStartGate>,
    pub(crate) net: Arc<Net>,
    /// `KeyringStore::subscribe_recovered`'s stand-in.
    pub(crate) recovered: broadcast::Sender<()>,
    pub(crate) events: Arc<Mutex<Vec<(Instant, SyncStatus)>>>,
    pub(crate) telemetry: Option<Arc<crate::telemetry::Service>>,
    /// The session's account signals, shared by every supervisor the rig starts.
    pub(crate) signals: AuthSignals,
}

impl Rig {
    pub(crate) fn new() -> Self {
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
                stall_facts: AtomicBool::new(false),
                keychain_locked: AtomicBool::new(false),
                fact_reads: Mutex::default(),
                fail_open: AtomicBool::new(false),
                open_error: Mutex::default(),
                refresh_refused: AtomicBool::new(false),
                opens: Mutex::default(),
                closes: AtomicUsize::new(0),
            }),
            gate,
            net: Arc::default(),
            recovered: broadcast::Sender::new(4),
            events: Arc::default(),
            telemetry: None,
            signals: AuthSignals::default(),
        }
    }

    pub(crate) async fn start(&self) -> SyncSupervisor {
        let events = Arc::clone(&self.events);
        let supervisor = SyncSupervisor::start(
            &tokio::runtime::Handle::current(),
            SupervisorParts {
                backend: Arc::clone(&self.backend) as Arc<dyn SyncBackend>,
                gate: Arc::clone(&self.gate),
                reachability: Arc::clone(&self.net) as Arc<dyn Reachability>,
                power: None,
                keychain_recovered: Some(self.recovered.subscribe()),
                db: self.db.clone(),
                telemetry: self.telemetry.clone(),
                signals: self.signals.clone(),
                on_status: Arc::new(move |status| {
                    lock(&events).push((Instant::now(), status.clone()));
                }),
            },
        );
        settle().await;
        supervisor
    }

    pub(crate) fn passes(&self) -> usize {
        self.backend.driver.passes()
    }

    pub(crate) fn closes(&self) -> usize {
        self.backend.closes.load(Ordering::SeqCst)
    }
}

/// Lets the loop and a pass run to completion. A virtual sleep, not `advance`: the paused clock
/// does not move while the pass's `spawn_blocking` read runs, so the pass finishes first.
pub(crate) async fn settle() {
    for _ in 0..4 {
        sleep(PASS).await;
    }
}
