//! The bodies pass's parallelism: several documents in flight at once, one
//! shared work list, and a 429 waited out rather than failing the run.
//!
//! Each document's progress is durable in its own `crdt:<docId>` cursor, so
//! pulling several at once changes nothing about a kill: a resumed run
//! re-reads every cursor and continues each document where it stopped.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::task::JoinSet;
use tokio::time::Instant;

use crate::api::errors::ApiError;
use crate::sync::body_pull::{BodyPull, BodyPullError, BodyPullReport};

use super::{FirstSyncPhase, FirstSyncProgress, ProgressSink};

/// Documents the bodies pass pulls at once while a bootstrap session elevates
/// the run (`crdt_pull` 3000/min, §10.7).
///
/// A fresh document costs two sequential requests (snapshot, then updates),
/// so one stream at ~200 ms a round trip is ~300 requests a minute and four
/// are ~1200: well under the elevated ceiling at ordinary latency, and still
/// under it at 100 ms. A 429 anyway is paused out, not failed
/// ([`MAX_RATE_LIMIT_PAUSES`]).
pub const BODY_CONCURRENCY_ELEVATED: usize = 4;

/// Steady state: one stream already runs at half of the unelevated 600/min,
/// so a second one would only buy 429s.
pub const BODY_CONCURRENCY_STEADY: usize = 1;

/// The longest `Retry-After` the bodies pass waits out itself. `crdt_pull` is a
/// sixty-second fixed window, so anything longer is not this limiter and is
/// returned to the caller instead of sat through.
pub const MAX_RATE_LIMIT_PAUSE_S: u64 = 60;

/// How many 429 pauses one bodies pass takes before it gives up and returns
/// the error. The run is resumable, so giving up loses no work; the bound only
/// stops a server that keeps refusing from holding the pass open forever.
pub const MAX_RATE_LIMIT_PAUSES: u32 = 8;
/// Pulls every document in `window`, newest first, `BODY_CONCURRENCY_*` at a
/// time. `elevated` is whether a bootstrap session widens `crdt_pull` for
/// this run.
pub(super) async fn pull_parallel(
    bodies: &Arc<BodyPull>,
    window: Vec<String>,
    elevated: bool,
    progress: &Arc<dyn ProgressSink>,
) -> Result<BodyPullReport, BodyPullError> {
    let workers = if elevated {
        BODY_CONCURRENCY_ELEVATED
    } else {
        BODY_CONCURRENCY_STEADY
    }
    .min(window.len());

    let queue = Arc::new(BodyQueue::new(window, Arc::clone(progress)));
    let mut running = JoinSet::new();
    for _ in 0..workers {
        running.spawn(body_worker(Arc::clone(bodies), Arc::clone(&queue)));
    }
    let mut report = BodyPullReport::default();
    while let Some(joined) = running.join_next().await {
        match joined {
            Ok(Ok(part)) => report.absorb(part),
            // Dropping the set aborts the other workers; whatever they stored
            // is already durable with its cursor.
            Ok(Err(error)) => return Err(error),
            Err(join) if join.is_panic() => std::panic::resume_unwind(join.into_panic()),
            // Only `abort` cancels a worker, and nothing here calls it.
            Err(_) => {}
        }
    }
    Ok(report)
}

/// The bodies pass's shared work list: the window, newest first, plus the
/// progress count and the 429 pause every worker honours.
struct BodyQueue {
    state: Mutex<QueueState>,
    total: u64,
    progress: Arc<dyn ProgressSink>,
}

struct QueueState {
    pending: VecDeque<String>,
    completed: u64,
    paused_until: Option<Instant>,
    pauses: u32,
}

impl BodyQueue {
    fn new(window: Vec<String>, progress: Arc<dyn ProgressSink>) -> Self {
        let total = window.len() as u64;
        Self {
            state: Mutex::new(QueueState {
                pending: window.into(),
                completed: 0,
                paused_until: None,
                pauses: 0,
            }),
            total,
            progress,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, QueueState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The next document, after any pause another worker's 429 set.
    async fn next(&self) -> Option<String> {
        loop {
            let until = self.lock().paused_until;
            match until {
                Some(until) if until > Instant::now() => tokio::time::sleep_until(until).await,
                _ => return self.lock().pending.pop_front(),
            }
        }
    }

    /// Counted and reported under the lock, so two workers finishing together
    /// can never report their counts out of order and move the bar backwards.
    fn finished(&self) {
        let mut state = self.lock();
        state.completed += 1;
        self.progress.progress(FirstSyncProgress {
            phase: FirstSyncPhase::Bodies,
            completed: state.completed,
            total: self.total,
        });
    }

    /// Puts a rate-limited document back at the front and pauses every worker
    /// until the window turns. `false` once the pass has paused too often.
    fn rate_limited(&self, doc_id: String, retry_after_s: u64) -> bool {
        let mut state = self.lock();
        state.pauses += 1;
        if state.pauses > MAX_RATE_LIMIT_PAUSES {
            return false;
        }
        let until = Instant::now() + Duration::from_secs(retry_after_s);
        state.paused_until = Some(
            state
                .paused_until
                .map_or(until, |current| current.max(until)),
        );
        state.pending.push_front(doc_id);
        true
    }
}

/// One stream of the bodies pass: pulls documents off the shared queue until
/// it is empty.
///
/// A 429 is the only error it absorbs. `crdt_pull` pull requests are
/// `retryOn429: false` (§7.10), so without this one refused request would
/// fail the whole first sync; with it the document goes back on the queue and
/// every stream waits out the `Retry-After`.
async fn body_worker(
    bodies: Arc<BodyPull>,
    queue: Arc<BodyQueue>,
) -> Result<BodyPullReport, BodyPullError> {
    let mut report = BodyPullReport::default();
    while let Some(doc_id) = queue.next().await {
        match bodies.pull_document(&doc_id).await {
            Ok(part) => {
                report.absorb(part);
                queue.finished();
            }
            Err(error) => {
                let Some(wait_s) = rate_limit_pause(&error) else {
                    return Err(error);
                };
                if !queue.rate_limited(doc_id, wait_s) {
                    return Err(error);
                }
            }
        }
    }
    Ok(report)
}

/// The pause a 429 asks for, when it is one the pass may wait out itself.
fn rate_limit_pause(error: &BodyPullError) -> Option<u64> {
    let BodyPullError::Api {
        source: ApiError::RateLimited { retry_after_s, .. },
    } = error
    else {
        return None;
    };
    // A 429 without `Retry-After` still means "not now"; one second is the
    // server's own floor (`Math.max(retryAfter, 1)`).
    let wait_s = retry_after_s.unwrap_or(1).max(1);
    (wait_s <= MAX_RATE_LIMIT_PAUSE_S).then_some(wait_s)
}
