//! The sync supervisor's place in the session: one per open vault, built after the open
//! (`OpenStage::SyncStart`) and stopped on close, so a vault switch rebuilds it.
//!
//! Hooks cannot be unregistered, so the open and close hooks are registered once, on the first
//! [`Session::attach_sync`], and both read the slot: after [`Session::detach_sync`] they do
//! nothing.

use std::sync::{Arc, Weak};

use tokio::sync::broadcast;

use super::{Inner, OpenStage, OpenVault, Session, lock};
use crate::sync::signals::{AuthSignal, AuthSignals};
use crate::sync::supervisor::SyncSupervisor;

/// Builds the supervisor of a vault that just opened, or `None` when it cannot sync at all. The
/// supervisor sends on the session's hub it is given (`SupervisorParts.signals`).
pub type SupervisorFactory =
    Arc<dyn Fn(&OpenVault, &AuthSignals) -> Option<SyncSupervisor> + Send + Sync>;

pub(super) struct SyncSlot {
    factory: Option<SupervisorFactory>,
    running: Option<SyncSupervisor>,
    hooked: bool,
    /// The one account-signal hub of this session, for every supervisor it builds.
    signals: AuthSignals,
}

impl Default for SyncSlot {
    fn default() -> Self {
        Self {
            factory: None,
            running: None,
            hooked: false,
            signals: AuthSignals::new(),
        }
    }
}

impl Session {
    /// The account signals of every supervisor this session builds, now and after a vault
    /// switch. Subscribe before [`Self::attach_sync`] to hear the first one.
    pub fn subscribe_auth_signals(&self) -> broadcast::Receiver<AuthSignal> {
        lock(&self.inner.sync).signals.subscribe()
    }

    /// Runs a supervisor for every vault opened from now on, and for the one open now. Queued
    /// behind a running open, close or switch, like they are; never call it from a session hook.
    pub fn attach_sync(&self, factory: SupervisorFactory) {
        let _queue = lock(&self.inner.lifecycle);
        let first = {
            let mut slot = lock(&self.inner.sync);
            slot.factory = Some(factory);
            !std::mem::replace(&mut slot.hooked, true)
        };
        if first {
            let weak = Arc::downgrade(&self.inner);
            self.on_open(
                "sync-start",
                OpenStage::SyncStart,
                Arc::new(move |open| {
                    if let Some(session) = upgrade(&weak) {
                        session.start_sync(open);
                    }
                    Ok(())
                }),
            );
            let weak = Arc::downgrade(&self.inner);
            self.on_close(
                "sync-stop",
                Arc::new(move |_| {
                    if let Some(session) = upgrade(&weak) {
                        session.stop_sync();
                    }
                }),
            );
        }
        if let Some(open) = self.current() {
            self.start_sync(&open);
        }
    }

    /// Stops the running supervisor and builds no more.
    pub fn detach_sync(&self) {
        let _queue = lock(&self.inner.lifecycle);
        lock(&self.inner.sync).factory = None;
        self.stop_sync();
    }

    /// The open vault's supervisor.
    pub fn sync_supervisor(&self) -> Option<SyncSupervisor> {
        lock(&self.inner.sync).running.clone()
    }

    fn start_sync(&self, open: &OpenVault) {
        let (factory, signals) = {
            let slot = lock(&self.inner.sync);
            let Some(factory) = slot.factory.clone() else {
                return;
            };
            (factory, slot.signals.clone())
        };
        self.stop_sync();
        let supervisor = factory(open, &signals);
        // Swapped, not stored: whatever got in meanwhile is stopped, never left running.
        let replaced = std::mem::replace(&mut lock(&self.inner.sync).running, supervisor);
        if let Some(replaced) = replaced {
            let _ = replaced.stop_blocking();
        }
    }

    fn stop_sync(&self) {
        let running = lock(&self.inner.sync).running.take();
        if let Some(supervisor) = running {
            let _ = supervisor.stop_blocking();
        }
    }
}

