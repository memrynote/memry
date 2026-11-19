//! The attachment transfer queues (#3535 S5): downloads three at a time with
//! Electron's dedupe, priority, pacing and global backoff
//! (`apps/desktop/src/main/sync/download-queue.ts`), and the upload outbox
//! drain (`attachment-outbox.ts` `drainAttachmentOutbox`, three at a time as
//! `upload-queue.ts`).
//!
//! A network error never drops a download or an upload: the download goes back
//! to the front of the queue behind a backoff, and the upload row keeps its
//! place in `attachment_upload_queue`. The queue rows are the only state an
//! upload needs, so a drain cut off by a crash resumes from them.

use std::cmp::Reverse;
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::future::Future;
use std::io;
use std::path::{Component, Path};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::{Semaphore, oneshot};
use tokio::task::JoinSet;
use tokio::time::Instant;

use super::download::{DownloadTarget, Downloaded};
use super::records::record_uploaded;
use super::store::upload_queue::{self, PendingUpload, STUCK_UPLOAD_ATTEMPTS};
use super::transfer::{AttachmentTransfer, TransferError, now_ms};
use crate::api::errors::{ApiError, StorageError};
use crate::domain::notes::read_attachment_references;
use crate::protocol::attachments::AttachmentError;
use crate::storage::Db;

pub const MAX_CONCURRENT_DOWNLOADS: usize = 3;
pub const MAX_CONCURRENT_UPLOADS: usize = 3;
pub const NETWORK_BASE_BACKOFF_MS: u64 = 1000;
pub const NETWORK_MAX_BACKOFF_MS: u64 = 60_000;
/// The server's `blob_download` bucket allows 200 a minute; pace below it.
pub const PACER_MAX_REQUESTS: usize = 150;
pub const PACER_WINDOW_MS: u64 = 60_000;
/// At or under this a file is small and goes first.
pub const SMALL_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// The 429 pause when the server sent no `retry-after`.
const DEFAULT_RETRY_AFTER_S: u64 = 60;

/// The vault the runners read and upload from. The shell implements it over
/// its vault-root checks (`memry_desktop::vault::paths::open_vault_file`), so
/// core never opens a path that leaves the vault.
pub trait VaultFiles: Send + Sync {
    /// The vault root, absolute.
    fn root(&self) -> &Path;
    /// Opens a vault-relative, `/`-separated file. `NotFound` when it is not
    /// there; an error for a path outside the vault.
    fn open(&self, rel: &str) -> io::Result<File>;
    /// The file names directly inside a vault-relative folder, `NotFound` when
    /// the folder is not there.
    fn list_files(&self, rel_dir: &str) -> io::Result<Vec<String>>;
}

/// The absolute path a queue row stores for a vault-relative file (Electron
/// keeps absolute paths there, and the import copies rows unchanged).
pub fn absolute(vault: &dyn VaultFiles, rel: &str) -> String {
    vault.root().join(rel).to_string_lossy().into_owned()
}

/// The vault-relative, `/`-separated form of an absolute path, `None` outside
/// the vault.
pub fn relative(vault: &dyn VaultFiles, path: &str) -> Option<String> {
    let rest = Path::new(path).strip_prefix(vault.root()).ok()?;
    let mut parts = Vec::new();
    for component in rest.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str()?.to_owned()),
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// Who waits on a download: a user (first in line), the pull (`eager`) or the
/// failure re-driver.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadSource {
    Interactive,
    Eager,
    Redrive,
}

#[derive(Debug, Clone)]
pub struct DownloadRequest {
    pub owner_id: String,
    pub attachment_id: String,
    pub target: DownloadTarget,
    pub source: DownloadSource,
    /// Plaintext size when cheaply known.
    pub size_hint: Option<u64>,
    /// The owner's `modifiedAt`; newer first.
    pub recency_hint: Option<i64>,
}

impl DownloadRequest {
    /// `keyOf` (`download-queue.ts:199-215`): the destination is part of a
    /// transfer's identity, so one attachment may land at two places at once.
    pub fn key(&self) -> String {
        let (kind, path) = match &self.target {
            DownloadTarget::Dir(path) => ("dir", path),
            DownloadTarget::Path(path) => ("file", path),
        };
        format!(
            "{}::{}::{kind}::{}",
            self.owner_id,
            self.attachment_id,
            path.display()
        )
    }

    /// `compareItems`: interactive, then small, unknown, large; newer owners
    /// first; then arrival.
    fn rank(&self) -> (u8, u8, Reverse<i64>) {
        let interactive = u8::from(self.source != DownloadSource::Interactive);
        let size = match self.size_hint {
            None => 1,
            Some(size) if size <= SMALL_FILE_BYTES => 0,
            Some(_) => 2,
        };
        (interactive, size, Reverse(self.recency_hint.unwrap_or(0)))
    }
}

