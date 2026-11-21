//! The open vault's sync, wired to the account: the [`SupervisorFactory`] the shell attaches
//! (`Session::attach_sync`) and the binding each supervisor's gate holds, ported from Electron's
//! runtime start (`sync/runtime.ts:194`) and `vault-account-binding.ts:141-227`.
//!
//! Each vault that opens gets its own gate. A task decides the vault's binding
//! ([`AccountService::apply_open_vault_binding`]), tells the gate, and retries an `Unknown` every
//! [`BINDING_RETRY`] while that gate lives. [`OpenVaultBinding`] holds the latest state next to
//! the gate for the binding commands; with no supervisor it reads `Bound`, Electron's neutral
//! state.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use memry_core::api::search::Search;
use memry_core::api::vault::Vault;
use memry_core::seams::reachability::Reachability;
use memry_core::seams::secure_store::SecureStore;
use tokio::sync::broadcast;

use super::binding::{Applied, BindingChoice, BindingState};
use super::{AccountError, AccountService};
use crate::registry::VaultRegistry;
use crate::session::{OpenVault, SupervisorFactory, lock};
use crate::shell::power::PowerEvent;
use crate::sync::backend::{SyncBackend, VaultSyncBackend, read_auth_facts};
use crate::sync::disk::DiskObserver;
use crate::sync::events::OnSyncEvent;
use crate::sync::gate::{self, GateDecision, SyncNotStartedReason, SyncStartGate};
use crate::sync::signals::AuthSignals;
use crate::sync::status::SyncStatus;
use crate::sync::supervisor::{SupervisorParts, SyncSupervisor};
use crate::telemetry::Service;
use crate::vault::consumer::VaultTier;

/// `BINDING_RETRY_MS`: how long an `Unknown` binding waits before the next check.
pub const BINDING_RETRY: Duration = Duration::from_secs(60);

/// The open vault's binding and the gate it was told to.
#[derive(Default)]
pub struct OpenVaultBinding {
    slot: Mutex<Option<Slot>>,
}

struct Slot {
    gate: Weak<SyncStartGate>,
    /// `None` until the first decision, which is always reported: the vault before may have
    /// been held, and the renderer still shows its binding.
    state: Option<BindingState>,
}

impl OpenVaultBinding {
    /// The binding of the vault sync runs for; `Bound` when none runs (`NEUTRAL_STATE`).
    pub fn state(&self) -> BindingState {
        match lock(&self.slot).as_ref() {
            Some(slot) if slot.gate.strong_count() > 0 => {
                slot.state.clone().unwrap_or(BindingState::Bound)
            }
            _ => BindingState::Bound,
        }
    }

    /// Sets the running supervisor's binding and entitlement as the binding task and billing
    /// would (e2e `e2e_set_gate_inputs`, until Steps 19 and 20 own both). `false` with no
    /// supervisor running.
    pub fn set_gate_inputs(
        &self,
        binding: crate::sync::gate::VaultBinding,
        entitlement: crate::sync::gate::Entitlement,
    ) -> bool {
        let Some(gate) = self.gate() else {
            return false;
        };
        gate.set_binding(binding);
        gate.set_entitlement(entitlement);
        true
    }

    /// The gate of the running supervisor.
    fn gate(&self) -> Option<Arc<SyncStartGate>> {
        lock(&self.slot)
            .as_ref()
            .and_then(|slot| slot.gate.upgrade())
    }

    fn track(&self, gate: &Arc<SyncStartGate>) {
        // Reads as Electron's neutral `Bound` until the first decision, as with no supervisor: a
        // read right after sign-in is not `unknown`.
        *lock(&self.slot) = Some(Slot {
            gate: Arc::downgrade(gate),
            state: None,
        });
    }

    /// Records `state` for `gate` and tells it; `false` when `gate` is no longer the open
    /// vault's or the state did not change.
    fn publish(&self, gate: &Arc<SyncStartGate>, state: &BindingState) -> bool {
        let mut slot = lock(&self.slot);
        let Some(current) = slot
            .as_mut()
            .filter(|s| Weak::ptr_eq(&s.gate, &Arc::downgrade(gate)))
        else {
            return false;
        };
        gate.set_binding(state.gate());
        if current.state.as_ref() == Some(state) {
            return false;
        }
        current.state = Some(state.clone());
        true
    }
}

/// Told each new gate before its supervisor starts.
pub type GateHook = Arc<dyn Fn(&Arc<SyncStartGate>) + Send + Sync>;

