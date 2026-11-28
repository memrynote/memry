//! When the open vault's sync may attach: only once the master key has a definite answer against
//! the account. Tauri has no vault-level key verifier (Electron's `getVerifiedVaultKey`), so this
//! check is the only guard between a wrong master key and a pass that brands every pulled item
//! corrupt and pushes data no other device can read.
//!
//! An answer that cannot be had now holds the attach instead of skipping the check: a keychain
//! that does not answer waits for `KeyringStore::subscribe_recovered` (Electron pauses on it and
//! restarts the runtime, `sync/runtime.ts:452-458`), and a verifier that cannot be fetched waits
//! for the network to return or [`VERIFIER_RETRY`]. A retry runs the runtime-start check, as
//! Electron's restart does; only the launch attempt runs the integrity sign-out.

use std::sync::Arc;
use std::time::Duration;

use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use tokio::sync::{broadcast, watch};

use super::{AccountKeyCheck, AccountService};
use crate::session::Session;

/// How long a held attach waits for a verifier while the network looks up.
pub const VERIFIER_RETRY: Duration = Duration::from_secs(60);

/// Why an attach runs: the launch runs `checkSyncIntegrity`, every later attach (sign-in, phrase,
/// link, repair) the account check of `startSyncRuntime`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachTrigger {
    Launch,
    Flow,
}

/// The one owner of the check-then-attach step. The latest call wins: an attach held behind an
/// earlier call ends when a newer one starts.
pub struct SyncAttach {
    account: Arc<AccountService>,
    keychain_recovered: broadcast::Sender<()>,
    online: broadcast::Sender<()>,
    latest: watch::Sender<u64>,
}

struct OnlineSignal(broadcast::Sender<()>);

impl ReachabilityObserver for OnlineSignal {
    fn on_change(&self, reachable: Reachable) {
        if reachable != Reachable::Offline {
            let _ = self.0.send(());
        }
    }
}

impl SyncAttach {
    /// `keychain_recovered` fires on `KeyringStore::subscribe_recovered`.
    pub fn new(
        account: Arc<AccountService>,
        keychain_recovered: broadcast::Sender<()>,
        reachability: &dyn Reachability,
    ) -> Self {
        let online = broadcast::Sender::new(4);
        reachability.observe(Arc::new(OnlineSignal(online.clone())));
        Self {
            account,
            keychain_recovered,
            online,
            latest: watch::Sender::new(0),
        }
    }

    /// Runs `attach` (off the async workers) when the account is signed in and its master key is
    /// not confirmed wrong; holds it while the check cannot answer; never runs it on a mismatch.
    pub async fn run(
        &self,
        session: &Session,
        trigger: AttachTrigger,
        attach: impl FnOnce() + Send + 'static,
    ) {
        let mut ticket = 0;
        self.latest.send_modify(|latest| {
            *latest += 1;
            ticket = *latest;
        });
        let mut superseded = self.latest.subscribe();
        let mut trigger = trigger;
        loop {
            // Subscribed before the check, so a signal during it is not missed.
            let mut keychain = self.keychain_recovered.subscribe();
            let mut online = self.online.subscribe();
            if *superseded.borrow_and_update() != ticket || !self.signed_in().await {
                return;
            }
            let check = match trigger {
                AttachTrigger::Launch => self.account.check_sync_integrity(session).await,
                AttachTrigger::Flow => Ok(self.account.check_sync_start().await),
            };
            trigger = AttachTrigger::Flow;
            match check {
                Ok(AccountKeyCheck::Match | AccountKeyCheck::Unknown) => break,
                // `Transition` never comes from these checks: both wait for `key_op`.
                Ok(AccountKeyCheck::Mismatch | AccountKeyCheck::Transition) => return,
                Ok(AccountKeyCheck::KeychainUnreadable) => {
                    tracing::warn!(scope = "Sync", "sync held: the keychain did not answer");
                    tokio::select! {
                        _ = keychain.recv() => {}
                        _ = superseded.changed() => return,
                    }
                }
                Ok(AccountKeyCheck::VerifierUnreachable) => {
                    tracing::warn!(
                        scope = "Sync",
                        "sync held: the account key verifier is unreachable"
                    );
                    tokio::select! {
                        _ = online.recv() => {}
                        () = tokio::time::sleep(VERIFIER_RETRY) => {}
                        _ = superseded.changed() => return,
                    }
                }
                Err(error) => {
                    tracing::error!(scope = "Sync", "sync integrity sign-out failed: {error}");
                    return;
                }
            }
        }
        if let Err(error) = tokio::task::spawn_blocking(attach).await {
            tracing::error!(scope = "Sync", "sync attach failed: {error}");
        }
    }

    async fn signed_in(&self) -> bool {
        let account = self.account.clone();
        tokio::task::spawn_blocking(move || account.info().signed_in)
            .await
            .unwrap_or(false)
    }
}
