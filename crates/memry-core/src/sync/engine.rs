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

use serde_json::Value as Json;

use crate::api::errors::{ApiError, TransportError};
use crate::protocol::http::{ApiRequest, Auth, HttpClient, RetryPolicy};
use crate::seams::reachability::{Reachability, Reachable};

use super::policy::PolicyTier;
use super::pull::{PullLoop, PullReport};
use super::state::{PassTrigger, SyncState, WriteGate, is_drawn};

pub use super::policy::POLICY_POLL_INTERVAL_MS;

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
    /// Chapter 11's three independent inputs and the one gate derived from
    /// them ([`super::policy`]). `Unentitled` is entered **reactively on a
    /// `402 SYNC_PAYMENT_REQUIRED`** from any `/sync/*` route (§11.7.1) and
    /// starts present: an unknown plan must never lock a paying user out of
    /// their own vault (§11.3's reasoning, applied).
    policy: PolicyTier,
}

impl SyncEngine {
    pub fn new(
        pull: Arc<PullLoop>,
        http: Arc<HttpClient>,
        reachability: Arc<dyn Reachability>,
    ) -> Self {
        let policy = PolicyTier::new(http.identity().app_version());
        Self {
            pull,
            http,
            reachability,
            push: None,
            gate: tokio::sync::Mutex::new(()),
            state: Mutex::new(SyncState::Idle),
            policy,
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
        self.policy.gate()
    }

    /// Chapter 11's three inputs, for a shell that wants to explain the gate
    /// rather than just obey it.
    pub fn policy(&self) -> &PolicyTier {
        &self.policy
    }

    /// The account tier's answer to "does this account have an active plan".
    ///
    /// The **only** way out of `Unentitled`: §11.7.1 says `clientPolicy`
    /// carries no entitlement field, and a parked outbox attempts no write
    /// that could earn a 2xx.
    pub fn set_entitled(&self, entitled: bool) {
        self.policy.set_entitled(entitled);
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
                    // §11.7.1: `Unentitled` is entered reactively on a `402`
                    // from **any** `/sync/*` route, and the pull routes are
                    // some of them. Reads are not gated, so this does not
                    // change the pull's own outcome — it parks the outbox on
                    // the next pass.
                    if let super::pull::PullError::Api { source } = &error {
                        self.policy.observe(source);
                    }
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
            total.skipped += page.skipped;
            total.expired += page.expired;
            total.dropped_pages += page.dropped_pages;
            total
                .purged_documents
                .extend(page.purged_documents.iter().cloned());
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
            // §11.9: a mid-wave 403, 426 or 402 is not a sync failure the
            // user can retry. The policy tier records the fact so the next
            // pass parks instead of attempting again, and **no attempt
            // accrues backoff**: a parked queue must drain at full speed the
            // moment the policy clears.
            Err(error) => {
                let blocked = self.policy.observe(&error);
                trail.enter(blocked.unwrap_or(SyncState::Failed));
                false
            }
        }
    }

    /// §11.8.1's poll schedule. A failed poll keeps the last known gate: a
    /// status call that did not answer is not evidence that writes are off.
    ///
    /// It **is** evidence when the answer was a `402`: §11.7.1 makes every
    /// `/sync/*` route a source of `Unentitled`, and `/sync/status` is one of
    /// them, so the failure is offered to the policy tier before it is
    /// discarded.
    async fn refresh_policy(&self, trigger: PassTrigger) -> WriteGate {
        if !self
            .policy
            .poll_due(now_ms(), trigger == PassTrigger::Foreground)
        {
            return self.write_gate();
        }

        // Chapter 07 §7.10's polled ladder: `retryOn429: false`, because for a
        // polled call the poll cadence is itself the retry.
        let request = ApiRequest::get("/sync/status")
            .auth(Auth::Session)
            .retry(RetryPolicy::polled());
        match self.http.send_json::<Json>(request).await {
            Ok(body) => self.policy.learn(&body, now_ms()),
            Err(error) => {
                self.policy.observe(&error);
                self.write_gate()
            }
        }
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