/// What a supervisor of the app is built from, beyond the open vault.
pub struct SyncWiring {
    pub runtime: tokio::runtime::Handle,
    pub account: Arc<AccountService>,
    pub registry: VaultRegistry,
    /// The app's keychain store (the device identity store).
    pub store: Arc<dyn SecureStore>,
    pub reachability: Arc<dyn Reachability>,
    pub power: Option<broadcast::Sender<PowerEvent>>,
    /// Fired by `KeyringStore::subscribe_recovered`.
    pub keychain_recovered: broadcast::Sender<()>,
    pub telemetry: Option<Arc<Service>>,
    pub on_status: Arc<dyn Fn(&SyncStatus) + Send + Sync>,
    pub on_event: OnSyncEvent,
    pub bindings: Arc<OpenVaultBinding>,
    /// Each binding change of the open vault (`sync:vault-binding-changed`).
    pub on_binding: Arc<dyn Fn(&BindingState) + Send + Sync>,
    /// A vault directory refresh changed a vault's icon (`vault:list-changed`).
    pub on_vault_list_changed: Arc<dyn Fn() + Send + Sync>,
    /// The vault tier pulled bodies and locks reach the disk through (`sync::disk`); `None` in a
    /// test that serves no vault files.
    pub tier: Option<Arc<VaultTier>>,
    /// Each new gate, before its supervisor starts: billing tells it the plan
    /// (`BillingService::attach_gate`).
    pub on_gate: GateHook,
}

/// The open vault without keeping it open: a closed vault ends the binding task.
struct HeldOpen {
    path: PathBuf,
    vault_id: String,
    name: String,
    vault: Weak<Vault>,
    search: Weak<Search>,
}

impl HeldOpen {
    fn new(open: &OpenVault) -> Self {
        Self {
            path: open.path.clone(),
            vault_id: open.vault_id.clone(),
            name: open.name.clone(),
            vault: Arc::downgrade(&open.vault),
            search: Arc::downgrade(&open.search),
        }
    }

    fn get(&self) -> Option<OpenVault> {
        Some(OpenVault {
            path: self.path.clone(),
            vault_id: self.vault_id.clone(),
            name: self.name.clone(),
            vault: self.vault.upgrade()?,
            search: self.search.upgrade()?,
        })
    }
}

impl SyncWiring {
    /// What the open vault's gate decides now, read off its binding and entitlement and the
    /// account's facts; `Unavailable` with no supervisor (blocking: reads the master key).
    pub fn start_decision(&self) -> GateDecision {
        let Some(gate) = self.bindings.gate() else {
            return GateDecision::NotStarted(SyncNotStartedReason::Unavailable);
        };
        let (signed_in, recovery_confirmed) = self.account.sync_facts();
        let facts = read_auth_facts(signed_in, recovery_confirmed, self.store.as_ref());
        gate::evaluate(&gate.inputs(facts))
    }

    /// The factory `Session::attach_sync` takes.
    pub fn factory(self: Arc<Self>) -> SupervisorFactory {
        Arc::new(move |open: &OpenVault, signals: &AuthSignals| Some(self.start(open, signals)))
    }

    fn start(self: &Arc<Self>, open: &OpenVault, signals: &AuthSignals) -> SyncSupervisor {
        let gate = Arc::new(SyncStartGate::default());
        self.bindings.track(&gate);
        (self.on_gate)(&gate);
        let account = Arc::clone(&self.account);
        let backend = VaultSyncBackend::new(
            Arc::clone(&open.vault),
            account.shared_session(),
            Arc::clone(&self.store),
            Arc::clone(&self.reachability),
            Vec::new(),
            Arc::new(move || account.sync_facts()),
            self.account.at_rest_keys(),
        )
        .with_vault_root(open.path.clone());
        let backend = match &self.tier {
            Some(tier) => backend.with_observer(Arc::new(DiskObserver::new(
                Arc::clone(tier),
                open.path.clone(),
                Arc::clone(&open.vault),
            ))),
            None => backend,
        };
        let supervisor = SyncSupervisor::start(
            &self.runtime,
            SupervisorParts {
                backend: Arc::new(backend) as Arc<dyn SyncBackend>,
                gate: Arc::clone(&gate),
                reachability: Arc::clone(&self.reachability),
                power: self.power.as_ref().map(broadcast::Sender::subscribe),
                keychain_recovered: Some(self.keychain_recovered.subscribe()),
                db: open.vault.db_handle(),
                telemetry: self.telemetry.clone(),
                signals: signals.clone(),
                on_status: Arc::clone(&self.on_status),
                on_event: Arc::clone(&self.on_event),
            },
        );
        self.runtime
            .spawn(Arc::clone(self).bind(HeldOpen::new(open), Arc::downgrade(&gate)));
        supervisor
    }

