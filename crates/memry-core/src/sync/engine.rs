//! The sync engine state machine, data-model §C.3 (FR-035, FR-070, FR-075).
//!
//! The states and the edges are [`super::state`]; this file is *when* each
//! edge is taken, and one rule dominates it:
//!
//! > **Every pass is serialised.** Two concurrent passes race the cursor.
//!
//! The gate is one [`tokio::sync::Mutex`] held for the whole pass, so a second
//! caller **queues** rather than being dropped. Dropping the second call would
//! be simpler and is wrong: a socket hint that arrives while a timer pass is
//! finishing is exactly the hint that must not be lost, and the mobile
//! implementation had to add an exclusive queue after a wedge that left 83
//! items stuck. The lock is `tokio`'s and not `std`'s because it is held
//! across `await` points by construction.
//!
//! Three more rules, each of which is a way to get this wrong:
//!
//! - **Reads are never gated.** `ReadOnly`, `BlockedUpgrade` and `Unentitled`
//!   all keep pulling. The server does not gate `GET` either (chapter 11
//!   §11.4), so this is the client agreeing with the server.
//! - **A blocked state parks the outbox**: no attempt, no backoff, no row
//!   removed (§11.9). A parked queue must drain at full speed the moment the
//!   policy clears, which is why nothing here touches a retry counter on the
//!   blocked path.
//! - **Policy is learned without attempting a write**, from `clientPolicy` on
//!   `GET /sync/status` (§11.8), polled on foreground, before draining a
//!   parked outbox, and on an interval of at most 300 s in the foreground
//!   (§11.8.1). There is no push channel for a flipped switch and a client
//!   MUST NOT wait for one.
//!
//! The push wave itself is not here: the engine owns *when* to push and
//! [`PushWave`] owns *how*, including chapter 05 §5.6's batch-halving ladder.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

use serde_json::Value as Json;

use crate::api::errors::{ApiError, TransportError};
use crate::protocol::http::{ApiRequest, Auth, HttpClient, RetryPolicy};
use crate::seams::reachability::{Reachability, Reachable};

use super::pull::{PullLoop, PullReport};
use super::state::{PassTrigger, SyncState, WriteGate, evaluate_gate, is_drawn};

/// §11.8.1: at most 300 seconds in the foreground, chosen to match
/// `CLOCK_SKEW_THRESHOLD_SECONDS` (chapter 05 §5.16) so a client that already
/// polls status for skew gets policy for free.
pub const POLICY_POLL_INTERVAL_MS: i64 = 300_000;

/// How many pages one pass will walk before yielding the gate.
///
/// A ceiling rather than "until `hasMore` is false", so a first sync cannot
/// hold the exclusive gate for the whole feed and starve a foreground pass.
pub const MAX_PAGES_PER_PASS: u32 = 50;

/// The push half of a pass, implemented by the outbox and the push wave
/// (T116, T117).
///
/// Two methods because the engine has to know whether to enter `Pushing` at
/// all: §C.3's edge is "outbox non-empty **and** policy allows writes", and a
/// pass that entered `Pushing` with nothing queued would report a push that
/// never happened.
#[async_trait::async_trait]
pub trait PushWave: Send + Sync {
    /// How many rows are queued. Never removes one.
    async fn pending(&self) -> Result<usize, ApiError>;

    /// Drains the wave. Chapter 05 §5.6's halving ladder and the 50-iteration
    /// cap belong to the implementation, not to the engine.
    async fn drain(&self) -> Result<(), ApiError>;
}

/// What one pass did, in enough detail to assert the drawn edges.
#[derive(Debug, Clone)]
pub struct PassReport {
    pub trigger: PassTrigger,
    /// Every state entered, in order. The first entry is the state the pass
    /// moved to first, not the state it started in.
    pub transitions: Vec<SyncState>,
    pub final_state: SyncState,
    pub pull: PullReport,
    /// The outbox was parked by a blocked policy: no attempt was made.
    pub parked: bool,
    pub pushed: bool,
}

/// The engine. One per vault.
pub struct SyncEngine {
    pull: Arc<PullLoop>,
    http: Arc<HttpClient>,
    reachability: Arc<dyn Reachability>,
    push: Option<Arc<dyn PushWave>>,
    /// The exclusive queue. Held for a whole pass.
    gate: tokio::sync::Mutex<()>,
    state: Mutex<SyncState>,
    policy: Mutex<WriteGate>,
    /// Epoch milliseconds of the last successful `GET /sync/status`, or 0.
    policy_checked_at: AtomicI64,
    /// §C.3's `Unentitled`. Chapter 11 says nothing about where an
    /// entitlement is read from and `GET /sync/status` does not carry one, so
    /// it is an input the account tier sets rather than something inferred
    /// here. Defaults to entitled: an unknown plan must never lock a paying
    /// user out of their own vault (§11.3's reasoning, applied).
    entitled: AtomicBool,
}

