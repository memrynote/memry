//! Drives one [`RealtimeClient`] for as long as the shell wants it: connect,
//! keep alive (§9.6), notice a half-open socket, and reconnect along §9.10's
//! ladder until stopped or a close is terminal (§9.9).
//!
//! The shell runs this while the app is in the foreground and stops it when
//! the app leaves (§9.1). Every successful open calls `on_connected`, because
//! broadcasts sent while no socket was open are gone and the caller MUST pull
//! (§9.1).

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::sync::Notify;

use crate::protocol::auth::{TokenClaims, now_unix_s};
use crate::protocol::http::TokenProvider;

use super::socket::{
    MAX_RECONNECT_DELAY_MS, PING_INTERVAL_MS, RealtimeClient, Reconnect, STALE_AFTER_MS, Terminal,
};

/// Why [`run`] returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunEnd {
    Stopped,
    /// §9.9's 4004 or 4009, or the handshake's 403 or 426: reconnecting
    /// cannot help, for the rest of the session.
    Terminal,
    /// §9.10: the handshake was refused `401`. Not latched; the next run
    /// tries again.
    Refused,
}

/// A handshake still unanswered after this long is dropped and retried along
/// the ladder. Without it a request the network swallows, with no open and no
/// error, holds the run forever. Longer than a slow handshake over a poor
/// mobile link takes.
pub const HANDSHAKE_TIMEOUT_MS: u64 = 15_000;

/// §9.9's latch, held above any one run: a shell mints a new socket on each
/// foreground, and a 4004 or 4009 must not get a fresh handshake every time.
/// The owner ([`crate::api::sync::VaultSync`]) lives until sign-out, which is
/// when a 4004 can stop being true; a 4009 holds until the app is updated,
/// which relaunches it.
#[derive(Default)]
pub struct TerminalLatch(Mutex<Option<Terminal>>);

impl TerminalLatch {
    pub fn get(&self) -> Option<Terminal> {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn set(&self, terminal: Terminal) {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(terminal);
    }
}

/// The shell's off switch. Latched: a stop before [`run`] starts still stops it.
#[derive(Default)]
pub struct StopSignal {
    stopped: AtomicBool,
    wake: Notify,
}

impl StopSignal {
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.wake.notify_one();
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Sleeps `ms`, or less when stopped. Answers whether it was stopped.
    async fn sleep(&self, ms: u64) -> bool {
        if self.is_stopped() {
            return true;
        }
        tokio::select! {
            () = self.wake.notified() => {}
            () = tokio::time::sleep(Duration::from_millis(ms)) => {}
        }
        self.is_stopped()
    }
}

pub async fn run(
    client: &RealtimeClient,
    tokens: &dyn TokenProvider,
    stop: &StopSignal,
    latch: &TerminalLatch,
    on_connected: &(dyn Fn() + Sync),
) -> RunEnd {
    if latch.get().is_some() {
        return RunEnd::Terminal;
    }
    loop {
        if stop.is_stopped() {
            client.disconnect();
            return RunEnd::Stopped;
        }
        // A handshake with an expired token is a 401 that looks like any
        // other failure, so refresh first rather than burn an attempt on it.
        refresh_if_expired(tokens).await;
        if client.connect().await.is_ok() && hold(client, stop, on_connected).await {
            client.disconnect();
            return RunEnd::Stopped;
        }
        let pause = match client.note_closed() {
            Reconnect::After { delay_ms } => delay_ms,
            Reconnect::AfterRefresh => {
                // §9.10.1: 4003. A failed refresh waits out the ladder's top
                // rather than reconnecting into another 4003 at once.
                match tokens.access_token().await {
                    Some(stale) if tokens.refresh(&stale).await.is_ok() => 0,
                    _ => MAX_RECONNECT_DELAY_MS,
                }
            }
            Reconnect::Terminal(terminal) => {
                latch.set(terminal);
                return RunEnd::Terminal;
            }
            Reconnect::Refused => return RunEnd::Refused,
            Reconnect::Stopped => return RunEnd::Stopped,
        };
        if stop.sleep(pause).await {
            client.disconnect();
            return RunEnd::Stopped;
        }
    }
}

/// Holds one connection until it ends. Answers whether `stop` ended it.
async fn hold(
    client: &RealtimeClient,
    stop: &StopSignal,
    on_connected: &(dyn Fn() + Sync),
) -> bool {
    let mut announced = false;
    let handshake_deadline =
        tokio::time::Instant::now() + Duration::from_millis(HANDSHAKE_TIMEOUT_MS);
    let mut beat = tokio::time::interval(Duration::from_millis(PING_INTERVAL_MS));
    beat.tick().await;
    loop {
        if stop.is_stopped() {
            return true;
        }
        if client.has_ended() {
            return false;
        }
        if client.is_open() && !announced {
            announced = true;
            on_connected();
        }
        tokio::select! {
            () = stop.wake.notified() => {}
            () = client.changed() => {}
            () = tokio::time::sleep_until(handshake_deadline), if !announced => {
                client.abandon();
                return false;
            }
            _ = beat.tick() => {
                if client
                    .quiet_for()
                    .is_some_and(|quiet| quiet > Duration::from_millis(STALE_AFTER_MS))
                {
                    client.abandon();
                    return false;
                }
                // A failed send is reported through `on_error`, which ends
                // this connection on the next turn.
                let _ = client.ping();
            }
        }
    }
}

async fn refresh_if_expired(tokens: &dyn TokenProvider) {
    let Some(token) = tokens.access_token().await else {
        return;
    };
    let expired = TokenClaims::parse(&token).map_or(true, |claims| claims.is_expired(now_unix_s()));
    if expired {
        // A failed refresh leaves the handshake to fail and the ladder to wait.
        let _ = tokens.refresh(&token).await;
    }
}
