//! Client policy: the write gate and the entitlement, chapter 11 (T118,
//! FR-035, data-model §C.3).
//!
//! **`ReadOnly`, `BlockedUpgrade` and `Unentitled` are three states and they
//! never collapse.** They have different explanations and different exits: a
//! kill switch clears server side, an upgrade needs an App Store update, and
//! an entitlement needs a plan. A client that showed one of them for another
//! tells the user to do the wrong thing (§C.3, FR-075).
//!
//! They cannot collapse here because they are **three independent inputs**,
//! not one field with three spellings:
//!
//! | State            | Input on [`PolicyTier`]                           | Source                                              |
//! | ---------------- | -------------------------------------------------- | --------------------------------------------------- |
//! | `ReadOnly`       | `policy.writes_enabled == false`                   | `clientPolicy` on `GET /sync/status` (§11.8)        |
//! | `BlockedUpgrade` | `policy.min_write_version` above this build        | `clientPolicy` on `GET /sync/status` (§11.8)        |
//! | `Unentitled`     | `entitled == false`                                | **a `402 SYNC_PAYMENT_REQUIRED`** (§11.7.1)         |
//!
//! [`PolicyTier::gate`] derives one [`WriteGate`] from all three on every
//! read, in §11.5's precedence, so clearing one input cannot clear another:
//! an account that renews its plan while the kill switch is still on goes
//! from `Unentitled` to `ReadOnly`, not to `Open`.
//!
//! **`Unentitled` is reactive and is never predicted** (§11.7.1). `clientPolicy`
//! carries `platform`, `writesEnabled` and `minWriteVersion` and no
//! entitlement field, so a client polling it for entitlement waits forever.
//! Entitlement is learned only by being told `402`, and, consistent with
//! §11.3, an entitlement that has never been contradicted is treated as
//! **present**: a client starts entitled and is demoted, never the reverse.
//! Starting from "unentitled until proven otherwise" locks a paying user out
//! of writes whenever the first status call fails.
//!
//! **Reads are never gated** and **a blocked gate parks the outbox**: no
//! attempt, no backoff, no row removed (§11.4, §11.9). Nothing in this module
//! touches a retry counter, and [`crate::sync::outbox::defer`] — the one
//! function that does — is never reached on the parked path.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

use serde_json::Value as Json;

use crate::api::errors::ApiError;

use super::state::{SyncState, WriteGate, evaluate_gate};

/// Chapter 00 §0.5: `SYNC_PAYMENT_REQUIRED` at **402**. The one wire fact
/// that enters `Unentitled`.
pub const SYNC_PAYMENT_REQUIRED: &str = "SYNC_PAYMENT_REQUIRED";

/// §11.8.1: at most 300 seconds in the foreground, chosen to match
/// `CLOCK_SKEW_THRESHOLD_SECONDS` (chapter 05 §5.16) so a client that already
/// polls status for skew gets policy for free.
pub const POLICY_POLL_INTERVAL_MS: i64 = 300_000;

/// `clientPolicy` as `GET /sync/status` echoes it (§11.8).
///
/// `platform` is carried because the server echoes it and a mismatch is worth
/// seeing in a log; it is **never** compared, because §11.3 makes an
/// unreadable policy degrade to allow rather than to a lockout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientPolicy {
    pub platform: Option<String>,
    pub writes_enabled: bool,
    pub min_write_version: Option<String>,
}

impl Default for ClientPolicy {
    /// §11.7: **an unreadable policy degrades to allow, never to a lockout.**
    fn default() -> Self {
        Self {
            platform: None,
            writes_enabled: true,
            min_write_version: None,
        }
    }
}

impl ClientPolicy {
    /// Reads `clientPolicy` out of a `GET /sync/status` body.
    ///
    /// §11.8: the block is **omitted entirely** for a legacy client that sent
    /// no `x-memry-client`. This client always identifies itself, so an
    /// omitted block means the server had nothing to say, which §11.7
    /// resolves to allowed — the same answer as a malformed one.
    pub fn from_status(body: &Json) -> Self {
        let policy = body.get("clientPolicy");
        Self {
            platform: policy
                .and_then(|p| p.get("platform"))
                .and_then(Json::as_str)
                .map(str::to_owned),
            writes_enabled: policy
                .and_then(|p| p.get("writesEnabled"))
                .and_then(Json::as_bool)
                .unwrap_or(true),
            min_write_version: policy
                .and_then(|p| p.get("minWriteVersion"))
                .and_then(Json::as_str)
                .map(str::to_owned),
        }
    }
}

/// What one `/sync/*` response taught the policy tier.
///
/// §11.7.1's table, read backwards: each write-blocked state has exactly one
/// wire fact that produces it, and nothing else does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyLesson {
    /// A `402 SYNC_PAYMENT_REQUIRED` from any `/sync/*` route.
    Unentitled,
    /// A `403 PLATFORM_WRITES_DISABLED` (§11.6).
    ReadOnly,
    /// A `426 CLIENT_UPGRADE_REQUIRED` (§11.6).
    BlockedUpgrade { min_version: Option<String> },
}