impl SyncEngine {
    pub fn new(
        pull: Arc<PullLoop>,
        http: Arc<HttpClient>,
        reachability: Arc<dyn Reachability>,
    ) -> Self {
        Self {
            pull,
            http,
            reachability,
            push: None,
            gate: tokio::sync::Mutex::new(()),
            state: Mutex::new(SyncState::Idle),
            policy: Mutex::new(WriteGate::Open),
            policy_checked_at: AtomicI64::new(0),
            entitled: AtomicBool::new(true),
        }
    }

    pub fn with_push(mut self, push: Arc<dyn PushWave>) -> Self {
        self.push = Some(push);
        self
    }

    pub fn state(&self) -> SyncState {
        *self
            .state
            .lock()
            .expect("the state mutex is never poisoned")
    }

    pub fn write_gate(&self) -> WriteGate {
        self.policy
            .lock()
            .expect("the policy mutex is never poisoned")
            .clone()
    }

    /// The account tier's answer to "does this account have an active plan".
    pub fn set_entitled(&self, entitled: bool) {
        self.entitled.store(entitled, Ordering::Relaxed);
    }

    /// One pass, serialised against every other pass.
    ///
    /// The `.await` on the gate is the exclusive queue: a concurrent caller
    /// waits here and then runs its own pass against the cursor this one
    /// committed.
    pub async fn run_pass(&self, trigger: PassTrigger) -> PassReport {
        let _gate = self.gate.lock().await;
        let mut trail = Trail::new(self.state());

        // `Offline`, `Failed` and `Refused` each draw exactly one exit, and it
        // is to `Idle`. Taking it here is what makes the next pass legal from
        // any of the three.
        if matches!(
            trail.current,
            SyncState::Offline | SyncState::Failed | SyncState::Refused
        ) {
            trail.enter(SyncState::Idle);
        }

        if self.reachability.current() == Reachable::Offline {
            trail.enter(SyncState::Offline);
            return self.finish(trigger, trail, PullReport::default(), false, false);
        }

        let gate = self.refresh_policy(trigger).await;

        // Reads are never gated, so the pull runs before the gate is consulted
        // for anything.
        let (pull, pull_failed) = self.pull_pages(&mut trail).await;
        if trail.current == SyncState::Refused {
            return self.finish(trigger, trail, pull, false, false);
        }
        if pull_failed {
            return self.finish(trigger, trail, pull, false, false);
        }

        if let Some(blocked) = gate.blocked_state() {
            // Parked: no attempt, no backoff, no row removed.
            trail.enter(blocked);
            return self.finish(trigger, trail, pull, true, false);
        }

        let pushed = self.push_wave(&mut trail).await;
        self.finish(trigger, trail, pull, false, pushed)
    }

    /// `Idle -> Pulling -> Applying -> (Pulling | Idle | Refused)`, one lap
    /// per page.
    async fn pull_pages(&self, trail: &mut Trail) -> (PullReport, bool) {
        let mut total = PullReport::default();
        for _ in 0..MAX_PAGES_PER_PASS {
            trail.enter(SyncState::Pulling);
            let page = match self.pull.pull_page().await {
                Ok(page) => page,
                Err(error) => {
                    // A transport failure that says "offline" is `Offline`,
                    // not `Failed`: the exit is a reachability transition
                    // rather than a backoff timer.
                    trail.enter(if is_offline(&error) {
                        SyncState::Offline
                    } else {
                        SyncState::Failed
                    });
                    return (total, true);
                }
            };
            trail.enter(SyncState::Applying);

            total.pages += page.pages;
            total.applied += page.applied;
            total.deleted += page.deleted;
            total.corrupt += page.corrupt;
            total.expired += page.expired;
            total.dropped_pages += page.dropped_pages;
            total.cursor = page.cursor.clone();
            total.has_more = page.has_more;
            total.refused = page.refused;

            if page.refused {
                trail.enter(SyncState::Refused);
                return (total, false);
            }
            if !page.has_more {
                trail.enter(SyncState::Idle);
                return (total, false);
            }
        }
        // The page ceiling: caught up as far as this pass goes, and the next
        // pass resumes from the committed cursor.
        trail.enter(SyncState::Idle);
        (total, false)
    }

