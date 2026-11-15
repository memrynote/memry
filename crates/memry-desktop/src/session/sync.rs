//! The sync supervisor's place in the session: one per open vault, built after the open
//! (`OpenStage::SyncStart`) and stopped on close, so a vault switch rebuilds it.
//!
//! Hooks cannot be unregistered, so the open and close hooks are registered once, on the first
//! [`Session::attach_sync`], and both read the slot: after [`Session::detach_sync`] they do
//! nothing.

use std::sync::{Arc, Weak};

use super::{Inner, OpenStage, OpenVault, Session, lock};
use crate::sync::supervisor::SyncSupervisor;

/// Builds the supervisor of a vault that just opened, or `None` when it cannot sync at all.
pub type SupervisorFactory = Arc<dyn Fn(&OpenVault) -> Option<SyncSupervisor> + Send + Sync>;

#[derive(Default)]
pub(super) struct SyncSlot {
    factory: Option<SupervisorFactory>,
    running: Option<SyncSupervisor>,
    hooked: bool,
}

impl Session {
    /// Runs a supervisor for every vault opened from now on, and for the one open now.
    pub fn attach_sync(&self, factory: SupervisorFactory) {
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
        lock(&self.inner.sync).factory = None;
        self.stop_sync();
    }

    /// The open vault's supervisor.
    pub fn sync_supervisor(&self) -> Option<SyncSupervisor> {
        lock(&self.inner.sync).running.clone()
    }

    fn start_sync(&self, open: &OpenVault) {
        let Some(factory) = lock(&self.inner.sync).factory.clone() else {
            return;
        };
        self.stop_sync();
        let supervisor = factory(open);
        lock(&self.inner.sync).running = supervisor;
    }

    fn stop_sync(&self) {
        let running = lock(&self.inner.sync).running.take();
        if let Some(supervisor) = running {
            supervisor.stop_blocking();
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
        fn auth_facts(&self) -> AuthFacts {
            AuthFacts {
                signed_in: true,
                key_verified: true,
                recovery_confirmed: true,
            }
        }
        async fn open(&self) -> Result<Arc<dyn SyncPasses>, SyncError> {
            Err(SyncError::Locked)
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
            Arc::new(move |open: &OpenVault| {
                built.fetch_add(1, Ordering::SeqCst);
                lock(&paths).push(open.path.clone());
                Some(SyncSupervisor::start(
                    &handle,
                    SupervisorParts {
                        backend: Arc::new(NeverStarts),
                        gate: Arc::clone(&gate),
                        reachability: Arc::new(Online),
                        power: None,
                        db: open.vault.db_handle(),
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
}
