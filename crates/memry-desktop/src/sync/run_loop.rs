//! The supervisor's loop: every decision of [`super::supervisor::SyncSupervisor`] is taken here,
//! on one task, from one event at a time.

use std::sync::Arc;

use memry_core::api::errors::StorageError;
use memry_core::seams::reachability::Reachable;
use memry_core::storage::Db;
use memry_core::sync::pause;
use memry_core::sync::policy::ServerClock;
use memry_core::sync::socket_run::TerminalLatch;
use memry_core::sync::state::SyncState;
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::backend::{SyncBackend, SyncPasses};
use super::error_category::SyncErrorCategory;
use super::events::OnSyncEvent;
use super::gate::{self, AuthFacts, Entitlement, GateDecision, SyncStartGate};
use super::realtime::SocketEnd;
use super::result::{SyncNowBlockedReason as Blocked, TriggerSyncResult};
use super::signals::Signals;
use super::status::{self, StatusFacts, SyncStatus};
use super::supervisor::{Command, SupervisorParts};
use super::triggers::{PUSH_DEBOUNCE, SNAPSHOT_TICK, STATUS_THROTTLE, TICK, Trigger, tick_pulls};
use crate::shell::power::PowerEvent;

#[path = "run_loop_pass.rs"]
mod pass;
#[path = "run_loop_pause.rs"]
mod paused;
#[path = "run_loop_realtime.rs"]
mod realtime;

use pass::PassDone;
use realtime::{KeychainWait, SocketTask};

enum Event {
    Command(Option<Command>),
    /// `None`: the handle's stop cut the pass.
    Done(Box<Result<Option<PassDone>, tokio::task::JoinError>>),
    PushDue,
    /// The `429` window ended.
    RetryDue,
    Tick,
    Emit,
    GateChanged,
    Power(Result<PowerEvent, broadcast::error::RecvError>),
    /// The failure backoff ended.
    BackoffDue,
    SocketEnded(Result<SocketEnd, tokio::task::JoinError>),
    KeychainRetry,
    KeychainRecovered(Result<(), broadcast::error::RecvError>),
    SnapshotTick,
}

