//! The bodies pass's parallelism: several documents in flight at once, one
//! shared work list, and a 429 waited out rather than failing the run.
//!
//! Each document's progress is durable in its own `crdt:<docId>` cursor, so
//! pulling several at once changes nothing about a kill: a resumed run
//! re-reads every cursor and continues each document where it stopped.
//!
//! A resumed run probes the documents that hold a cursor first, a hundred per
//! request, and counts every one the probe shows current as done before any
//! worker starts. Without that, each relaunch restarted the count at 0 and
//! spent a probe and an updates page on every finished document.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::task::JoinSet;
use tokio::time::Instant;

use crate::api::errors::ApiError;
use crate::sync::body_debt;
use crate::sync::body_pull::{BodyPull, BodyPullError, BodyPullReport, PROBE_CHUNK, Probed};
use crate::sync::first_sync_store::{
    owe_out_of_window, read_meta, recent_document_ids, write_meta,
};

use super::{
    FirstSync, FirstSyncError, FirstSyncPhase, FirstSyncProgress, FirstSyncReport,
    META_FIRST_SYNC_BODY_PACKS, ProgressSink, now_ms,
};

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
impl FirstSync {
    /// Bodies from packs, once (`pack_bootstrap/bodies.rs`). Answers whether
    /// the phase settled or owed every live document, which makes the debts
    /// the bodies pass's work list.
    pub(super) async fn body_packs_pass(
        &self,
        report: &mut FirstSyncReport,
    ) -> Result<bool, FirstSyncError> {
        if let Some(text) = self
            .db
            .call(|conn| read_meta(conn, META_FIRST_SYNC_BODY_PACKS))
            .await?
        {
            return Ok(text == "1");
        }
        let Some(packs) = &self.packs else {
            return Ok(false);
        };
        let progress = Arc::clone(&self.progress);
        let on_progress = move |completed: u64, total: u64| {
            progress.progress(FirstSyncProgress {
                phase: FirstSyncPhase::Bodies,
                completed,
                total: total.max(completed),
            });
        };
        report.body_packs = packs.run_bodies(now_ms() / 1_000, &on_progress).await?;
        if !report.body_packs.ran {
            // The phase writes `1` in the transaction that settles; `0` sends
            // a resumed run straight to the item-granular bodies.
            self.db
                .call(|conn| write_meta(conn, META_FIRST_SYNC_BODY_PACKS, "0"))
                .await?;
        }
        Ok(report.body_packs.ran)
    }

    /// Pass three: bodies for the recent window.
    ///
    /// This is the pass that makes a note show its text. Everything above
    /// carries note *metadata*; a body edit's record push carries
    /// `content: null` (chapter 07's opening), so `yjs_updates` fills here or
    /// it never fills at all.
    ///
    /// After the body pack phase every live document is settled or owed, so
    /// the window is the owed documents in it, and each one that reaches its
    /// head is settled. Otherwise the window is pulled and everything outside
    /// it is owed.
    pub(super) async fn bodies_pass(
        &self,
        window_start: i64,
        body_packs_used: bool,
        report: &mut FirstSyncReport,
    ) -> Result<(), FirstSyncError> {
        let window = self
            .db
            .call(move |conn| recent_document_ids(conn, window_start))
            .await?;
        // §7.15: a tombstoned document is excluded by the query above. The
        // server still answers with the surviving log, and applying it would
        // resurrect a body the record feed says is deleted.
        let window = if body_packs_used {
            self.db
                .call(move |conn| {
                    let mut owed = Vec::new();
                    for doc_id in window {
                        if body_debt::is_owed(conn, &doc_id)? {
                            owed.push(doc_id);
                        }
                    }
                    Ok(owed)
                })
                .await?
        } else {
            // Owed before the pull; every later pass's body step sweeps the rest.
            let pulled = window.clone();
            (self.db)
                .call(move |conn| owe_out_of_window(conn, &pulled))
                .await?;
            window
        };

        // Renewed once here rather than per request: the document pulls run
        // concurrently and must not race each other into two renewals. The
        // pass is minutes long against a sixty-minute token, so one check is
        // enough; a lapsed token only drops the header (§10.11 rule 2).
        let elevated = match &self.bootstrap {
            Some(bootstrap) => bootstrap.renew_if_due(now_ms() / 1_000).await,
            None => false,
        };
        let pulled = pull_parallel(&self.bodies, window.clone(), elevated, &self.progress).await?;
        if body_packs_used {
            let unfinished: Vec<String> = pulled
                .stopped
                .iter()
                .chain(&pulled.incomplete)
                .cloned()
                .collect();
            self.db
                .call(move |conn| {
                    for doc_id in window.iter().filter(|id| !unfinished.contains(id)) {
                        body_debt::settle(conn, doc_id)?;
                    }
                    Ok(())
                })
                .await?;
        }
        report.bodies.absorb(pulled);
        Ok(())
    }
}

/// Pulls every document in `window`, newest first, `BODY_CONCURRENCY_*` at a
/// time. `elevated` is whether a bootstrap session widens `crdt_pull` for
/// this run.
async fn pull_parallel(
    bodies: &Arc<BodyPull>,
    window: Vec<String>,
    elevated: bool,
    progress: &Arc<dyn ProgressSink>,
) -> Result<BodyPullReport, BodyPullError> {
    let mut report = BodyPullReport::default();
    let mut probed = HashMap::new();
    for chunk in window.chunks(PROBE_CHUNK) {
        probed.extend(
            bodies
                .probe_snapshot_meta(chunk, &mut report.requests)
                .await?,
        );
    }
    let total = window.len() as u64;
    let (current, pending): (Vec<String>, Vec<String>) = window
        .into_iter()
        .partition(|doc_id| probed.get(doc_id).is_some_and(|probed| probed.current));
    report.documents += current.len();

    let workers = if elevated {
        BODY_CONCURRENCY_ELEVATED
    } else {
        BODY_CONCURRENCY_STEADY
    }
    .min(pending.len());

    let queue = Arc::new(BodyQueue::new(
        pending,
        total,
        current.len() as u64,
        probed,
        Arc::clone(progress),
    ));
    let mut running = JoinSet::new();
    for _ in 0..workers {
        running.spawn(body_worker(Arc::clone(bodies), Arc::clone(&queue)));
    }
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
    probed: HashMap<String, Probed>,
    progress: Arc<dyn ProgressSink>,
}

struct QueueState {
    pending: VecDeque<String>,
    completed: u64,
    paused_until: Option<Instant>,
    pauses: u32,
}

impl BodyQueue {
    /// `completed` documents of `total` are already current, so the bar
    /// resumes where the last run left it rather than at 0.
    fn new(
        pending: Vec<String>,
        total: u64,
        completed: u64,
        probed: HashMap<String, Probed>,
        progress: Arc<dyn ProgressSink>,
    ) -> Self {
        if completed > 0 {
            progress.progress(FirstSyncProgress {
                phase: FirstSyncPhase::Bodies,
                completed,
                total,
            });
        }
        Self {
            state: Mutex::new(QueueState {
                pending: pending.into(),
                completed,
                paused_until: None,
                pauses: 0,
            }),
            total,
            probed,
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
        match bodies.pull_with(&doc_id, queue.probed.get(&doc_id)).await {
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