/// Whether a failed call carried one of §11.7.1's three facts.
///
/// A `402` carrying any other code is **not** an entitlement statement:
/// `SYNC_VAULT_LIMIT_EXCEEDED` is also a 402 (chapter 00 §0.5) and means the
/// account has a plan and too many vaults. Reporting it as `Unentitled` would
/// tell a paying user to buy a subscription they already hold.
pub fn lesson(error: &ApiError) -> Option<PolicyLesson> {
    match error {
        ApiError::WritesDisabled { .. } => Some(PolicyLesson::ReadOnly),
        ApiError::UpgradeRequired { min_version, .. } => Some(PolicyLesson::BlockedUpgrade {
            min_version: min_version.clone(),
        }),
        ApiError::Status {
            status: 402, code, ..
        } if code.as_deref() == Some(SYNC_PAYMENT_REQUIRED) => Some(PolicyLesson::Unentitled),
        _ => None,
    }
}

/// A `426` this build was refused with, held until the next successful poll.
///
/// The reactive half of the version floor. It is stored apart from
/// [`ClientPolicy::min_write_version`] because a server that omits
/// `minVersion` still means the same thing (§11.6), and folding a
/// floor-less refusal into `writes_enabled` would report `ReadOnly` for a
/// `426` — exactly the collapse §11.7.1 forbids.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Refusal {
    min_version: Option<String>,
}

/// The inputs and the one gate derived from them. One per vault.
pub struct PolicyTier {
    policy: Mutex<ClientPolicy>,
    /// §11.7.1: starts **present** and is only ever demoted by a `402`.
    entitled: AtomicBool,
    refusal: Mutex<Option<Refusal>>,
    /// Epoch milliseconds of the last successful `GET /sync/status`, or 0.
    checked_at: AtomicI64,
    client_version: String,
}

impl PolicyTier {
    /// A tier that has never polled: allowed, entitled, never checked.
    pub fn new(client_version: &str) -> Self {
        Self {
            policy: Mutex::new(ClientPolicy::default()),
            entitled: AtomicBool::new(true),
            refusal: Mutex::new(None),
            checked_at: AtomicI64::new(0),
            client_version: client_version.to_owned(),
        }
    }

    /// The last `clientPolicy` this tier learned.
    pub fn policy(&self) -> ClientPolicy {
        self.locked().clone()
    }

    pub fn entitled(&self) -> bool {
        self.entitled.load(Ordering::Relaxed)
    }

    /// The account tier's answer to "does this account have an active plan".
    ///
    /// The only way **out** of `Unentitled`. `clientPolicy` carries no
    /// entitlement field (§11.7.1), so a status poll can never clear it, and
    /// a parked outbox makes no write that could earn a 2xx — the account
    /// tier has to say so.
    pub fn set_entitled(&self, entitled: bool) {
        self.entitled.store(entitled, Ordering::Relaxed);
    }

    /// The gate, derived from all three inputs on every read.
    ///
    /// §11.5's precedence, extended by §11.7.1: the plan outranks the kill
    /// switch, which outranks the version floor. Answering
    /// `CLIENT_UPGRADE_REQUIRED` when writes are off for the whole platform
    /// sends users chasing an update that cannot help them, and answering
    /// either when the account has no plan sends them to the wrong screen.
    pub fn gate(&self) -> WriteGate {
        if !self.entitled() {
            return WriteGate::Unentitled;
        }
        let policy = self.locked().clone();
        if !policy.writes_enabled {
            return WriteGate::ReadOnly;
        }
        if let Some(refusal) = self.refusal_locked().clone() {
            return WriteGate::BlockedUpgrade {
                min_version: refusal.min_version,
            };
        }
        evaluate_gate(
            true,
            policy.min_write_version.as_deref(),
            &self.client_version,
            true,
        )
    }

    /// The state a blocked gate parks in, or `None` when writes may proceed.
    pub fn blocked_state(&self) -> Option<SyncState> {
        self.gate().blocked_state()
    }

    /// §11.8: the policy learned **without attempting a write**.
    ///
    /// A successful poll is the authority, so it clears the reactive `426`
    /// latch: §11.9 rule 4 requires a client to resume automatically when the
    /// policy clears, with no user action and no restart. It does **not**
    /// clear the entitlement — `clientPolicy` carries no entitlement field
    /// (§11.7.1), so a poll is silent on it and silence is not evidence.
    pub fn learn(&self, body: &Json, now_ms: i64) -> WriteGate {
        *self.locked() = ClientPolicy::from_status(body);
        *self.refusal_locked() = None;
        self.checked_at.store(now_ms, Ordering::Relaxed);
        self.gate()
    }