/// Every caller of one download gets the same answer.
pub type DownloadOutcome = Result<Downloaded, Arc<TransferError>>;
pub type DownloadFuture = Pin<Box<dyn Future<Output = Result<Downloaded, TransferError>> + Send>>;
/// Runs one transfer: [`AttachmentTransfer::download_to_file`] in the app.
pub type DownloadFn = Arc<dyn Fn(DownloadRequest) -> DownloadFuture + Send + Sync>;

/// The queue was cleared (vault switch, stop) before the download ran: not an
/// outcome, so the caller records no failure and may ask again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the download queue was cleared")]
pub struct QueueCleared;

struct Item {
    request: DownloadRequest,
    seq: u64,
    network_attempts: u32,
}

#[derive(Default)]
struct State {
    queue: Vec<Item>,
    /// `byKey`: every caller of a queued or running download.
    waiters: HashMap<String, Vec<oneshot::Sender<DownloadOutcome>>>,
    running: usize,
    seq: u64,
    rate_limited_until: Option<Instant>,
    network_until: Option<Instant>,
    timer_armed: bool,
}

/// `DownloadPacer`: at most `PACER_MAX_REQUESTS * multiplier` downloads start
/// in any trailing window.
struct Pacer {
    starts: VecDeque<Instant>,
    multiplier: usize,
}

struct Inner {
    download: DownloadFn,
    state: Mutex<State>,
    pacer: tokio::sync::Mutex<Pacer>,
}

/// The global download manager of one vault.
#[derive(Clone)]
pub struct DownloadQueue {
    inner: Arc<Inner>,
}

impl DownloadQueue {
    pub fn new(download: DownloadFn) -> Self {
        Self {
            inner: Arc::new(Inner {
                download,
                state: Mutex::default(),
                pacer: tokio::sync::Mutex::new(Pacer {
                    starts: VecDeque::new(),
                    multiplier: 1,
                }),
            }),
        }
    }

    /// Queues a download and waits for it. A request whose key is queued or
    /// running joins that transfer and takes no worker slot of its own; an
    /// interactive one lifts the queued item to the front.
    pub async fn enqueue(&self, request: DownloadRequest) -> Result<DownloadOutcome, QueueCleared> {
        let (tx, rx) = oneshot::channel();
        {
            let mut state = lock(&self.inner.state);
            let key = request.key();
            match state.waiters.get_mut(&key) {
                Some(waiters) => {
                    waiters.push(tx);
                    if request.source == DownloadSource::Interactive
                        && let Some(item) = state
                            .queue
                            .iter_mut()
                            .find(|item| item.request.key() == key)
                    {
                        item.request.source = DownloadSource::Interactive;
                    }
                }
                None => {
                    state.waiters.insert(key, vec![tx]);
                    state.seq += 1;
                    let seq = state.seq;
                    state.queue.push(Item {
                        request,
                        seq,
                        network_attempts: 0,
                    });
                }
            }
        }
        drain(&self.inner);
        rx.await.map_err(|_| QueueCleared)
    }

    /// Network restored: every escalated delay is stale.
    pub fn network_restored(&self) {
        {
            let mut state = lock(&self.inner.state);
            state.network_until = None;
            for item in &mut state.queue {
                item.network_attempts = 0;
            }
        }
        drain(&self.inner);
    }

    /// Bootstrap elevation: raise or restore the pacer ceiling. A factor below
    /// 1 counts as 1, so pacing never drops below the base.
    pub async fn set_pace_multiplier(&self, multiplier: usize) {
        self.inner.pacer.lock().await.multiplier = multiplier.max(1);
    }

    /// Drops every queued download; its callers get [`QueueCleared`]. Running
    /// transfers finish and answer their callers.
    pub fn clear(&self) {
        let mut state = lock(&self.inner.state);
        let queued = std::mem::take(&mut state.queue);
        for item in queued {
            state.waiters.remove(&item.request.key());
        }
    }

    /// Downloads waiting for a slot.
    pub fn pending(&self) -> usize {
        lock(&self.inner.state).queue.len()
    }