    /// `Idle -> Pushing -> (Idle | ReadOnly | BlockedUpgrade | Failed)`.
    async fn push_wave(&self, trail: &mut Trail) -> bool {
        let Some(push) = self.push.as_ref() else {
            return false;
        };
        match push.pending().await {
            Ok(0) => return false,
            Ok(_) => {}
            Err(_) => {
                trail.enter(SyncState::Failed);
                return false;
            }
        }
        trail.enter(SyncState::Pushing);
        match push.drain().await {
            Ok(()) => {
                trail.enter(SyncState::Idle);
                true
            }
            // §11.9: a mid-wave 403 or 426 is not a sync failure the user can
            // retry. The gate is updated so the next pass parks instead of
            // attempting again.
            Err(ApiError::WritesDisabled { .. }) => {
                self.set_gate(WriteGate::ReadOnly);
                trail.enter(SyncState::ReadOnly);
                false
            }
            Err(ApiError::UpgradeRequired { min_version, .. }) => {
                self.set_gate(WriteGate::BlockedUpgrade {
                    min_version: min_version.clone(),
                });
                trail.enter(SyncState::BlockedUpgrade);
                false
            }
            Err(_) => {
                trail.enter(SyncState::Failed);
                false
            }
        }
    }

    /// §11.8.1's poll schedule. A failed poll keeps the last known gate: a
    /// status call that did not answer is not evidence that writes are off.
    async fn refresh_policy(&self, trigger: PassTrigger) -> WriteGate {
        let known = self.write_gate();
        let due = trigger == PassTrigger::Foreground
            || known != WriteGate::Open
            || now_ms() - self.policy_checked_at.load(Ordering::Relaxed) >= POLICY_POLL_INTERVAL_MS;
        if !due {
            return known;
        }

        // Chapter 07 §7.10's polled ladder: `retryOn429: false`, because for a
        // polled call the poll cadence is itself the retry.
        let request = ApiRequest::get("/sync/status")
            .auth(Auth::Session)
            .retry(RetryPolicy::polled());
        let Ok(body) = self.http.send_json::<Json>(request).await else {
            return known;
        };
        self.policy_checked_at.store(now_ms(), Ordering::Relaxed);

        // §11.8: `clientPolicy` is omitted entirely for a legacy client. This
        // client always identifies itself, so an omitted block means the
        // server had nothing to say, which §11.7 resolves to allowed.
        let policy = body.get("clientPolicy");
        let writes_enabled = policy
            .and_then(|p| p.get("writesEnabled"))
            .and_then(Json::as_bool)
            .unwrap_or(true);
        let min_write_version = policy
            .and_then(|p| p.get("minWriteVersion"))
            .and_then(Json::as_str);
        let gate = evaluate_gate(
            writes_enabled,
            min_write_version,
            self.http.identity().app_version(),
            self.entitled.load(Ordering::Relaxed),
        );
        self.set_gate(gate.clone());
        gate
    }

    fn set_gate(&self, gate: WriteGate) {
        *self
            .policy
            .lock()
            .expect("the policy mutex is never poisoned") = gate;
    }

    fn finish(
        &self,
        trigger: PassTrigger,
        trail: Trail,
        pull: PullReport,
        parked: bool,
        pushed: bool,
    ) -> PassReport {
        *self
            .state
            .lock()
            .expect("the state mutex is never poisoned") = trail.current;
        PassReport {
            trigger,
            transitions: trail.entered,
            final_state: trail.current,
            pull,
            parked,
            pushed,
        }
    }
}

/// The states a pass walked, checked against the diagram as it goes.
struct Trail {
    current: SyncState,
    entered: Vec<SyncState>,
}

impl Trail {
    fn new(current: SyncState) -> Self {
        Self {
            current,
            entered: Vec::new(),
        }
    }

    /// Takes one edge. An edge §C.3 does not draw is a bug in this file, and
    /// the assertion is what stops it reaching a shell as a state nobody can
    /// explain.
    fn enter(&mut self, next: SyncState) {
        debug_assert!(
            is_drawn(self.current, next),
            "data-model §C.3 draws no edge from {:?} to {next:?}",
            self.current
        );
        self.current = next;
        self.entered.push(next);
    }
}

/// Whether a pull failure is the reachability case rather than the backoff
/// case.
fn is_offline(error: &super::pull::PullError) -> bool {
    matches!(
        error,
        super::pull::PullError::Api {
            source: ApiError::Transport {
                source: TransportError::Offline
            }
        }
    )
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}
