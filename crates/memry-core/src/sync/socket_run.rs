//! Drives one [`RealtimeClient`] for as long as the shell wants it: connect,
//! keep alive (§9.6), notice a half-open socket, and reconnect along §9.10's
//! ladder until stopped or a close is terminal (§9.9).
//!
//! The shell runs this while the app is in the foreground and stops it when
//! the app leaves (§9.1). Every successful open calls `on_connected`, because
//! broadcasts sent while no socket was open are gone and the caller MUST pull
//! (§9.1).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::sync::Notify;

use crate::protocol::auth::{TokenClaims, now_unix_s};
use crate::protocol::http::TokenProvider;

use super::socket::{
    MAX_RECONNECT_DELAY_MS, PING_INTERVAL_MS, RealtimeClient, Reconnect, STALE_AFTER_MS,
};

/// Why [`run`] returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunEnd {
    Stopped,
    /// §9.9's 4004 or 4009: reconnecting cannot help.
    Terminal,
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
    on_connected: &(dyn Fn() + Sync),
) -> RunEnd {
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
            Reconnect::Terminal(_) => return RunEnd::Terminal,
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
