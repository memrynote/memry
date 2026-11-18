//! The Inbox's background jobs (`apps/desktop/src/main/inbox/jobs.ts`): a link's metadata and
//! its readable article, fetched and written back onto the capture (Step 27, #3544).
//!
//! Core owns the queue (`Inbox::{claim_next_job, finish_job, fail_job, ..}`, local only); this
//! service owns time and the work. One runner thread per open vault (a session background
//! task) resumes interrupted jobs, queues links an older build left unfetched, then claims the
//! next due job, runs it and finishes or fails that run, and sleeps until the next one is due or
//! [`InboxJobs::enqueue`] wakes it. Jobs run one at a time.
//!
//! A vault close or [`InboxJobs::stop`] (the `stop-schedulers` quit step) stops the runner
//! within [`POLL`]: a fetch is dropped, and a parse in flight is left to finish on its own
//! thread with nothing written. The interrupted job stays `running` and the next open resumes
//! it (`Inbox::resume_pending_jobs`). A parse that runs past [`PARSE_DEADLINE`] is left the same
//! way and fails its job, and the extractors' requests on its thread are refused from then on.
//!
//! Every write the runner makes reaches the projectors (`InboxUpserted`), asks the sync
//! supervisor for a push (so peers stop showing the capture as fetching, #4155), and is
//! announced to the shell as an [`InboxJobNotice`].

mod article;
mod metadata;
mod run;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use memry_core::api::errors::{AuthError, StorageError};
use memry_core::domain::inbox::jobs::{InboxJob, InboxJobType};
use memry_core::seams::secure_store::SecureStore;
use tokio::runtime::Handle;

use crate::services::web_fetch::WebFetch;
use crate::session::{OpenVault, Session, lock};

/// How often a waiting or working runner checks whether it must stop.
pub const POLL: Duration = Duration::from_millis(100);

/// The longest one page parse may run before its job fails: one hostile page must not stall
/// the serial queue (1,000 nested `<div>` take about 25 s in a debug build).
pub const PARSE_DEADLINE: Duration = Duration::from_secs(60);

/// The error of a job whose page parse ran past its deadline.
pub const PARSE_TIMED_OUT: &str = "The page parse timed out";

/// What a job changed, for the shell's renderer events (`inbox:*` channels of `jobs.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboxJobNotice {
    /// `inbox:updated`: the fields of the capture the job wrote.
    Updated {
        item_id: String,
        changes: ItemChanges,
    },
    /// `inbox:metadata-complete`, after the link preview is stored.
    MetadataComplete {
        item_id: String,
        title: Option<String>,
        description: Option<String>,
        image: Option<String>,
        thumbnail_path: Option<String>,
    },
    /// `inbox:processing-error`, after a job's last attempt failed. `operation` is `metadata`.
    ProcessingError {
        item_id: String,
        operation: &'static str,
        error: String,
    },
}

/// The changed fields `jobs.ts` and `ingest.ts` send with `inbox:updated`. `None` is a field
/// the job did not write.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ItemChanges {
    pub processing_status: Option<String>,
    pub processing_error: Option<String>,
    pub thumbnail_path: Option<String>,
    pub content: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum InboxJobsError {
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error(transparent)]
    Storage(#[from] StorageError),
}

pub type Notify = Box<dyn Fn(InboxJobNotice) + Send + Sync>;

/// The Inbox job runner of every vault this app opens. Built once, registered on the session.
pub struct InboxJobs {
    web: WebFetch,
    runtime: Handle,
    store: Arc<dyn SecureStore>,
    notify: Notify,
    /// Set by [`InboxJobs::enqueue`] and [`InboxJobs::stop`]; the waiting runner clears it.
    woken: Mutex<bool>,
    wake: Condvar,
    /// The app is quitting: no runner claims another job.
    stopped: AtomicBool,
    /// [`PARSE_DEADLINE`] outside tests.
    parse_deadline: Duration,
}

impl InboxJobs {
    /// `runtime` runs the fetches; the runner thread blocks on it, so it must not be the
    /// runtime of the caller's thread. `store` holds the device key the Inbox writes under.
    pub fn new(
        web: WebFetch,
        runtime: Handle,
        store: Arc<dyn SecureStore>,
        notify: Notify,
    ) -> Arc<Self> {
        Self::with_parse_deadline(web, runtime, store, notify, PARSE_DEADLINE)
    }

    /// [`InboxJobs::new`] with a page parse failing its job after `parse_deadline`.
    pub fn with_parse_deadline(
        web: WebFetch,
        runtime: Handle,
        store: Arc<dyn SecureStore>,
        notify: Notify,
        parse_deadline: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            web,
            runtime,
            store,
            notify,
            woken: Mutex::new(false),
            wake: Condvar::new(),
            stopped: AtomicBool::new(false),
            parse_deadline,
        })
    }

    /// Runs the job runner in the background of every open (`resumeInboxJobs` at vault open).
    pub fn register(self: &Arc<Self>, session: &Session) {
        let jobs = Arc::clone(self);
        let owner = session.clone();
        session.on_background(
            "inbox-jobs",
            Arc::new(move |open, cancel| run::run(&jobs, &owner, open, cancel)),
        );
    }

    /// `queueInbox*Job`: the capture's job of `job_type`, due now, and the runner woken. The
    /// entry point of the capture commands.
    pub fn enqueue(
        &self,
        open: &OpenVault,
        item_id: &str,
        job_type: InboxJobType,
    ) -> Result<InboxJob, InboxJobsError> {
        let job = open
            .vault
            .inbox(self.store.clone())?
            .enqueue_job(item_id.to_owned(), job_type)?;
        self.wake_runner();
        Ok(job)
    }

    /// `teardownInboxJobScheduler` (`stop-schedulers`): the runner claims nothing more and
    /// stops within [`POLL`]. Final for this app session.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.wake_runner();
    }

    fn wake_runner(&self) {
        *lock(&self.woken) = true;
        self.wake.notify_all();
    }
}
