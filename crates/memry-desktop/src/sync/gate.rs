//! Whether sync may start for the open vault, ported from Electron's start checks and
//! `reasonSyncDidNotStart` (`device-registration.ts:396-409`).
//!
//! The binding and the entitlement have owners elsewhere (the vault binding, billing); they tell
//! the gate through [`SyncStartGate::set_binding`] and [`SyncStartGate::set_entitlement`], and
//! the supervisor re-evaluates on every change.

use std::sync::Mutex;

use serde::Serialize;
use tokio::sync::watch;

use crate::session::lock;

/// What the account says about the open vault (`VaultBindingState` in `ipc-sync-ops.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultBinding {
    Bound,
    LocalOnly,
    NeedsDecision,
    Foreign,
    /// The account's vault list could not be fetched yet: not a choice, retried.
    Unknown,
}

/// The account's plan, as billing last read it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entitlement {
    Entitled,
    Unentitled,
    /// Not read yet. Electron blocks only on an explicit `isPaid === false`, and the server
    /// answers `402` to an unpaid account anyway (§11.7.1), so this starts.
    Unknown,
}

/// The account side, read at each start attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthFacts {
    pub signed_in: bool,
    /// The master key is in the keychain and readable.
    pub key_verified: bool,
    /// `sync.recoveryPhraseConfirmed` is not `false`.
    pub recovery_confirmed: bool,
    /// The keychain did not answer the master-key read (locked, denied, failed), so whether the
    /// key is there is unknown. Retried along the keychain ladder.
    pub keychain_unavailable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GateInputs {
    pub auth: AuthFacts,
    pub binding: VaultBinding,
    pub entitlement: Entitlement,
}

/// `SyncNotStartedReason` in `ipc-sync-ops.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum SyncNotStartedReason {
    VaultBinding,
    VaultForeign,
    Entitlement,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateDecision {
    Start,
    NotStarted(SyncNotStartedReason),
}

/// Account first (nothing syncs signed out or without keys), then the vault's binding (a vault
/// another account synced never syncs with this one; an unknown binding could be that, so it
/// waits), then the plan.
pub fn evaluate(inputs: &GateInputs) -> GateDecision {
    use SyncNotStartedReason as R;
    let auth = inputs.auth;
    if !(auth.signed_in && auth.key_verified && auth.recovery_confirmed) {
        return GateDecision::NotStarted(R::Unavailable);
    }
    match inputs.binding {
        VaultBinding::Foreign => return GateDecision::NotStarted(R::VaultForeign),
        VaultBinding::LocalOnly | VaultBinding::NeedsDecision => {
            return GateDecision::NotStarted(R::VaultBinding);
        }
        VaultBinding::Unknown => return GateDecision::NotStarted(R::Unavailable),
        VaultBinding::Bound => {}
    }
    if inputs.entitlement == Entitlement::Unentitled {
        return GateDecision::NotStarted(R::Entitlement);
    }
    GateDecision::Start
}

/// The binding and entitlement the supervisor gates on, with a change signal.
pub struct SyncStartGate {
    facts: Mutex<(VaultBinding, Entitlement)>,
    changed: watch::Sender<u64>,
}

impl Default for SyncStartGate {
    fn default() -> Self {
        Self {
            facts: Mutex::new((VaultBinding::Unknown, Entitlement::Unknown)),
            changed: watch::Sender::new(0),
        }
    }
}

impl SyncStartGate {
    pub fn set_binding(&self, binding: VaultBinding) {
        let changed = {
            let mut facts = lock(&self.facts);
            std::mem::replace(&mut facts.0, binding) != binding
        };
        if changed {
            self.changed.send_modify(|n| *n += 1);
        }
    }

    /// A repeated `Entitled` signals too: billing's paid answer is the only way out of the
    /// driver's `Unentitled` after a `402` (§11.7.1), and the gate may already say `Entitled`.
    pub fn set_entitlement(&self, entitlement: Entitlement) {
        let changed = {
            let mut facts = lock(&self.facts);
            std::mem::replace(&mut facts.1, entitlement) != entitlement
        };
        if changed || entitlement == Entitlement::Entitled {
            self.changed.send_modify(|n| *n += 1);
        }
    }

