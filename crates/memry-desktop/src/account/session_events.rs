//! The account signals sync raises, turned into what the renderer shows: the session-expired
//! dialog, the device-revoked dialog with its unsynced count, and the linking approval prompt
//! (Electron `engine/error-recovery-handler.ts:49-77`, `engine.ts:1082-1089`, `token-manager.ts`).
//!
//! Revocation follows Electron, not the core's iOS rule: nothing is deleted. Sync stops, the
//! session moves to `Revoked` with every secret kept, and the queue stays, so the dialog's export
//! offer still has the master key and the unsent edits. Sign-out clears them.
//!
//! Departure: a revocation heard while a refresh is in flight (`Refreshing`) does not move the
//! session (§C.1 draws no edge there), and revoked is never persisted, so after a restart sync
//! attaches again and the server's refusal shows the dialog again.

use std::sync::Arc;

use memry_core::sync::outbox;
use tokio::sync::broadcast::{self, error::RecvError};

use super::AccountService;
use crate::session::Session;
use crate::sync::signals::{AuthSignal, SessionEndReason};

/// One account event for the renderer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountEvent {
    /// `auth:session-expired`.
    SessionExpired { reason: SessionEndReason },
    /// `sync:device-removed` (`DeviceRevokedEvent`): this device was revoked.
    DeviceRevoked { unsynced_count: u64 },
    /// `sync:linking-request`.
    LinkingRequest {
        session_id: String,
        new_device_name: String,
        new_device_platform: String,
    },
    /// `sync:linking-approved`.
    LinkingApproved { session_id: String },
}

impl AccountService {
    /// The account side of one signal, then its event.
    pub async fn on_auth_signal(&self, session: &Session, signal: AuthSignal) -> AccountEvent {
        match signal {
            AuthSignal::SessionExpired { reason } => AccountEvent::SessionExpired { reason },
            AuthSignal::DeviceRevoked => AccountEvent::DeviceRevoked {
                unsynced_count: self.device_revoked(session).await,
            },
            AuthSignal::LinkingRequest {
                session_id,
                new_device_name,
                new_device_platform,
            } => AccountEvent::LinkingRequest {
                session_id,
                new_device_name,
                new_device_platform,
            },
            AuthSignal::LinkingApproved { session_id } => {
                AccountEvent::LinkingApproved { session_id }
            }
        }
    }

    /// Stops sync before the dialog shows, keeps every secret and queued edit, and answers how
    /// many edits are still queued in the open vault.
    async fn device_revoked(&self, session: &Session) -> u64 {
        if let Err(error) = self.session.note_device_revoked() {
            tracing::info!(
                scope = "Account",
                "revoked outside a registered session: {error}"
            );
        }
        let stopping = session.clone();
        if let Err(error) = tokio::task::spawn_blocking(move || stopping.detach_sync()).await {
            tracing::warn!(
                scope = "Account",
                "sync did not stop on revocation: {error}"
            );
        }
        let Some(open) = session.current() else {
            return 0;
        };
        match open.vault.db_handle().read(outbox::depth).await {
            Ok(depth) => depth as u64,
            Err(error) => {
                tracing::warn!(scope = "Account", "unsynced count unreadable: {error}");
                0
            }
        }
    }
}

/// Hears the session's signals for good and hands each event to `emit`. Subscribe before the
/// first `attach_sync` ([`Session::subscribe_auth_signals`]) so no signal is missed.
pub fn listen(
    runtime: &tokio::runtime::Handle,
    account: Arc<AccountService>,
    session: Session,
    mut signals: broadcast::Receiver<AuthSignal>,
    emit: impl Fn(AccountEvent) + Send + 'static,
) -> tokio::task::JoinHandle<()> {
    runtime.spawn(async move {
        loop {
            match signals.recv().await {
                Ok(signal) => {
                    let event = account.on_auth_signal(&session, signal).await;
                    emit(event);
                }
                Err(RecvError::Lagged(missed)) => {
                    tracing::warn!(scope = "Account", missed, "account signals dropped");
                }
                Err(RecvError::Closed) => return,
            }
        }
    })
}
