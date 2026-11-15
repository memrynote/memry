//! The supervisor's loop: every decision of [`super::supervisor::SyncSupervisor`] is taken here,
//! on one task, from one event at a time.

use std::sync::Arc;
use std::time::Duration;

use memry_core::api::errors::{ApiError, StorageError, SyncError};
use memry_core::seams::reachability::Reachable;
use memry_core::storage::Db;
use memry_core::sync::engine::PassReport;
use memry_core::sync::state::SyncState;
use memry_core::sync::{outbox, pause};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::backend::{SyncBackend, SyncPasses};
use super::error_category::SyncErrorCategory;
use super::gate::{self, Entitlement, GateDecision, SyncStartGate};
use super::result::{SyncNowBlockedReason as Blocked, TriggerSyncResult};
use super::status::{self, StatusFacts, SyncStatus};
use super::supervisor::{Command, SupervisorParts};
use super::triggers::{
    MAX_CLOCK_SKEW_MS, PUSH_DEBOUNCE, STATUS_THROTTLE, TICK, Trigger, rate_limit_backoff,
    tick_pulls,
};
use crate::shell::power::PowerEvent;

/// What a pass task hands back.
struct PassDone {
    id: u64,
    /// When the pass was requested: a pull's age counts from its start.
    started: Instant,
    /// The driver the pass ran on, or why it could not be opened.
    driver: Result<Arc<dyn SyncPasses>, SyncError>,
    report: Option<PassReport>,
    pending: Option<u32>,
}

enum Event {
    Command(Option<Command>),
    Done(Box<Result<PassDone, tokio::task::JoinError>>),
    PushDue,
    Tick,
    Emit,
    GateChanged,
    Power(Result<PowerEvent, broadcast::error::RecvError>),
}

pub(super) struct Loop {
    backend: Arc<dyn SyncBackend>,
    gate: Arc<SyncStartGate>,
    db: Db,
    on_status: Arc<dyn Fn(&SyncStatus) + Send + Sync>,
    power: Option<broadcast::Receiver<PowerEvent>>,
    status_tx: watch::Sender<SyncStatus>,
    gate_changes: watch::Receiver<u64>,
    rx: mpsc::UnboundedReceiver<Command>,
    driver: Option<Arc<dyn SyncPasses>>,
    decision: GateDecision,
    paused: bool,
    online: bool,
    offline_since: Option<i64>,
    running: Option<JoinHandle<PassDone>>,
    next_id: u64,
    trailing: Option<Trigger>,
    push_at: Option<Instant>,
    blocked_until: Option<Instant>,
    rate_failures: u32,
    last_pull: Option<Instant>,
    socket: Option<(u64, bool)>,
    socket_held: bool,
    engine: Option<SyncState>,
    last_error: Option<(String, SyncErrorCategory)>,
    last_sync_at: Option<i64>,
    pending: u32,
    /// Sync Now callers, each answered by the first pass with an id at or past theirs.
    waiters: Vec<(u64, oneshot::Sender<TriggerSyncResult>)>,
    last_emit: Option<Instant>,
    emit_at: Option<Instant>,
    emitted: Option<SyncStatus>,
}

impl Loop {
    pub(super) fn new(
        parts: SupervisorParts,
        rx: mpsc::UnboundedReceiver<Command>,
        status_tx: watch::Sender<SyncStatus>,
        paused: bool,
        online: bool,
    ) -> Self {
        let gate_changes = parts.gate.subscribe();
        Self {
            backend: parts.backend,
            gate: parts.gate,
            db: parts.db,
            on_status: parts.on_status,
            power: parts.power,
            status_tx,
            gate_changes,
            rx,
            driver: None,
            decision: GateDecision::NotStarted(gate::SyncNotStartedReason::Unavailable),
            paused,
            online,
            offline_since: (!online).then(now_ms),
            running: None,
            next_id: 0,
            trailing: None,
            push_at: None,
            blocked_until: None,
            rate_failures: 0,
            last_pull: None,
            socket: None,
            socket_held: false,
            engine: None,
            last_error: None,
            last_sync_at: None,
            pending: 0,
            waiters: Vec::new(),
            last_emit: None,
            emit_at: None,
            emitted: None,
        }
    }

