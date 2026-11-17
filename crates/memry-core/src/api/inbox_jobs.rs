//! `Inbox` background jobs: the queue the desktop runner drains
//! (`domain::inbox::jobs`). Local only; nothing here syncs. Split from
//! `inbox_write.rs` (600-line ceiling).

use crate::api::errors::StorageError;
use crate::api::inbox::Inbox;
use crate::domain::inbox::jobs::{self, InboxJob, InboxJobStatus, InboxJobType, InboxJobsResumed};

#[uniffi::export]
impl Inbox {
    /// Queues the capture's job of `job_type`, due now, attempts reset;
    /// `NotFound` when the capture is not live.
    pub fn enqueue_job(
        &self,
        item_id: String,
        job_type: InboxJobType,
    ) -> Result<InboxJob, StorageError> {
        self.write(move |conn, _, now| jobs::enqueue(conn, &item_id, job_type, now))
    }

    /// The earliest due job, now `running` under a new `run_id`; `nil` when
    /// none is due.
    pub fn claim_next_job(&self) -> Result<Option<InboxJob>, StorageError> {
        self.write(|conn, _, now| jobs::claim_next(conn, now))
    }

    /// Marks run `run_id` of a job complete; `nil` when the job was queued
    /// again meanwhile and `run_id` is not its current run.
    pub fn finish_job(
        &self,
        job_id: String,
        run_id: String,
    ) -> Result<Option<InboxJob>, StorageError> {
        self.write(move |conn, _, now| jobs::finish(conn, &job_id, &run_id, now))
    }

    /// Run `run_id` of a job failed: pending again after `retry_delay_ms`
    /// while attempts remain, else failed; `nil` when the job was queued again
    /// meanwhile and `run_id` is not its current run.
    pub fn fail_job(
        &self,
        job_id: String,
        run_id: String,
        error: String,
        retry_delay_ms: i64,
    ) -> Result<Option<InboxJob>, StorageError> {
        self.write(move |conn, _, now| {
            jobs::fail(conn, &job_id, &run_id, &error, retry_delay_ms, now)
        })
    }

    /// Jobs of `item_ids` (every capture when empty) in `statuses` (every
    /// status when empty), soonest first.
    pub fn jobs(
        &self,
        item_ids: Vec<String>,
        statuses: Vec<InboxJobStatus>,
    ) -> Result<Vec<InboxJob>, StorageError> {
        self.db
            .read_blocking(move |conn| jobs::list(conn, &item_ids, &statuses))
    }

    /// At vault open, before the runner starts: interrupted jobs pending
    /// again, jobs of deleted captures removed.
    pub fn resume_pending_jobs(&self) -> Result<InboxJobsResumed, StorageError> {
        self.write(|conn, _, now| jobs::resume(conn, now))
    }

    /// When the next pending job is due (epoch ms); `nil` when none is.
    pub fn next_job_due(&self) -> Result<Option<i64>, StorageError> {
        self.db.read_blocking(jobs::next_due)
    }
}