    /// Downloads running now.
    pub fn active(&self) -> usize {
        lock(&self.inner.state).running
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn drain(inner: &Arc<Inner>) {
    let mut state = lock(&inner.state);
    while !state.queue.is_empty() && state.running < MAX_CONCURRENT_DOWNLOADS {
        let resume = state.rate_limited_until.max(state.network_until);
        if let Some(at) = resume.filter(|at| *at > Instant::now()) {
            if !state.timer_armed {
                state.timer_armed = true;
                let inner = inner.clone();
                tokio::spawn(async move {
                    tokio::time::sleep_until(at).await;
                    lock(&inner.state).timer_armed = false;
                    drain(&inner);
                });
            }
            return;
        }
        let best = (0..state.queue.len())
            .min_by_key(|&i| (state.queue[i].request.rank(), state.queue[i].seq))
            .unwrap_or(0);
        let item = state.queue.remove(best);
        state.running += 1;
        tokio::spawn(run(inner.clone(), item));
    }
}

async fn run(inner: Arc<Inner>, mut item: Item) {
    pace(&inner).await;
    // Its own task, so a panicking transfer still answers every waiter.
    let result = match tokio::spawn((inner.download)(item.request.clone())).await {
        Ok(result) => result,
        Err(error) => Err(TransferError::Io(io::Error::other(format!(
            "the download task failed: {error}"
        )))),
    };
    {
        let mut state = lock(&inner.state);
        state.running -= 1;
        match retry_of(&result) {
            Retry::RateLimited(seconds) => {
                let until = Instant::now() + Duration::from_secs(seconds);
                state.rate_limited_until = state.rate_limited_until.max(Some(until));
                eprintln!(
                    "memry-core: attachment download rate limited, pausing the queue {seconds} s"
                );
                state.queue.insert(0, item);
            }
            Retry::Network => {
                item.network_attempts += 1;
                let wait = network_backoff_ms(item.network_attempts);
                let until = Instant::now() + Duration::from_millis(wait);
                state.network_until = state.network_until.max(Some(until));
                eprintln!(
                    "memry-core: attachment {} download hit a network error (attempt {}), retrying in {wait} ms",
                    item.request.attachment_id, item.network_attempts
                );
                state.queue.insert(0, item);
            }
            Retry::No => {
                if result.is_ok() {
                    state.network_until = None;
                }
                let outcome = result.map_err(Arc::new);
                for waiter in state
                    .waiters
                    .remove(&item.request.key())
                    .unwrap_or_default()
                {
                    // A caller that stopped waiting needs no answer.
                    let _ = waiter.send(outcome.clone());
                }
            }
        }
    }
    drain(&inner);
}

async fn pace(inner: &Inner) {
    let mut pacer = inner.pacer.lock().await;
    let window = Duration::from_millis(PACER_WINDOW_MS);
    loop {
        let now = Instant::now();
        while pacer
            .starts
            .front()
            .is_some_and(|start| *start + window <= now)
        {
            pacer.starts.pop_front();
        }
        if pacer.starts.len() < PACER_MAX_REQUESTS * pacer.multiplier {
            pacer.starts.push_back(now);
            return;
        }
        if let Some(oldest) = pacer.starts.front().copied() {
            tokio::time::sleep_until(oldest + window).await;
        }
    }
}

enum Retry {
    No,
    Network,
    RateLimited(u64),
}

fn retry_of(result: &Result<Downloaded, TransferError>) -> Retry {
    match result {
        Err(TransferError::Attachment(AttachmentError::Api(ApiError::Transport { .. }))) => {
            Retry::Network
        }
        Err(TransferError::Attachment(AttachmentError::Api(ApiError::RateLimited {
            retry_after_s,
            ..
        }))) => Retry::RateLimited(retry_after_s.unwrap_or(DEFAULT_RETRY_AFTER_S)),
        _ => Retry::No,
    }
}

fn network_backoff_ms(attempts: u32) -> u64 {
    let doubled = 1_u64
        .checked_shl(attempts.saturating_sub(1))
        .unwrap_or(u64::MAX);
    NETWORK_BASE_BACKOFF_MS
        .saturating_mul(doubled)
        .min(NETWORK_MAX_BACKOFF_MS)
}

/// What one drain of the upload outbox did.
#[derive(Debug, Default)]
pub struct UploadDrain {
    pub uploaded: usize,
    /// Rows kept for a later pass (network, disk, or any other failure).
    pub failed: usize,
    /// Rows that reached [`STUCK_UPLOAD_ATTEMPTS`] on this pass.
    pub stuck: Vec<PendingUpload>,
    /// Rows dropped because they can never upload: the file is gone, outside
    /// the vault, empty or too large. Each with the reason, for the user.
    pub dropped: Vec<(PendingUpload, String)>,
}

enum Settled {
    Uploaded,
    Failed(Option<PendingUpload>),
    Dropped(PendingUpload, String),
}

/// Uploads every due row once, three at a time (`drainAttachmentOutbox`).
/// Each row is settled in the database before the next pass can see it, so a
/// drain cut off anywhere converges on the next one.
pub async fn drain_uploads(
    db: Db,
    transfer: Arc<AttachmentTransfer>,
    vault: Arc<dyn VaultFiles>,
    device_id: Arc<str>,
) -> Result<UploadDrain, StorageError> {
    let due = db
        .call(|conn| upload_queue::list_due(conn, now_ms()))
        .await?;
    let slots = Arc::new(Semaphore::new(MAX_CONCURRENT_UPLOADS));
    let mut tasks = JoinSet::new();
    for row in due {
        let (db, transfer, vault) = (db.clone(), transfer.clone(), vault.clone());
        let (device_id, slots) = (device_id.clone(), slots.clone());
        tasks.spawn(async move {
            let _slot = slots.acquire_owned().await;
            upload_row(&db, &transfer, vault.as_ref(), &device_id, row).await
        });
    }
    let mut drained = UploadDrain::default();
    while let Some(joined) = tasks.join_next().await {
        let settled = joined.map_err(|error| StorageError::Failed {
            what: format!("an upload task failed: {error}"),
        })??;
        match settled {
            Settled::Uploaded => drained.uploaded += 1,
            Settled::Failed(stuck) => {
                drained.failed += 1;
                drained.stuck.extend(stuck);
            }
            Settled::Dropped(row, reason) => drained.dropped.push((row, reason)),
        }
    }
    Ok(drained)
}

async fn upload_row(
    db: &Db,
    transfer: &AttachmentTransfer,
    vault: &dyn VaultFiles,
    device_id: &str,
    row: PendingUpload,
) -> Result<Settled, StorageError> {
    let Some(rel) = relative(vault, &row.disk_path) else {
        return drop_row(db, row, "the file is outside the vault".to_owned()).await;
    };
    let owner = row.owner_id.clone();
    let reusable = db
        .call(move |conn| read_attachment_references(conn, &owner))
        .await?;
    let name = rel.rsplit('/').next().unwrap_or(&rel).to_owned();
    let mut result = upload_once(transfer, vault, &rel, &name, &reusable).await;
    if matches!(result, Err(TransferError::FileChanged)) {
        // Nothing of the changed bytes left; the new bytes go up from the start.
        result = upload_once(transfer, vault, &rel, &name, &reusable).await;
    }
    match result {
        Ok(attachment_id) => {
            let (owner, path, device) = (row.owner_id.clone(), rel.clone(), device_id.to_owned());
            let referenced = db
                .call(move |conn| {
                    record_uploaded(conn, &owner, &path, &attachment_id, &device, now_ms())
                })
                .await?;
            if !referenced {
                eprintln!(
                    "memry-core: uploaded attachment of {} has no live note to reference it",
                    row.owner_id
                );
            }
            Ok(Settled::Uploaded)
        }
        Err(TransferError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
            drop_row(db, row, "the file was deleted".to_owned()).await
        }
        Err(error @ (TransferError::EmptyFile | TransferError::TooLarge { .. })) => {
            drop_row(db, row, error.to_string()).await
        }
        Err(error) => {
            let text = error.to_string();
            eprintln!(
                "memry-core: attachment upload of {} failed, kept for retry: {text}",
                row.owner_id
            );
            let (owner, path) = (row.owner_id.clone(), row.disk_path.clone());
            let attempts = db
                .call(move |conn| upload_queue::mark_failed(conn, &owner, &path, &text, now_ms()))
                .await?;
            Ok(Settled::Failed(
                (attempts == STUCK_UPLOAD_ATTEMPTS).then_some(PendingUpload { attempts, ..row }),
            ))
        }
    }
}

async fn upload_once(
    transfer: &AttachmentTransfer,
    vault: &dyn VaultFiles,
    rel: &str,
    name: &str,
    reusable: &[String],
) -> Result<String, TransferError> {
    let file = vault.open(rel)?;
    let uploaded = transfer.upload_file(file, name, reusable).await?;
    Ok(uploaded.attachment_id)
}

async fn drop_row(db: &Db, row: PendingUpload, reason: String) -> Result<Settled, StorageError> {
    eprintln!(
        "memry-core: attachment upload of {} dropped: {reason}",
        row.owner_id
    );
    let (owner, path) = (row.owner_id.clone(), row.disk_path.clone());
    db.call(move |conn| upload_queue::clear(conn, &owner, &path))
        .await?;
    Ok(Settled::Dropped(row, reason))
}
