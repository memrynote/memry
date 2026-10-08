//! The realtime socket, exported (chapter 09, #2798).
//!
//! Without it a phone learns about another device's change only when it next
//! runs a pass for its own reasons: a local write, a pull-to-refresh, or a
//! return to the foreground. A phone left open on one screen could sit for
//! minutes on an item the server already held. The socket turns that into a
//! hint within a second of the push.
//!
//! The shell's half is small on purpose: call [`VaultRealtime::run`] while the
//! app is in the foreground, [`VaultRealtime::stop`] when it leaves (§9.1),
//! and run a pass whenever the listener says so. Connecting, keepalive,
//! reconnection and token refresh stay here.

use std::sync::Arc;

use super::VaultSync;
use crate::protocol::http::TokenProvider;
use crate::sync::socket::{Hint, HintSink, RealtimeClient};
use crate::sync::socket_run::{self, RunEnd, StopSignal, TerminalLatch};

/// Where the socket's wake-ups go.
///
/// **Synchronous by contract**, like `SyncProgressListener`: it is called on
/// whichever thread delivered the frame, so hop and return.
#[uniffi::export(with_foreign)]
pub trait RealtimeListener: Send + Sync {
    /// Run a pass: the server holds changes this device may not have, or the
    /// socket just (re)connected and broadcasts sent before it are gone.
    fn changes_available(&self);
}

struct Forward(Arc<dyn RealtimeListener>);

impl HintSink for Forward {
    fn hint(&self, hint: Hint) {
        // The pass pulls records and every body owed, so both hints ask for
        // the same thing. The cursors are not used (§9.11).
        if matches!(
            hint,
            Hint::ChangesAvailable { .. } | Hint::CrdtUpdated { .. }
        ) {
            self.0.changes_available();
        }
    }
}

/// One vault's realtime socket.
#[derive(uniffi::Object)]
pub struct VaultRealtime {
    client: RealtimeClient,
    tokens: Arc<dyn TokenProvider>,
    listener: Arc<dyn RealtimeListener>,
    stop: StopSignal,
    latch: Arc<TerminalLatch>,
}

#[uniffi::export]
impl VaultSync {
    /// The socket for this vault. Opens nothing until [`VaultRealtime::run`].
    pub fn realtime(&self, listener: Arc<dyn RealtimeListener>) -> Arc<VaultRealtime> {
        let http = self.session.http();
        let tokens: Arc<dyn TokenProvider> = self.session.tokens.clone();
        let client = RealtimeClient::new(
            http.transport(),
            http.base_url(),
            http.identity().clone(),
            Arc::clone(&tokens),
            Arc::new(Forward(Arc::clone(&listener))),
        )
        .with_vault(&self.vault_id);
        Arc::new(VaultRealtime {
            client,
            tokens,
            listener,
            stop: StopSignal::default(),
            latch: Arc::clone(&self.realtime_latch),
        })
    }
}

#[uniffi::export(async_runtime = "tokio")]
impl VaultRealtime {
    /// Holds the socket open until [`Self::stop`], or until a close says
    /// reconnecting cannot help (§9.9). Answers `true` only for the second.
    /// That close latches this vault's sync: every later socket it mints
    /// answers `true` at once without a handshake.
    ///
    /// One run per object: a stopped object stays stopped, so mint a new one
    /// on the next foreground.
    pub async fn run(&self) -> bool {
        let listener = Arc::clone(&self.listener);
        let on_connected = move || listener.changes_available();
        socket_run::run(
            &self.client,
            self.tokens.as_ref(),
            &self.stop,
            &self.latch,
            &on_connected,
        )
        .await
            == RunEnd::Terminal
    }

    /// Closes the socket and ends [`Self::run`]. Safe from any thread, and
    /// before `run` starts.
    pub fn stop(&self) {
        self.stop.stop();
    }
}