fn upgrade(weak: &Weak<Inner>) -> Option<Session> {
    weak.upgrade().map(|inner| Session { inner })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use memry_core::api::errors::SyncError;
    use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};

    use super::super::OpenSource;
    use super::super::fixture::fixture;
    use super::*;
    use crate::sync::backend::{SyncBackend, SyncPasses};
    use crate::sync::gate::{AuthFacts, SyncStartGate, VaultBinding};
    use crate::sync::result::SyncNowBlockedReason;
    use crate::sync::supervisor::SupervisorParts;

    struct NeverStarts;

    #[async_trait::async_trait]
    impl SyncBackend for NeverStarts {
        async fn auth_facts(&self) -> AuthFacts {
            AuthFacts {
                signed_in: true,
                key_verified: true,
                recovery_confirmed: true,
                keychain_unavailable: false,
            }
        }
        async fn open(&self) -> Result<Arc<dyn SyncPasses>, SyncError> {
            Err(SyncError::Locked)
        }
        fn refresh_refused(&self) -> bool {
            false
        }
        fn close(&self) {}
    }

    struct Online;

    impl Reachability for Online {
        fn current(&self) -> Reachable {
            Reachable::Wifi
        }
        fn observe(&self, _observer: Arc<dyn ReachabilityObserver>) {}
    }

    /// Open builds a supervisor, a switch stops it and builds the next one, detach stops it and
    /// builds no more.
    #[test]
    fn a_supervisor_follows_the_open_vault() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let handle = runtime.handle().clone();
        let f = fixture();
        let built = Arc::new(AtomicUsize::new(0));
        let paths = Arc::new(Mutex::new(Vec::new()));
        let gate = Arc::new(SyncStartGate::default());
        gate.set_binding(VaultBinding::Bound);
        let factory: SupervisorFactory = {
            let built = Arc::clone(&built);
            let paths = Arc::clone(&paths);
            Arc::new(move |open: &OpenVault, signals: &AuthSignals| {
                built.fetch_add(1, Ordering::SeqCst);
                lock(&paths).push(open.path.clone());
                Some(SyncSupervisor::start(
                    &handle,
                    SupervisorParts {
                        backend: Arc::new(NeverStarts),
                        gate: Arc::clone(&gate),
                        reachability: Arc::new(Online),
                        power: None,
                        keychain_recovered: None,
                        db: open.vault.db_handle(),
                        telemetry: None,
                        observers: Vec::new(),
                        signals: signals.clone(),
                        on_status: Arc::new(|_| {}),
                    },
                ))
            })
        };
        let first = f.vault("first");
        f.session.open(&first, OpenSource::Select).unwrap();
        f.session.attach_sync(Arc::clone(&factory));
        assert_eq!(
            built.load(Ordering::SeqCst),
            1,
            "the vault open now gets one"
        );
        let before = f.session.sync_supervisor().expect("running");
        let running = runtime.block_on(before.sync_now());
        assert_eq!(
            running.reason,
            Some(SyncNowBlockedReason::Failed),
            "{running:?}"
        );

        let second = f.vault("second");
        f.session.switch(&second).unwrap();
        assert_eq!(built.load(Ordering::SeqCst), 2);
        let stopped = runtime.block_on(before.sync_now());
        assert_eq!(stopped.reason, Some(SyncNowBlockedReason::Unavailable));

        f.session.detach_sync();
        assert!(f.session.sync_supervisor().is_none());
        f.session.switch(&first).unwrap();
        assert_eq!(
            built.load(Ordering::SeqCst),
            2,
            "detached: nothing more is built"
        );
        assert_eq!(lock(&paths).len(), 2);
    }

    /// Keeps every observer, as `DesktopReachability` does.
    #[derive(Default)]
    struct Keeps(Mutex<Vec<Arc<dyn ReachabilityObserver>>>);

    impl Reachability for Keeps {
        fn current(&self) -> Reachable {
            Reachable::Wifi
        }
        fn observe(&self, observer: Arc<dyn ReachabilityObserver>) {
            lock(&self.0).push(observer);
        }
    }

    /// Two attaches racing each other leave one loop on the vault, not one per caller.
    #[test]
    fn racing_attaches_leave_one_running_loop() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let handle = runtime.handle().clone();
        let f = fixture();
        let gate = Arc::new(SyncStartGate::default());
        let reachability = Arc::new(Keeps::default());
        let factory: SupervisorFactory = {
            let gate = Arc::clone(&gate);
            Arc::new(move |open: &OpenVault, signals: &AuthSignals| {
                // Widens the window between the check and the store.
                std::thread::sleep(std::time::Duration::from_millis(20));
                Some(SyncSupervisor::start(
                    &handle,
                    SupervisorParts {
                        backend: Arc::new(NeverStarts),
                        gate: Arc::clone(&gate),
                        reachability: Arc::clone(&reachability) as Arc<dyn Reachability>,
                        power: None,
                        keychain_recovered: None,
                        db: open.vault.db_handle(),
                        telemetry: None,
                        observers: Vec::new(),
                        signals: signals.clone(),
                        on_status: Arc::new(|_| {}),
                    },
                ))
            })
        };
        // The test and the factory hold the gate; each running loop holds one more.
        let idle = Arc::strong_count(&gate);
        f.session
            .open(&f.vault("only"), OpenSource::Select)
            .unwrap();
        std::thread::scope(|scope| {
            for _ in 0..2 {
                let session = f.session.clone();
                let factory = Arc::clone(&factory);
                scope.spawn(move || session.attach_sync(factory));
            }
        });
        // Stopped loops let go of the gate a moment after they answer the stop.
        for _ in 0..500 {
            if Arc::strong_count(&gate) <= idle + 1 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(Arc::strong_count(&gate) - idle, 1, "one loop runs");
        f.session.detach_sync();
    }

    /// VERIFY-4728 Low 2: the session owns the one hub, so a subscriber taken before the attach
    /// hears the supervisor a vault switch builds, not only the first.
    #[test]
    fn one_subscriber_hears_every_supervisor_the_session_builds() {
        let f = fixture();
        let mut signals = f.session.subscribe_auth_signals();
        let factory: SupervisorFactory = Arc::new(|open: &OpenVault, hub: &AuthSignals| {
            hub.send(AuthSignal::LinkingApproved {
                session_id: open.path.display().to_string(),
            });
            None
        });
        let first = f.vault("first");
        let second = f.vault("second");
        f.session.attach_sync(factory);
        f.session.open(&first, OpenSource::Select).unwrap();
        f.session.switch(&second).unwrap();
        let mut heard = Vec::new();
        while let Ok(AuthSignal::LinkingApproved { session_id }) = signals.try_recv() {
            heard.push(session_id);
        }
        assert_eq!(heard.len(), 2, "{heard:?}");
        assert!(heard[1].ends_with("second"), "{heard:?}");
    }
}
