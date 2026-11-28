//! Turn write grants, the port of Electron's `agent/turn-grants.ts`.
//!
//! External MCP clients are read-only; a write needs a capability minted by the turn memrynote is
//! running right now. A conversation id cannot carry that: it is persisted and outlives the turn.
//! A grant is 256 random bits as hex, handed only to the backend the turn spawns, never persisted,
//! never sent to the renderer, and revoked when the turn ends. Each vault's gate owns its own
//! [`TurnGrants`], so a grant never authorises a write into another vault or a later session.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use memry_core::crypto::sodium::random_bytes;
use subtle::ConstantTimeEq;

/// grant -> the conversation whose in-flight turn it authorises.
#[derive(Default)]
pub struct TurnGrants {
    active: Mutex<HashMap<String, String>>,
}

impl TurnGrants {
    fn active(&self) -> MutexGuard<'_, HashMap<String, String>> {
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Mints the grant for a turn that is starting and drops any grant the conversation still
    /// holds: turns are serialised per conversation, so an older one is a leftover of a turn that
    /// died before its revoke.
    pub fn mint(self: &Arc<Self>, conversation_id: &str) -> TurnGrant {
        let secret = hex::encode(random_bytes(32));
        let mut active = self.active();
        active.retain(|_, owner| owner != conversation_id);
        active.insert(secret.clone(), conversation_id.to_owned());
        TurnGrant {
            secret,
            grants: Arc::downgrade(self),
        }
    }

    /// The conversation a presented value authorises, or `None`. An unknown value and an expired
    /// one answer the same on purpose. Every live grant is compared in constant time.
    pub fn resolve(&self, candidate: &str) -> Option<String> {
        if candidate.is_empty() {
            return None;
        }
        let mut found = None;
        for (grant, owner) in self.active().iter() {
            let same = grant.len() == candidate.len()
                && bool::from(grant.as_bytes().ct_eq(candidate.as_bytes()));
            if same {
                found = Some(owner.clone());
            }
        }
        found
    }

    pub fn revoke_for(&self, conversation_id: &str) {
        self.active().retain(|_, owner| owner != conversation_id);
    }

    pub fn revoke_all(&self) {
        self.active().clear();
    }
}

/// A turn's write capability. Dropping it revokes it, so every exit of the turn that holds it
/// (return, error, panic, cancellation) ends the capability.
pub struct TurnGrant {
    secret: String,
    grants: Weak<TurnGrants>,
}

impl TurnGrant {
    /// The value the turn hands its backend (`X-Memry-Turn`, `MEMRY_AGENT_TURN`).
    pub fn secret(&self) -> &str {
        &self.secret
    }
}

impl Drop for TurnGrant {
    fn drop(&mut self) {
        if let Some(grants) = self.grants.upgrade() {
            grants.active().remove(&self.secret);
        }
    }
}

impl fmt::Debug for TurnGrant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TurnGrant(..)")
    }
}