    pub fn binding(&self) -> VaultBinding {
        lock(&self.facts).0
    }

    pub fn entitlement(&self) -> Entitlement {
        lock(&self.facts).1
    }

    pub fn inputs(&self, auth: AuthFacts) -> GateInputs {
        let (binding, entitlement) = *lock(&self.facts);
        GateInputs {
            auth,
            binding,
            entitlement,
        }
    }

    /// Wakes on every change from now on.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BINDINGS: [VaultBinding; 5] = [
        VaultBinding::Bound,
        VaultBinding::LocalOnly,
        VaultBinding::NeedsDecision,
        VaultBinding::Foreign,
        VaultBinding::Unknown,
    ];
    const PLANS: [Entitlement; 3] = [
        Entitlement::Entitled,
        Entitlement::Unentitled,
        Entitlement::Unknown,
    ];

    /// The expected answer, written as a table rather than as the order `evaluate` checks in.
    fn expected(inputs: &GateInputs) -> GateDecision {
        use SyncNotStartedReason as R;
        let a = inputs.auth;
        let account_ready = a.signed_in && a.key_verified && a.recovery_confirmed;
        match (account_ready, inputs.binding, inputs.entitlement) {
            (false, _, _) => GateDecision::NotStarted(R::Unavailable),
            (true, VaultBinding::Foreign, _) => GateDecision::NotStarted(R::VaultForeign),
            (true, VaultBinding::LocalOnly | VaultBinding::NeedsDecision, _) => {
                GateDecision::NotStarted(R::VaultBinding)
            }
            (true, VaultBinding::Unknown, _) => GateDecision::NotStarted(R::Unavailable),
            (true, VaultBinding::Bound, Entitlement::Unentitled) => {
                GateDecision::NotStarted(R::Entitlement)
            }
            (true, VaultBinding::Bound, Entitlement::Entitled | Entitlement::Unknown) => {
                GateDecision::Start
            }
        }
    }

    #[test]
    fn every_combination_of_inputs() {
        let mut starts = 0;
        for bits in 0..8u8 {
            let auth = AuthFacts {
                signed_in: bits & 1 != 0,
                key_verified: bits & 2 != 0,
                recovery_confirmed: bits & 4 != 0,
                keychain_unavailable: false,
            };
            for binding in BINDINGS {
                for entitlement in PLANS {
                    let inputs = GateInputs {
                        auth,
                        binding,
                        entitlement,
                    };
                    assert_eq!(evaluate(&inputs), expected(&inputs), "{inputs:?}");
                    starts += usize::from(evaluate(&inputs) == GateDecision::Start);
                }
            }
        }
        assert_eq!(
            starts, 2,
            "only a ready account on a bound vault with a plan or no answer"
        );
    }

    #[test]
    fn a_change_wakes_subscribers_and_a_repeat_does_not() {
        let gate = SyncStartGate::default();
        let mut changes = gate.subscribe();
        gate.set_binding(VaultBinding::Bound);
        assert!(changes.has_changed().unwrap());
        changes.mark_unchanged();
        gate.set_binding(VaultBinding::Bound);
        assert!(!changes.has_changed().unwrap());
        gate.set_entitlement(Entitlement::Unentitled);
        assert!(changes.has_changed().unwrap());
        assert_eq!(gate.entitlement(), Entitlement::Unentitled);
    }

    #[test]
    fn reasons_serialize_as_the_contract_spells_them() {
        let names: Vec<_> = [
            SyncNotStartedReason::VaultBinding,
            SyncNotStartedReason::VaultForeign,
            SyncNotStartedReason::Entitlement,
            SyncNotStartedReason::Unavailable,
        ]
        .iter()
        .map(|r| serde_json::to_value(r).unwrap())
        .collect();
        assert_eq!(
            names,
            [
                "vault-binding",
                "vault-foreign",
                "entitlement",
                "unavailable"
            ]
        );
    }
}
