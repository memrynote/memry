//! The runner loop of one open vault (`processInboxJob`, `resumeInboxJobs`) and what the job
//! processors share: stopping, blocking on a fetch, off-thread parses, and the after-write
//! effects.

use std::collections::HashSet;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::time::Instant;

use memry_core::api::inbox::Inbox;
use memry_core::domain::inbox::jobs::{InboxJob, InboxJobType};

use super::{InboxJobNotice, InboxJobs, PARSE_TIMED_OUT, POLL, article, metadata};
use crate::session::projection::{CancelToken, ProjectionEvent, feed};
use crate::session::{OpenVault, Session, lock};

/// `METADATA_RETRY_DELAY_MS` and `ARTICLE_RETRY_DELAY_MS`.
pub(super) const RETRY_DELAY_MS: i64 = 5000;

/// Retried after this long when the queue itself could not be read.
const QUEUE_RETRY_MS: i64 = 5000;

/// Why a step of a job produced no result.
pub(super) enum Halt {
    /// The vault is closing or the app quitting: the job stays `running` for the next open.
    Stopped,
    /// The step failed with this message, which becomes the job's error.
    Failed(String),
}

/// One job's view of the runner.
pub(super) struct Ctx<'a> {
    pub jobs: &'a InboxJobs,
    pub session: &'a Session,
    pub open: &'a OpenVault,
    pub inbox: &'a Inbox,
    cancel: &'a CancelToken,
}

impl Ctx<'_> {
    fn stopping(&self) -> bool {
        self.cancel.is_cancelled() || self.jobs.stopped.load(Ordering::SeqCst)
    }

    /// `work` on the shared runtime, dropped when the runner must stop.
    pub fn block<F: Future>(&self, work: F) -> Result<F::Output, Halt> {
        self.jobs.runtime.block_on(async {
            tokio::select! {
                out = work => Ok(out),
                () = async {
                    while !self.stopping() {
                        tokio::time::sleep(POLL).await;
                    }
                } => Err(Halt::Stopped),
            }
        })
    }

    /// CPU-bound `work` (a page parse) on its own thread, so neither a stop nor a page that
    /// parses past the jobs' parse deadline holds up the queue: a parse still running then
    /// finishes alone, its result is dropped, and the flag `work` gets is set, so it fetches
    /// nothing more.
    pub fn off_thread<T: Send + 'static>(
        &self,
        work: impl FnOnce(Arc<AtomicBool>) -> T + Send + 'static,
    ) -> Result<T, Halt> {
        let abandoned = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&abandoned);
        let (done, result) = channel();
        std::thread::Builder::new()
            .name("inbox-job-parse".into())
            .spawn(move || {
                let _ = done.send(work(flag));
            })
            .map_err(|_| Halt::Failed("The page could not be processed.".to_owned()))?;
        let deadline = Instant::now() + self.jobs.parse_deadline;
        let outcome = loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match result.recv_timeout(POLL.min(left)) {
                Ok(out) => break Ok(out),
                Err(RecvTimeoutError::Timeout) if self.stopping() => break Err(Halt::Stopped),
                Err(RecvTimeoutError::Timeout) if left.is_zero() => {
                    tracing::warn!(scope = "Inbox:Jobs", "an inbox page parse timed out");
                    break Err(Halt::Failed(PARSE_TIMED_OUT.to_owned()));
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    tracing::error!(scope = "Inbox:Jobs", "an inbox page parse panicked");
                    break Err(Halt::Failed("The page could not be processed.".to_owned()));
                }
            }
        };
        if outcome.is_err() {
            abandoned.store(true, Ordering::SeqCst);
        }
        outcome
    }

    /// The capture's source URL; `None` when it is gone or has none.
    pub fn source_url(&self, item_id: &str) -> Option<String> {
        match self.inbox.get(item_id.to_owned()) {
            Ok(item) => item.and_then(|item| item.source_url),
            Err(error) => {
                tracing::warn!(scope = "Inbox:Jobs", %error, "the capture could not be read");
                None
            }
        }
    }

    /// `syncInboxUpdate` and `emitUpdated` after a job wrote the capture.
    pub fn wrote(&self, item_id: &str, notice: InboxJobNotice) {
        feed::publish(
            self.session,
            ProjectionEvent::InboxUpserted {
                item_id: item_id.to_owned(),
            },
        );
        if let Some(supervisor) = self.session.sync_supervisor() {
            supervisor.request_push();
        }
        (self.jobs.notify)(notice);
    }

    pub fn notify(&self, notice: InboxJobNotice) {
        (self.jobs.notify)(notice);
    }

    /// `completeJob`; a run the job has moved past changes nothing.
    pub fn finish(&self, job: &InboxJob) {
        let Some(run_id) = job.run_id.clone() else {
            return;
        };
        if let Err(error) = self.inbox.finish_job(job.id.clone(), run_id) {
            tracing::warn!(scope = "Inbox:Jobs", %error, "a finished job was not recorded");
        }
    }

    /// `rescheduleJob` while attempts remain, else `failJob`.
    pub fn fail(&self, job: &InboxJob, error: &str) {
        let Some(run_id) = job.run_id.clone() else {
            return;
        };
        if let Err(store) =
            self.inbox
                .fail_job(job.id.clone(), run_id, error.to_owned(), RETRY_DELAY_MS)
        {
            tracing::warn!(scope = "Inbox:Jobs", error = %store, "a failed job was not recorded");
        }
    }

    /// Queues the capture's next job (`queueInboxArticleExtractJob`).
    pub fn enqueue(&self, item_id: &str, job_type: InboxJobType) {
        if let Err(error) = self.inbox.enqueue_job(item_id.to_owned(), job_type) {
            tracing::warn!(scope = "Inbox:Jobs", %error, "a follow-up job was not queued");
        }
    }
}