    /// Applies what a `/sync/*` response taught, and answers with the state
    /// to park in.
    ///
    /// A mid-wave `403` or `426` is recorded on the policy rather than on a
    /// separate flag, so the next pass parks **before** attempting instead of
    /// learning the same thing again from a second refusal (§11.9).
    pub fn observe(&self, error: &ApiError) -> Option<SyncState> {
        match lesson(error)? {
            PolicyLesson::Unentitled => {
                self.entitled.store(false, Ordering::Relaxed);
                Some(SyncState::Unentitled)
            }
            PolicyLesson::ReadOnly => {
                self.locked().writes_enabled = false;
                Some(SyncState::ReadOnly)
            }
            PolicyLesson::BlockedUpgrade { min_version } => {
                *self.refusal_locked() = Some(Refusal { min_version });
                Some(SyncState::BlockedUpgrade)
            }
        }
    }

    /// §11.8.1's schedule: on every transition to foreground, immediately
    /// before draining a parked outbox, and on an interval of at most 300 s
    /// in the foreground.
    pub fn poll_due(&self, now_ms: i64, foreground: bool) -> bool {
        foreground
            || self.gate() != WriteGate::Open
            || now_ms - self.checked_at.load(Ordering::Relaxed) >= POLICY_POLL_INTERVAL_MS
    }

    fn locked(&self) -> std::sync::MutexGuard<'_, ClientPolicy> {
        self.policy
            .lock()
            .expect("the policy mutex is never poisoned")
    }

    fn refusal_locked(&self) -> std::sync::MutexGuard<'_, Option<Refusal>> {
        self.refusal
            .lock()
            .expect("the refusal mutex is never poisoned")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_402_payment_required_demotes_and_nothing_else_does() {
        let tier = PolicyTier::new("1.0.0");
        assert!(tier.entitled());
        assert_eq!(tier.gate(), WriteGate::Open);

        // A 402 that is not the entitlement code leaves the plan alone.
        assert_eq!(
            tier.observe(&ApiError::Status {
                status: 402,
                code: Some("SYNC_VAULT_LIMIT_EXCEEDED".to_owned()),
                message: "too many vaults".to_owned(),
            }),
            None
        );
        assert!(tier.entitled());

        assert_eq!(
            tier.observe(&ApiError::Status {
                status: 402,
                code: Some(SYNC_PAYMENT_REQUIRED.to_owned()),
                message: "no active sync subscription".to_owned(),
            }),
            Some(SyncState::Unentitled)
        );
        assert!(!tier.entitled());
        assert_eq!(tier.gate(), WriteGate::Unentitled);
    }

    #[test]
    fn the_three_inputs_never_collapse() {
        let tier = PolicyTier::new("1.0.0");
        tier.learn(
            &json!({"clientPolicy": {"writesEnabled": false, "minWriteVersion": "9.9.9"}}),
            1,
        );
        tier.observe(&ApiError::Status {
            status: 402,
            code: Some(SYNC_PAYMENT_REQUIRED.to_owned()),
            message: String::new(),
        });

        // All three inputs are set. The plan outranks both.
        assert_eq!(tier.gate(), WriteGate::Unentitled);
        // Renewing the plan uncovers the kill switch rather than clearing it.
        tier.set_entitled(true);
        assert_eq!(tier.gate(), WriteGate::ReadOnly);
        // Clearing the kill switch uncovers the version floor.
        tier.learn(&json!({"clientPolicy": {"minWriteVersion": "9.9.9"}}), 2);
        assert_eq!(
            tier.gate(),
            WriteGate::BlockedUpgrade {
                min_version: Some("9.9.9".to_owned())
            }
        );
        // And only then is the gate open.
        tier.learn(&json!({"clientPolicy": {}}), 3);
        assert_eq!(tier.gate(), WriteGate::Open);
    }

    #[test]
    fn an_omitted_client_policy_block_is_allowed() {
        let tier = PolicyTier::new("1.0.0");
        assert_eq!(tier.learn(&json!({"serverTime": 1}), 1), WriteGate::Open);
        assert_eq!(tier.policy(), ClientPolicy::default());
    }

    #[test]
    fn the_poll_is_due_on_foreground_before_a_parked_drain_and_on_the_interval() {
        let tier = PolicyTier::new("1.0.0");
        tier.learn(&json!({"clientPolicy": {}}), 1_000);
        assert!(!tier.poll_due(1_001, false));
        assert!(tier.poll_due(1_001, true));
        assert!(tier.poll_due(1_000 + POLICY_POLL_INTERVAL_MS, false));

        tier.learn(&json!({"clientPolicy": {"writesEnabled": false}}), 2_000);
        assert!(
            tier.poll_due(2_001, false),
            "a parked outbox refreshes the policy before every drain"
        );
    }
}
