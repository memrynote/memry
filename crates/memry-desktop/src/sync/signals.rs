//! What the open vault's sync tells the rest of the app: the account signals the account service
//! turns into the session-expired, revoked and linking events (Step 19), and the pull counter
//! tests and e2e commands wait on.

use serde::Serialize;
use tokio::sync::{broadcast, watch};

/// `SessionExpiredReason` in `ipc-events.ts`, the ones sync produces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SessionEndReason {
    /// The server refused the refresh token for good (`token-manager.ts:144`).
    RefreshRejected,
}

/// One account-side fact sync learned. Each terminal one is sent once per supervisor: sync stops
/// on it, so nothing reports it again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthSignal {
    SessionExpired {
        reason: SessionEndReason,
    },
    /// The server revoked this device: a `403 AUTH_DEVICE_REVOKED`, a socket close 4004 or an
    /// `AUTH_DEVICE_REVOKED` frame (§9.9). A handshake refused 403 is not one: an edge can answer
    /// it too.
    DeviceRevoked,
    /// §9.5.1: another device asks to be linked. Advisory; the linking flow still polls.
    LinkingRequest {
        session_id: String,
        new_device_name: String,
        new_device_platform: String,
    },
    LinkingApproved {
        session_id: String,
    },
}

impl AuthSignal {
    /// What the log may say: never a linking session id or a device name.
    fn kind(&self) -> &'static str {
        match self {
            Self::SessionExpired { .. } => "session_expired",
            Self::DeviceRevoked => "device_revoked",
            Self::LinkingRequest { .. } => "linking_request",
            Self::LinkingApproved { .. } => "linking_approved",
        }
    }
}

/// The account signals of every supervisor of one session. The session's owner makes one and
/// passes it in each [`super::supervisor::SupervisorParts`], so a subscriber taken before
/// `attach_sync` hears the supervisors a vault switch rebuilds too.
#[derive(Clone)]
pub struct AuthSignals(broadcast::Sender<AuthSignal>);

impl Default for AuthSignals {
    fn default() -> Self {
        Self(broadcast::Sender::new(16))
    }
}

impl AuthSignals {
    pub fn subscribe(&self) -> broadcast::Receiver<AuthSignal> {
        self.0.subscribe()
    }

    pub(super) fn send(&self, signal: AuthSignal) {
        tracing::info!(signal = signal.kind(), "sync signal");
        // No subscriber is not a failure: nobody is listening yet.
        let _ = self.0.send(signal);
    }
}

/// Shared by the handle and the loop.
pub(super) struct Signals {
    auth: AuthSignals,
    pulls: watch::Sender<u64>,
}

impl Signals {
    pub(super) fn new(auth: AuthSignals) -> Self {
        Self {
            auth,
            pulls: watch::Sender::new(0),
        }
    }

    pub(super) fn send(&self, signal: AuthSignal) {
        self.auth.send(signal);
    }

    pub(super) fn subscribe(&self) -> broadcast::Receiver<AuthSignal> {
        self.auth.subscribe()
    }

    pub(super) fn pulled(&self) {
        self.pulls.send_modify(|n| *n += 1);
    }

    pub(super) fn completed_pulls(&self) -> u64 {
        *self.pulls.borrow()
    }

    /// Waits until more than `after` passes have pulled, and answers how many have.
    pub(super) async fn wait_for_pull(&self, after: u64) -> u64 {
        let mut pulls = self.pulls.subscribe();
        // The sender lives as long as `self`, so the wait cannot fail.
        let seen = pulls.wait_for(|n| *n > after).await.map(|n| *n);
        seen.unwrap_or(after)
    }
}