    pub(super) async fn run(mut self) {
        let mut tick = tokio::time::interval_at(Instant::now() + TICK, TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        match blocking(&self.db, pause::read).await {
            Ok(paused) => self.paused = paused,
            Err(error) => tracing::error!(%error, "could not read the sync pause; running"),
        }
        self.reevaluate();
        loop {
            self.publish();
            let event = tokio::select! {
                command = self.rx.recv() => Event::Command(command),
                done = join(&mut self.running) => Event::Done(Box::new(done)),
                () = sleep(self.push_at) => Event::PushDue,
                _ = tick.tick() => Event::Tick,
                () = sleep(self.emit_at) => Event::Emit,
                _ = self.gate_changes.changed() => Event::GateChanged,
                power = recv(&mut self.power) => Event::Power(power),
            };
            match event {
                Event::Command(None) => {
                    self.shut_down();
                    return;
                }
                Event::Command(Some(Command::Stop(reply))) => {
                    self.shut_down();
                    let _ = reply.send(());
                    return;
                }
                Event::Command(Some(command)) => self.command(command).await,
                Event::Done(done) => {
                    self.running = None;
                    match *done {
                        Ok(done) => self.finished(done).await,
                        Err(error) => tracing::error!(%error, "a sync pass task ended abnormally"),
                    }
                    self.after_pass();
                }
                Event::PushDue => {
                    self.push_at = None;
                    self.request(Trigger::Push);
                }
                Event::Tick => {
                    let since = self.last_pull.map(|at| at.elapsed());
                    if tick_pulls(self.socket_held, since) {
                        self.request(Trigger::Tick);
                    }
                    self.socket_held = self.socket.is_some_and(|(_, connected)| connected);
                }
                Event::Emit => self.emit_now(),
                Event::GateChanged => self.reevaluate(),
                Event::Power(Ok(PowerEvent::Resume)) => self.request(Trigger::PowerResume),
                Event::Power(Ok(_) | Err(broadcast::error::RecvError::Lagged(_))) => {}
                Event::Power(Err(broadcast::error::RecvError::Closed)) => self.power = None,
            }
        }
    }

    async fn command(&mut self, command: Command) {
        match command {
            Command::Trigger(trigger) => self.request(trigger),
            Command::RequestPush => self.push_at = Some(Instant::now() + PUSH_DEBOUNCE),
            Command::SyncNow(reply) => self.sync_now(reply).await,
            Command::SetPaused(paused, reply) => {
                let outcome = self.set_paused(paused).await;
                if outcome.is_ok() && !paused {
                    self.request(Trigger::Explicit);
                }
                let _ = reply.send(outcome);
            }
            Command::Reachable(reachable) => {
                let online = reachable != Reachable::Offline;
                if online != self.online {
                    self.online = online;
                    self.offline_since = (!online).then(now_ms);
                    if online {
                        self.request(Trigger::Online);
                    }
                }
            }
            Command::Socket {
                generation,
                connected,
            } => {
                if self.socket.is_some_and(|(seen, _)| seen != generation) || !connected {
                    self.socket_held = false;
                }
                self.socket = Some((generation, connected));
            }
            Command::Stop(_) => unreachable!("handled by the loop"),
        }
    }

    /// Re-reads the gate. Starting runs a pass (which opens the driver); stopping closes it.
    fn reevaluate(&mut self) {
        let decision = gate::evaluate(&self.gate.inputs(self.backend.auth_facts()));
        let was = std::mem::replace(&mut self.decision, decision);
        if decision != GateDecision::Start {
            self.close_driver();
            return;
        }
        if let Some(driver) = &self.driver
            && self.gate.entitlement() == Entitlement::Entitled
        {
            driver.set_entitled(true);
        }
        if was != GateDecision::Start {
            self.request(Trigger::Start);
        }
    }

    fn blocked(&self) -> Option<Blocked> {
        if self.decision != GateDecision::Start {
            return Some(Blocked::Unavailable);
        }
        if self.paused {
            return Some(Blocked::Paused);
        }
        if !self.online {
            return Some(Blocked::Offline);
        }
        if self
            .blocked_until
            .is_some_and(|until| until > Instant::now())
        {
            return Some(Blocked::Failed);
        }
        None
    }

    fn request(&mut self, trigger: Trigger) {
        if self.blocked().is_some() {
            return;
        }
        if self.running.is_some() {
            self.trailing = Some(trigger);
            return;
        }
        let id = self.next_id;
        self.next_id += 1;
        let existing = self.driver.clone();
        let backend = Arc::clone(&self.backend);
        let db = self.db.clone();
        let entitled = self.gate.entitlement() == Entitlement::Entitled;
        let started = Instant::now();
        self.running = Some(tokio::spawn(async move {
            let driver = match existing {
                Some(driver) => Ok(driver),
                None => backend.open().await.inspect(|driver| {
                    if entitled {
                        driver.set_entitled(true);
                    }
                }),
            };
            let report = match &driver {
                Ok(driver) => driver.run_pass(trigger.pass_trigger()).await,
                Err(_) => None,
            };
            let pending = match blocking(&db, outbox::depth).await {
                Ok(depth) => u32::try_from(depth).ok(),
                Err(error) => {
                    tracing::warn!(%error, "could not read the outbox depth");
                    None
                }
            };
            PassDone {
                id,
                started,
                driver,
                report,
                pending,
            }
        }));
    }

    async fn finished(&mut self, done: PassDone) {
        if let Some(pending) = done.pending {
            self.pending = pending;
        }
        let driver = match done.driver {
            Ok(driver) => driver,
            Err(error) => {
                tracing::warn!(%error, "sync did not start; retried on the next trigger");
                self.last_error = Some((error.to_string(), SyncErrorCategory::of(&error)));
                self.answer(
                    done.id,
                    TriggerSyncResult::blocked(Blocked::Failed, Some(error)),
                );
                return;
            }
        };
        if self.paused {
            driver.pause();
        }
        self.driver = Some(Arc::clone(&driver));
        let result = match &done.report {
            None => TriggerSyncResult::blocked(Blocked::Paused, None),
            Some(report) => self.record(report, done.started),
        };
        if let Some(clock) = driver.server_clock()
            && clock.skew_ms().abs() > MAX_CLOCK_SKEW_MS
            && !self.paused
        {
            tracing::warn!(
                skew_ms = clock.skew_ms(),
                "the clock is off from the server's; sync paused"
            );
            if let Err(error) = self.set_paused(true).await {
                tracing::error!(%error, "could not persist the clock-skew pause");
            }
        }
        let result = if self.paused {
            TriggerSyncResult::blocked(Blocked::Paused, None)
        } else {
            result
        };
        self.answer(done.id, result);
    }

    /// Takes in what one pass did and says how a Sync Now caller sees it.
    fn record(&mut self, report: &PassReport, started: Instant) -> TriggerSyncResult {
        self.engine = Some(report.final_state);
        if report.transitions.contains(&SyncState::Applying) {
            self.last_pull = Some(started);
        }
        match &report.error {
            Some(error) => {
                if let Some(retry_after) = rate_limited(error) {
                    self.rate_failures += 1;
                    let wait = rate_limit_backoff(retry_after, self.rate_failures);
                    self.blocked_until = Some(Instant::now() + wait);
                }
                self.last_error = Some((error.to_string(), SyncErrorCategory::of(error)));
                if report.final_state == SyncState::Offline {
                    return TriggerSyncResult::blocked(Blocked::Offline, None);
                }
                TriggerSyncResult::blocked(Blocked::Failed, Some(error.clone()))
            }
            None if report.final_state == SyncState::Offline => {
                TriggerSyncResult::blocked(Blocked::Offline, None)
            }
            None => {
                self.rate_failures = 0;
                self.blocked_until = None;
                self.last_error = None;
                self.last_sync_at = Some(now_ms());
                TriggerSyncResult::ok()
            }
        }
    }

    /// The trailing pass, or an answer for every Sync Now caller nothing will run for.
    fn after_pass(&mut self) {
        if let Some(trigger) = self.trailing.take() {
            self.request(trigger);
        }
        if self.running.is_none() {
            let result = self.blocked_result(self.blocked().unwrap_or(Blocked::Unavailable));
            for (_, reply) in self.waiters.drain(..) {
                let _ = reply.send(result.clone());
            }
        }
    }

    async fn sync_now(&mut self, reply: oneshot::Sender<TriggerSyncResult>) {
        if self.paused
            && let Err(error) = self.set_paused(false).await
        {
            tracing::error!(%error, "could not persist the end of the pause");
        }
        if !self.backend.auth_facts().signed_in {
            let _ = reply.send(TriggerSyncResult::blocked(Blocked::SignedOut, None));
            return;
        }
        self.reevaluate();
        if let Some(reason) = self.blocked() {
            let _ = reply.send(self.blocked_result(reason));
            return;
        }
        // A running pass may have read the feed before this request: the answer comes from the
        // next pass that starts.
        let target = self.next_id;
        self.request(Trigger::Explicit);
        self.waiters.push((target, reply));
    }

    fn blocked_result(&self, reason: Blocked) -> TriggerSyncResult {
        let mut result = TriggerSyncResult::blocked(reason, None);
        if reason == Blocked::Failed
            && let Some(until) = self.blocked_until
        {
            let secs = until
                .saturating_duration_since(Instant::now())
                .as_secs_f64()
                .ceil();
            result.error = Some(format!("Rate limited. Resuming in {secs}s."));
        }
        result
    }

    fn answer(&mut self, id: u64, result: TriggerSyncResult) {
        let mut kept = Vec::new();
        for (target, reply) in self.waiters.drain(..) {
            if target <= id {
                let _ = reply.send(result.clone());
            } else {
                kept.push((target, reply));
            }
        }
        self.waiters = kept;
    }

    async fn set_paused(&mut self, paused: bool) -> Result<(), StorageError> {
        let db = self.db.clone();
        let write = move || db.call_blocking(move |conn| pause::write(conn, paused));
        tokio::task::spawn_blocking(write)
            .await
            .map_err(|error| StorageError::Failed {
                what: format!("the pause write task failed: {error}"),
            })??;
        self.paused = paused;
        if let Some(driver) = &self.driver {
            if paused {
                driver.pause();
            } else {
                driver.resume();
            }
        }
        Ok(())
    }

    fn close_driver(&mut self) {
        if let Some(running) = self.running.take() {
            running.abort();
        }
        self.trailing = None;
        self.push_at = None;
        self.engine = None;
        if self.driver.take().is_some() {
            self.backend.close();
        }
    }

    fn shut_down(&mut self) {
        self.close_driver();
        for (_, reply) in self.waiters.drain(..) {
            let _ = reply.send(TriggerSyncResult::blocked(Blocked::Unavailable, None));
        }
    }

    fn facts(&self) -> StatusFacts {
        StatusFacts {
            gate: self.decision,
            paused: self.paused,
            online: self.online,
            syncing: self.running.is_some(),
            engine: self.engine,
            last_error: self.last_error.clone(),
            last_sync_at: self.last_sync_at,
            pending: self.pending,
            offline_since: self.offline_since,
        }
    }

    /// Publishes a changed status: at once when the last event is 100 ms old, else when it will
    /// be, with whatever status is latest then.
    fn publish(&mut self) {
        let status = status::derive(&self.facts());
        self.status_tx.send_if_modified(|current| {
            let changed = *current != status;
            *current = status;
            changed
        });
        if self.emitted.as_ref() == Some(&*self.status_tx.borrow()) || self.emit_at.is_some() {
            return;
        }
        match self.last_emit {
            Some(at) if at.elapsed() < STATUS_THROTTLE => self.emit_at = Some(at + STATUS_THROTTLE),
            _ => self.emit_now(),
        }
    }

    fn emit_now(&mut self) {
        self.emit_at = None;
        let status = self.status_tx.borrow().clone();
        if self.emitted.as_ref() == Some(&status) {
            return;
        }
        (self.on_status)(&status);
        self.emitted = Some(status);
        self.last_emit = Some(Instant::now());
    }
}

/// `Some(retry_after)` for a `429`.
fn rate_limited(error: &SyncError) -> Option<Option<Duration>> {
    match error {
        SyncError::Api {
            source: ApiError::RateLimited { retry_after_s, .. },
        } => Some(retry_after_s.map(Duration::from_secs)),
        SyncError::Api {
            source: ApiError::Status { status: 429, .. },
        } => Some(None),
        _ => None,
    }
}

/// A read of `data.db` on the blocking pool (crates/AGENTS.md: a blocking core call runs inside
/// `spawn_blocking`).
async fn blocking<T: Send + 'static>(
    db: &Db,
    read: fn(&rusqlite::Connection) -> Result<T, StorageError>,
) -> Result<T, StorageError> {
    let db = db.clone();
    tokio::task::spawn_blocking(move || db.read_blocking(read))
        .await
        .map_err(|error| StorageError::Failed {
            what: format!("the read task failed: {error}"),
        })?
}

async fn join(
    running: &mut Option<JoinHandle<PassDone>>,
) -> Result<PassDone, tokio::task::JoinError> {
    match running {
        Some(handle) => handle.await,
        None => std::future::pending().await,
    }
}

async fn sleep(until: Option<Instant>) {
    match until {
        Some(until) => tokio::time::sleep_until(until).await,
        None => std::future::pending().await,
    }
}

async fn recv(
    power: &mut Option<broadcast::Receiver<PowerEvent>>,
) -> Result<PowerEvent, broadcast::error::RecvError> {
    match power {
        Some(power) => power.recv().await,
        None => std::future::pending().await,
    }
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}
