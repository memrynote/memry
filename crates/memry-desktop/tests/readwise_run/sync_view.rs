//! The pull gate's view of the session's sync (`readwise::sync_view`) over a real session and a
//! real supervisor whose driver never opens.
//!
//! | Test                                                                 | Electron                   |
//! | -------------------------------------------------------------------- | -------------------------- |
//! | the settings outbox reads from a run thread; no supervisor is queued | `pull-gate.ts` `readPullEnv` |
//! | signed out with no supervisor is decided and pulls with no claim     | `session-teardown.ts:59`, `pull-gate.ts:52-54` |

use memry_core::api::errors::SyncError;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::sync::driver::ApplyObserver;
use memry_desktop::readwise::claim::Claim;
use memry_desktop::readwise::claim::write_claim;
use memry_desktop::readwise::pull_gate::{Authority, SyncView, authority};
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

fn supervisor_factory(
    runtime: &tokio::runtime::Handle,
    binding: VaultBinding,
) -> SupervisorFactory {
    let gate = Arc::new(SyncStartGate::default());
    gate.set_binding(binding);
    let handle = runtime.clone();
    Arc::new(move |open: &OpenVault, signals: &AuthSignals| {
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
    })
}

fn view(v: &Vault, signed_in: bool) -> SessionSyncView {
    let none = || None;
    SessionSyncView::new(
        v.e.session.clone(),
        NoteIndex::new(v.e.tier.clone(), |_| {}, |_| {}, |_| {}),
        v.library.runtime.clone(),
        Arc::new(none),
        Arc::new(none),
        Arc::new(move || signed_in),
    )
}

/// `settings_queued` blocks on the supervisor's outbox read from the run's own thread, as a run
/// calls it; with no supervisor the claim is not known to be delivered.
#[test]
fn the_settings_outbox_reads_from_a_run_thread_and_no_supervisor_reads_as_queued() {
    let v = vault(&[], two_books());
    let session = v.e.session.clone();
    let view = view(&v, true);
    assert!(view.settings_queued(), "no supervisor: not known delivered");

    session.attach_sync(supervisor_factory(&v.library.runtime, VaultBinding::Bound));
    assert!(session.sync_supervisor().is_some());
    assert!(!view.settings_queued(), "an empty outbox");

    write_claim(&settings(&v), "dev-a", Some("Desk Mac")).unwrap();
    assert!(view.settings_queued(), "the claim waits in the outbox");
    session.detach_sync();
}

/// Signed out there is no supervisor. Electron's sign-out calls `markSyncIneligible`, so the
/// install is decided, does not sync, and Readwise pulls with no claim. Signed in with no
/// supervisor yet (before the launch attach) is still no verdict.
#[test]
fn signed_out_with_no_supervisor_is_decided_and_pulls_with_no_claim() {
    let v = vault(&[], two_books());
    let claim = Claim::read(&v.library.store()).unwrap();

    let env = view(&v, false).env();
    assert!(env.decided && !env.eligible, "signed out: {env:?}");
    assert_eq!(authority(&env, &claim), Authority::Pull);

    let env = view(&v, true).env();
    assert!(!env.decided, "signed in, sync not attached yet: {env:?}");
}