/// The open's pass over the queue: interrupted jobs resumed and unfetched links queued. It runs
/// inside the open, so a capture made after the open returns is never claimed by it and then
/// requeued by its own enqueue (which resets a running job, so the job would run twice).
pub(super) fn start(jobs: &InboxJobs, open: &OpenVault) -> Result<(), String> {
    let inbox = open
        .vault
        .inbox(jobs.store.clone())
        .map_err(|error| format!("inbox jobs were not resumed: {error}"))?;
    match inbox.resume_pending_jobs() {
        Ok(resumed) => tracing::info!(scope = "Inbox:Jobs", ?resumed, "inbox jobs resumed"),
        Err(error) => tracing::warn!(scope = "Inbox:Jobs", %error, "inbox jobs were not resumed"),
    }
    queue_unfetched_links(&inbox);
    Ok(())
}

/// The runner of one open vault, until it closes or the app quits.
pub(super) fn run(
    jobs: &Arc<InboxJobs>,
    session: &Session,
    open: &OpenVault,
    cancel: &CancelToken,
) -> Result<(), String> {
    let inbox = open
        .vault
        .inbox(jobs.store.clone())
        .map_err(|error| format!("the inbox job runner did not start: {error}"))?;
    let ctx = Ctx {
        jobs,
        session,
        open,
        inbox: &inbox,
        cancel,
    };
    while !ctx.stopping() {
        match inbox.claim_next_job_of(&RUNS) {
            Ok(Some(job)) => process(&ctx, &job),
            Ok(None) => match inbox.next_job_due_of(&RUNS) {
                Ok(due) => wait(&ctx, due),
                Err(error) => {
                    tracing::warn!(scope = "Inbox:Jobs", %error, "the next job time was not read");
                    wait(&ctx, Some(now_ms() + QUEUE_RETRY_MS));
                }
            },
            Err(error) => {
                tracing::warn!(scope = "Inbox:Jobs", %error, "the next inbox job was not claimed");
                wait(&ctx, Some(now_ms() + QUEUE_RETRY_MS));
            }
        }
    }
    Ok(())
}

/// The job types this runner claims. Transcription runs through `VoiceService` until its job
/// processor is ported (Step 27 stage 7).
const RUNS: [InboxJobType; 2] = [InboxJobType::MetadataScrape, InboxJobType::ArticleExtract];

fn process(ctx: &Ctx<'_>, job: &InboxJob) {
    match job.job_type {
        InboxJobType::MetadataScrape => metadata::run(ctx, job),
        InboxJobType::ArticleExtract => article::run(ctx, job),
        // Not in `RUNS`, so never claimed: a transcription job Electron queued waits for
        // `VoiceService`. `processInboxJob`'s default.
        InboxJobType::Transcription => ctx.fail(
            job,
            "No processor registered for job type \"transcription\".",
        ),
    }
}

/// Sleeps until `due` (epoch ms), a wake, or a stop.
fn wait(ctx: &Ctx<'_>, due: Option<i64>) {
    let mut woken = lock(&ctx.jobs.woken);
    loop {
        if *woken || ctx.stopping() {
            *woken = false;
            return;
        }
        let left = due.map(|due| due - now_ms());
        if left.is_some_and(|left| left <= 0) {
            return;
        }
        let slice = left.map_or(POLL, |left| {
            POLL.min(std::time::Duration::from_millis(left.unsigned_abs()))
        });
        woken = ctx
            .jobs
            .wake
            .wait_timeout(woken, slice)
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .0;
    }
}

/// Links still `pending` or `processing` with no metadata job: captured by Electron, whose job
/// table does not carry over, or interrupted on a device that does not resume them. Each is
/// fetched once; after that its job's own state decides.
fn queue_unfetched_links(inbox: &Inbox) {
    let pending: Vec<String> = match inbox.list(true) {
        Ok(items) => items
            .into_iter()
            .filter(|item| {
                item.item_type == "link"
                    && item.source_url.is_some()
                    && matches!(
                        item.processing_status.as_deref(),
                        Some("pending" | "processing")
                    )
            })
            .map(|item| item.id)
            .collect(),
        Err(error) => {
            tracing::warn!(scope = "Inbox:Jobs", %error, "unfetched links were not read");
            return;
        }
    };
    if pending.is_empty() {
        return;
    }
    let queued: HashSet<String> = match inbox.jobs(pending.clone(), Vec::new()) {
        Ok(jobs) => jobs
            .into_iter()
            .filter(|job| job.job_type == InboxJobType::MetadataScrape)
            .map(|job| job.item_id)
            .collect(),
        Err(error) => {
            tracing::warn!(scope = "Inbox:Jobs", %error, "inbox jobs were not read");
            return;
        }
    };
    for item_id in pending.into_iter().filter(|id| !queued.contains(id)) {
        if let Err(error) = inbox.enqueue_job(item_id, InboxJobType::MetadataScrape) {
            tracing::warn!(scope = "Inbox:Jobs", %error, "an unfetched link was not queued");
        }
    }
}

pub(super) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
