//! The pull gate's view of the session's sync (`readwise::sync_view`) over a real session and a
//! real supervisor whose driver never opens.
//!
//! | Test                                                                 | Electron                   |
//! | -------------------------------------------------------------------- | -------------------------- |
//! | the settings outbox reads from a run thread; no supervisor is queued | `pull-gate.ts` `readPullEnv` |

use memry_core::api::errors::SyncError;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::sync::driver::ApplyObserver;
use memry_desktop::readwise::claim::write_claim;
use memry_desktop::readwise::pull_gate::SyncView;
use memry_desktop::readwise::sync_view::SessionSyncView;
use memry_desktop::session::{OpenVault, SupervisorFactory};
use memry_desktop::sync::backend::{SyncBackend, SyncPasses};
use memry_desktop::sync::gate::{AuthFacts, SyncStartGate, VaultBinding};
use memry_desktop::sync::signals::AuthSignals;
use memry_desktop::sync::supervisor::{SupervisorParts, SyncSupervisor};

use super::gate::{settings, two_books};
use super::*;

struct NeverOpens;

#[async_trait::async_trait]
impl SyncBackend for NeverOpens {
    async fn auth_facts(&self) -> AuthFacts {
        AuthFacts {
            signed_in: true,
            key_verified: true,
            recovery_confirmed: true,
            keychain_unavailable: false,
        }
    }
    async fn open(
        &self,
        _observers: Vec<Arc<dyn ApplyObserver>>,
    ) -> Result<Arc<dyn SyncPasses>, SyncError> {
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

/// `settings_queued` blocks on the supervisor's outbox read from the run's own thread, as a run
/// calls it; with no supervisor the claim is not known to be delivered.
#[test]
fn the_settings_outbox_reads_from_a_run_thread_and_no_supervisor_reads_as_queued() {
    let v = vault(&[], two_books());
    let session = v.e.session.clone();
    let runtime = v.library.runtime.clone();
    let none = || None;
    let view = SessionSyncView::new(
        session.clone(),
        NoteIndex::new(v.e.tier.clone(), |_| {}, |_| {}, |_| {}),
        runtime.clone(),
        Arc::new(none),
        Arc::new(none),
    );
    assert!(view.settings_queued(), "no supervisor: not known delivered");

    let gate = Arc::new(SyncStartGate::default());
    gate.set_binding(VaultBinding::Bound);
    let handle = runtime.clone();
    let factory: SupervisorFactory = Arc::new(move |open: &OpenVault, signals: &AuthSignals| {
        Some(SyncSupervisor::start(
            &handle,
            SupervisorParts {
                backend: Arc::new(NeverOpens),
                gate: Arc::clone(&gate),
                reachability: Arc::new(Online),
                power: None,
                keychain_recovered: None,
                db: open.vault.db_handle(),
                telemetry: None,
                signals: signals.clone(),
                on_status: Arc::new(|_| {}),
                on_event: Arc::new(|_| {}),
            },
        ))
    });
    session.attach_sync(factory);
    assert!(session.sync_supervisor().is_some());
    assert!(!view.settings_queued(), "an empty outbox");

    write_claim(&settings(&v), "dev-a", Some("Desk Mac")).unwrap();
    assert!(view.settings_queued(), "the claim waits in the outbox");
    session.detach_sync();
}
