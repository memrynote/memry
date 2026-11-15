//! The loop's realtime socket, its terminal latches and the keychain retry ladder.

use std::sync::Arc;

use memry_core::sync::socket::Terminal;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::{Command, Loop};
use crate::sync::error_category::SyncErrorCategory;
use crate::sync::frames::FrameSink;
use crate::sync::gate::GateDecision;
use crate::sync::realtime::{RealtimeSocket, SocketEnd};
use crate::sync::signals::{AuthSignal, SessionEndReason};
use crate::sync::triggers::{Trigger, keychain_retry};

pub(super) struct SocketTask {
    generation: u64,
    socket: Arc<dyn RealtimeSocket>,
    handle: JoinHandle<SocketEnd>,
}

/// An unreadable-keychain episode (`keychain-retry.ts`): retries so far, and when the next runs
/// (`None` while one is under way).
#[derive(Debug, Clone, Copy)]
pub(super) struct KeychainWait {
    attempt: u32,
    pub(super) retry_at: Option<Instant>,
}

impl Loop {
    /// Opens the socket once a driver is open, unless something holds it shut.
    pub(super) fn ensure_socket(&mut self) {
        let wanted = self.realtime.is_none()
            && !self.socket_off
            && !self.socket_refused
            && self.online
            && !self.paused
            && self.latched.is_none()
            && self.decision == GateDecision::Start;
        let Some(driver) = self.driver.as_ref().filter(|_| wanted) else {
            return;
        };
        self.socket_generation += 1;
        let generation = self.socket_generation;
        let commands = self.commands.clone();
        let sink = Arc::new(FrameSink {
            commands: commands.clone(),
            signals: Arc::clone(&self.signals),
        });
        // §9.1: broadcasts sent while no socket was open are gone, so each open pulls.
        let on_connected = Arc::new(move || {
            if let Some(commands) = commands.upgrade() {
                let _ = commands.send(Command::Socket {
                    generation,
                    connected: true,
                });
                let _ = commands.send(Command::Wake(None));
            }
        });
        let socket = driver.realtime(sink, Arc::clone(&self.socket_latch), on_connected);
        let running = Arc::clone(&socket);
        let handle = tokio::spawn(async move { running.run().await });
        self.realtime = Some(SocketTask {
            generation,
            socket,
            handle,
        });
    }

    pub(super) fn stop_socket(&mut self) {
        if let Some(task) = self.realtime.take() {
            // Stopped, not aborted: the run closes its connection on the way out.
            task.socket.stop();
            self.disconnected(task.generation);
        }
    }

    fn disconnected(&mut self, generation: u64) {
        self.socket = Some((generation, false));
        self.socket_held = false;
    }

    pub(super) fn socket_ended(&mut self, end: Result<SocketEnd, tokio::task::JoinError>) {
        let Some(task) = self.realtime.take() else {
            return;
        };
        self.disconnected(task.generation);
        match end {
            Ok(SocketEnd::Stopped) => {}
            Ok(SocketEnd::Refused) => {
                tracing::warn!("the sync socket was refused 401; retried after the next pass");
                self.socket_refused = true;
            }
            Ok(SocketEnd::PinFailed) => self.socket_off = true,
            Ok(SocketEnd::Terminal(Terminal::DeviceRevoked)) => {
                self.socket_off = true;
                self.latch(SyncErrorCategory::DeviceRevoked);
            }
            Ok(SocketEnd::Terminal(Terminal::VersionIncompatible)) => {
                // The HTTP path parks writes on its own (`BlockedUpgrade`); pulls go on.
                tracing::warn!("the sync socket refused this app version; passes continue");
                self.socket_off = true;
            }
            Err(error) => tracing::error!(%error, "the sync socket task ended abnormally"),
        }
    }

    /// Ends sync for this loop's life: the account must act first. Sent once.
    pub(super) fn latch(&mut self, category: SyncErrorCategory) {
        if self.latched.is_some() {
            return;
        }
        let (message, signal) = match category {
            SyncErrorCategory::DeviceRevoked => (
                "This device was removed from your account",
                Some(AuthSignal::DeviceRevoked),
            ),
            SyncErrorCategory::AuthExpired => (
                "Your session expired. Sign in again to keep syncing",
                Some(AuthSignal::SessionExpired {
                    reason: SessionEndReason::RefreshRejected,
                }),
            ),
            _ => ("Sync stopped: the server's certificate did not match", None),
        };
        tracing::error!(
            category = category.as_str(),
            "sync stopped until the account acts"
        );
        self.latched = Some(category);
        self.last_error = Some((message.to_owned(), category));
        self.trailing = None;
        self.push_at = None;
        self.backoff_until = None;
        self.stop_socket();
        if let Some(signal) = signal {
            self.signals.send(signal);
        }
    }

    /// A failed open or pass that a retry may fix: wait 5 s doubling to 5 min before automatic
    /// passes run again.
    pub(super) fn back_off(&mut self) {
        self.failures += 1;
        let wait = crate::sync::triggers::rate_limit_backoff(None, self.failures);
        self.backoff_until = Some(Instant::now() + wait);
    }

    /// The keychain did not answer: arm the next retry of the ladder unless one is pending.
    pub(super) fn keychain_failed(&mut self) {
        let wait = self.keychain.get_or_insert(KeychainWait {
            attempt: 0,
            retry_at: None,
        });
        if wait.retry_at.is_some() {
            return;
        }
        let delay = keychain_retry(wait.attempt);
        if wait.attempt == 0 {
            tracing::error!("sync paused: the OS keychain did not answer");
        } else {
            tracing::info!(
                attempt = wait.attempt,
                "sync still paused: the keychain did not answer"
            );
        }
        wait.attempt += 1;
        wait.retry_at = Some(Instant::now() + delay);
    }

    /// Reads the keychain again (the gate's facts), then opens a driver if the gate allows. Only
    /// reads: a retry never writes or deletes a secret.
    pub(super) async fn retry_keychain(&mut self, why: &'static str) {
        if let Some(wait) = &mut self.keychain {
            wait.retry_at = None;
        }
        tracing::info!(trigger = why, "retrying sync after an unreadable keychain");
        self.reevaluate().await;
        if self.keychain.is_some_and(|wait| wait.retry_at.is_some()) {
            return;
        }
        if self.decision == GateDecision::Start && self.driver.is_none() {
            self.request(Trigger::Start);
        }
    }

    /// A pass task that panicked answers its Sync Now caller as a failure, with a reason.
    pub(super) fn pass_panicked(&mut self, error: &tokio::task::JoinError) {
        tracing::error!(%error, "a sync pass task ended abnormally");
        let message = "Sync failed unexpectedly";
        self.last_error = Some((message.to_owned(), SyncErrorCategory::Unknown));
        let mut result = crate::sync::result::TriggerSyncResult::blocked(
            crate::sync::result::SyncNowBlockedReason::Failed,
            None,
        );
        result.error = Some(message.to_owned());
        self.answer(self.next_id.saturating_sub(1), result);
        self.back_off();
    }
}

pub(super) async fn join(
    realtime: &mut Option<SocketTask>,
) -> Result<SocketEnd, tokio::task::JoinError> {
    match realtime {
        Some(task) => (&mut task.handle).await,
        None => std::future::pending().await,
    }
}