    /// Decides the vault's binding, tells its gate, and retries `Unknown` while the gate lives.
    async fn bind(self: Arc<Self>, held: HeldOpen, gate: Weak<SyncStartGate>) {
        loop {
            // A closed vault or a stopped sync (a sign-out detaches it) decides nothing.
            if gate.upgrade().is_none() {
                return;
            }
            let Some(open) = held.get() else { return };
            let state = match self
                .account
                .apply_open_vault_binding(&open, &self.registry)
                .await
            {
                Ok(Applied::Start) => BindingState::Bound,
                Ok(Applied::Held(state)) => state,
                Err(error) => {
                    tracing::warn!(scope = "Binding", "vault ownership check failed: {error}");
                    BindingState::Unknown
                }
            };
            drop(open);
            let Some(live) = gate.upgrade() else { return };
            if self.bindings.publish(&live, &state) {
                (self.on_binding)(&state);
            }
            if state == BindingState::Bound {
                // Sync starts for this vault: register it with the account (`runtime.ts:897`).
                self.refresh_vault_directory();
            }
            drop(live);
            if state != BindingState::Unknown {
                return;
            }
            tokio::time::sleep(BINDING_RETRY).await;
        }
    }

    /// `resolveOpenVaultBinding`: the user's answer for the open vault, then its gate.
    pub fn resolve(
        &self,
        open: &OpenVault,
        choice: BindingChoice,
    ) -> Result<BindingState, AccountError> {
        let current = self.bindings.state();
        let state =
            self.account
                .resolve_open_vault_binding(open, &self.registry, &current, choice)?;
        if let Some(gate) = self.bindings.gate()
            && self.bindings.publish(&gate, &state)
        {
            (self.on_binding)(&state);
        }
        if state == BindingState::Bound {
            // `vault-binding-resolve.ts:54`.
            self.refresh_vault_directory();
        }
        Ok(state)
    }

    /// A forced vault directory refresh in the background; an icon it changes is announced.
    pub fn refresh_vault_directory(&self) {
        let account = Arc::clone(&self.account);
        let registry = self.registry.clone();
        let on_changed = Arc::clone(&self.on_vault_list_changed);
        self.runtime.spawn(async move {
            if account.refresh_vault_directory(&registry, true).await {
                on_changed();
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A switch rebuilds the supervisor: a late answer for the closed vault's gate never
    /// replaces the open vault's state, and with no supervisor the state is neutral.
    #[test]
    fn only_the_open_vaults_gate_takes_a_state_and_none_reads_bound() {
        let bindings = OpenVaultBinding::default();
        let closed = Arc::new(SyncStartGate::default());
        bindings.track(&closed);
        let open = Arc::new(SyncStartGate::default());
        bindings.track(&open);

        assert_eq!(bindings.state(), BindingState::Bound, "before any decision");
        assert!(!bindings.publish(&closed, &BindingState::Foreign));
        assert_eq!(bindings.state(), BindingState::Bound);
        assert!(bindings.publish(&open, &BindingState::LocalOnly));
        assert!(
            !bindings.publish(&open, &BindingState::LocalOnly),
            "unchanged"
        );
        assert_eq!(bindings.state(), BindingState::LocalOnly);

        drop(open);
        assert_eq!(bindings.state(), BindingState::Bound);
        assert!(bindings.gate().is_none());
    }

    /// A switch from a held vault to a bound one reports `Bound`, so the renderer leaves the
    /// held vault's binding prompt.
    #[test]
    fn a_switch_from_a_held_vault_to_a_bound_one_is_reported() {
        let bindings = OpenVaultBinding::default();
        let held = Arc::new(SyncStartGate::default());
        bindings.track(&held);
        assert!(bindings.publish(&held, &BindingState::LocalOnly));

        let bound = Arc::new(SyncStartGate::default());
        bindings.track(&bound);

        assert!(bindings.publish(&bound, &BindingState::Bound));
        assert_eq!(bindings.state(), BindingState::Bound);
    }
}