pub(super) struct Loop {
    backend: Arc<dyn SyncBackend>,
    gate: Arc<SyncStartGate>,
    db: Db,
    on_status: Arc<dyn Fn(&SyncStatus) + Send + Sync>,
    on_event: OnSyncEvent,
    power: Option<broadcast::Receiver<PowerEvent>>,
    keychain_recovered: Option<broadcast::Receiver<()>>,
    telemetry: Option<Arc<crate::telemetry::Service>>,
    /// The loop's own inbox, for the socket's frames.
    commands: mpsc::WeakUnboundedSender<Command>,
    signals: Arc<Signals>,
    status_tx: watch::Sender<SyncStatus>,
    /// The handle's stop, fired before it waits: the socket and the pass watch it.
    stopping: watch::Receiver<bool>,
    gate_changes: watch::Receiver<u64>,
    rx: mpsc::UnboundedReceiver<Command>,
    driver: Option<Arc<dyn SyncPasses>>,
    /// A pass may have opened a driver (and installed the at-rest key) since the last close.
    opened: bool,
    decision: GateDecision,
    paused: bool,
    /// `paused`, for the pass in flight ([`pass::run`]).
    pause: watch::Sender<bool>,
    online: bool,
    offline_since: Option<i64>,
    running: Option<JoinHandle<Option<PassDone>>>,
    next_id: u64,
    trailing: Option<Trigger>,
    push_at: Option<Instant>,
    /// When the last pass started: pushes keep 300 ms apart from it.
    last_start: Option<Instant>,
    blocked_until: Option<Instant>,
    rate_failures: u32,
    /// After a failed open or pass, automatic passes wait until then (5 s doubling to 5 min).
    backoff_until: Option<Instant>,
    failures: u32,
    /// A revoked device, a refused session or a pin failure: no pass runs again in this loop.
    latched: Option<SyncErrorCategory>,
    keychain: Option<KeychainWait>,
    realtime: Option<SocketTask>,
    socket_generation: u64,
    /// §9.9's latch, held across the sockets of every driver of this loop.
    socket_latch: Arc<TerminalLatch>,
    /// A terminal close or a pin failure: no socket again in this loop.
    socket_off: bool,
    /// The handshake was refused 401: no socket until a pass succeeds.
    socket_refused: bool,
    last_pull: Option<Instant>,
    socket: Option<(u64, bool)>,
    socket_held: bool,
    engine: Option<SyncState>,
    /// The last server clock reading acted on.
    seen_clock: Option<ServerClock>,
    /// The pause is the clock-skew one: ending it polls the server clock again.
    skew_paused: bool,
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
        commands: mpsc::WeakUnboundedSender<Command>,
        signals: Arc<Signals>,
        status_tx: watch::Sender<SyncStatus>,
        stopping: watch::Receiver<bool>,
        online: bool,
    ) -> Self {
        let gate_changes = parts.gate.subscribe();
        Self {
            backend: parts.backend,
            gate: parts.gate,
            db: parts.db,
            on_status: parts.on_status,
            on_event: parts.on_event,
            power: parts.power,
            keychain_recovered: parts.keychain_recovered,
            telemetry: parts.telemetry,
            commands,
            signals,
            status_tx,
            stopping,
            gate_changes,
            rx,
            driver: None,
            opened: false,
            decision: GateDecision::NotStarted(gate::SyncNotStartedReason::Unavailable),
            // `run` reads the persisted pause before it handles anything.
            paused: false,
            pause: watch::Sender::new(false),
            online,
            offline_since: (!online).then(now_ms),
            running: None,
            next_id: 0,
            trailing: None,
            push_at: None,
            last_start: None,
            blocked_until: None,
            rate_failures: 0,
            backoff_until: None,
            failures: 0,
            latched: None,
            keychain: None,
            realtime: None,
            socket_generation: 0,
            socket_latch: Arc::default(),
            socket_off: false,
            socket_refused: false,
            last_pull: None,
            socket: None,
            socket_held: false,
            engine: None,
            seen_clock: None,
            skew_paused: false,
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
        let mut snapshots = tokio::time::interval(SNAPSHOT_TICK);
        match blocking(&self.db, pause::read).await {
            Ok(paused) => {
                self.paused = paused;
                self.pause.send_replace(paused);
            }
            Err(error) => tracing::error!(%error, "could not read the sync pause; running"),
        }
        self.reevaluate().await;
        loop {
            self.publish();
            let event = tokio::select! {
                command = self.rx.recv() => Event::Command(command),
                done = join(&mut self.running) => Event::Done(Box::new(done)),
                () = sleep(self.push_at) => Event::PushDue,
                () = sleep(self.blocked_until) => Event::RetryDue,
                _ = tick.tick() => Event::Tick,
                _ = snapshots.tick() => Event::SnapshotTick,
                () = sleep(self.emit_at) => Event::Emit,
                _ = self.gate_changes.changed() => Event::GateChanged,
                power = recv(&mut self.power) => Event::Power(power),
                () = sleep(self.backoff_until) => Event::BackoffDue,
                end = realtime::join(&mut self.realtime) => Event::SocketEnded(end),
                () = sleep(self.keychain.and_then(|wait| wait.retry_at)) => Event::KeychainRetry,
                recovered = recv(&mut self.keychain_recovered) => Event::KeychainRecovered(recovered),
            };
            match event {
                Event::Command(None) => {
                    self.close_driver();
                    return;
                }
                Event::Command(Some(Command::Stop(reply))) => {
                    // The next supervisor of this vault opens its own socket: this one ends
                    // first (§9.3).
                    if let Some(task) = self.realtime.take() {
                        task.socket.stop();
                        let _ = task.handle.await;
                    }
                    self.close_driver();
                    let _ = reply.send(());
                    return;
                }
                Event::Command(Some(command)) => self.command(command).await,
                Event::Done(done) => {
                    self.running = None;
                    match *done {
                        Ok(Some(done)) => self.finished(done).await,
                        // Stopping: the stop command follows.
                        Ok(None) => {}
                        Err(error) => self.pass_panicked(&error),
                    }
                    self.after_pass();
                }
                Event::PushDue => {
                    self.push_at = None;
                    self.request(Trigger::Push);
                }
                // `error-recovery-handler.ts:162-169`: a pass at the window's end, which pushes
                // whatever the window dropped.
                Event::RetryDue => {
                    self.blocked_until = None;
                    self.request(Trigger::Explicit);
                }
                Event::Tick => {
                    let since = self.last_pull.map(|at| at.elapsed());
                    if tick_pulls(self.socket_held, since) {
                        self.request(Trigger::Tick);
                    }
                    self.socket_held = self.socket.is_some_and(|(_, connected)| connected);
                }
                Event::Emit => self.emit_now(),
                Event::SnapshotTick => self.snapshot_tick(),
                Event::GateChanged => self.reevaluate().await,
                Event::Power(Ok(PowerEvent::Resume)) => self.request(Trigger::PowerResume),
                Event::Power(Ok(_) | Err(broadcast::error::RecvError::Lagged(_))) => {}
                Event::Power(Err(broadcast::error::RecvError::Closed)) => self.power = None,
                Event::BackoffDue => {
                    self.backoff_until = None;
                    self.request(Trigger::Explicit);
                }
                Event::SocketEnded(end) => self.socket_ended(end),
                Event::KeychainRetry => self.retry_keychain("timer").await,
                Event::KeychainRecovered(Ok(()) | Err(broadcast::error::RecvError::Lagged(_))) => {
                    if self.keychain.is_some() {
                        self.retry_keychain("keychain-recovered").await;
                    }
                }
                Event::KeychainRecovered(Err(broadcast::error::RecvError::Closed)) => {
                    self.keychain_recovered = None;
                }
            }
        }
    }

    async fn command(&mut self, command: Command) {
        match command {
            Command::Trigger(trigger) => self.request(trigger),
            // Leading edge with a trailing guard (`push-coordinator.ts:585-609`, #2289): at
            // once after a quiet window, else once when the window ends; never re-armed.
            Command::RequestPush => {
                if self.push_at.is_none() {
                    let now = Instant::now();
                    let window = self.last_start.map(|at| at + PUSH_DEBOUNCE);
                    self.push_at = Some(window.map_or(now, |end| end.max(now)));
                }
            }
            Command::SyncNow(reply) => self.sync_now(reply).await,
            Command::SetPaused(paused, reply) => self.pause_command(paused, reply).await,
            Command::Reachable(reachable) => {
                let online = reachable != Reachable::Offline;
                if online != self.online {
                    self.online = online;
                    self.offline_since = (!online).then(now_ms);
                    if online {
                        self.request(Trigger::Online);
                        self.ensure_socket();
                    } else {
                        // `engine.ts` disconnects the socket when the network goes.
                        self.stop_socket();
                    }
                }
            }
            Command::Socket {
                generation,
                connected,
            } => {
                // A late report from a socket this loop already stopped.
                if self.realtime.as_ref().map(|task| task.generation) != Some(generation) {
                    return;
                }
                if self.socket.is_some_and(|(seen, _)| seen != generation) || !connected {
                    self.socket_held = false;
                }
                self.socket = Some((generation, connected));
            }
            Command::Wake(cursor) => self.request(Trigger::Hint { cursor }),
            Command::Revoked => self.latch(SyncErrorCategory::DeviceRevoked),
            Command::FinalSnapshots(deadline, reply) => self.final_snapshots(deadline, reply).await,
            Command::Stop(_) => unreachable!("handled by the loop"),
        }
    }

    /// Re-reads the gate. Starting runs a pass (which opens the driver); stopping closes it.
    async fn reevaluate(&mut self) {
        let facts = self.backend.auth_facts().await;
        self.reevaluate_with(facts);
    }

    fn reevaluate_with(&mut self, facts: AuthFacts) {
        let inputs = self.gate.inputs(facts);
        let decision = gate::evaluate(&inputs);
        let was = std::mem::replace(&mut self.decision, decision);
        // The keychain only holds sync back when everything else would start it
        // (`runtime.ts:982`); otherwise the gate's own status shows.
        let readable = gate::GateInputs {
            auth: AuthFacts {
                key_verified: true,
                ..facts
            },
            ..inputs
        };
        if facts.keychain_unavailable && gate::evaluate(&readable) == GateDecision::Start {
            self.keychain_failed();
        } else {
            self.keychain = None;
        }
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
        if self.latched.is_some() {
            return Some(Blocked::Failed);
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
        // Edits, ticks and hints wait out a failure backoff; its end runs the pass they wanted.
        // Starts, resumes and Sync Now do not. Inclusive: an edit due at the very instant the
        // backoff ends would otherwise run beside the end's own pass.
        let automatic = matches!(
            trigger,
            Trigger::Push | Trigger::Tick | Trigger::Hint { .. }
        );
        if automatic
            && self
                .backoff_until
                .is_some_and(|until| until >= Instant::now())
        {
            return;
        }
        if self.running.is_some() {
            // One trailing pass; a policy-refreshing trigger is never traded for a weaker one.
            self.trailing = Some(
                self.trailing
                    .map_or(trigger, |queued| queued.stronger(trigger)),
            );
            return;
        }
        let id = self.next_id;
        self.next_id += 1;
        self.last_start = Some(Instant::now());
        self.opened |= self.driver.is_none();
        let pass = pass::run(
            id,
            trigger,
            match &self.driver {
                Some(driver) => pass::PassDriver::Held(Arc::clone(driver)),
                None => pass::PassDriver::Open {
                    entitled: self.gate.entitlement() == Entitlement::Entitled,
                    observers: self.observers(),
                },
            },
            Arc::clone(&self.backend),
            self.db.clone(),
            self.pause.subscribe(),
        );
        let mut stopping = self.stopping.clone();
        self.running = Some(tokio::spawn(async move {
            tokio::select! {
                done = pass => Some(done),
                _ = async { stopping.wait_for(|stop| *stop).await.map(|_| ()) } => None,
            }
        }));
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
            keychain_unavailable: self.keychain.is_some(),
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
    running: &mut Option<JoinHandle<Option<PassDone>>>,
) -> Result<Option<PassDone>, tokio::task::JoinError> {
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

async fn recv<T: Clone>(
    events: &mut Option<broadcast::Receiver<T>>,
) -> Result<T, broadcast::error::RecvError> {
    match events {
        Some(events) => events.recv().await,
        None => std::future::pending().await,
    }
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}
