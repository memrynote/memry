//! The attachment download queue (#3535 S5): three at a time with Electron's
//! dedupe, priority, pacing and global backoff
//! (`apps/desktop/src/main/sync/download-queue.ts`), and the [`VaultFiles`]
//! seam the runners read the vault through.
//!
//! A network error never drops a download: it goes back to the front of the
//! queue behind a backoff.

use std::cmp::Reverse;
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::future::Future;
use std::io;
use std::path::{Component, Path};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::oneshot;
use tokio::time::Instant;

use super::download::{DownloadTarget, Downloaded};
use super::transfer::TransferError;
use crate::api::errors::ApiError;
use crate::protocol::attachments::AttachmentError;

pub const MAX_CONCURRENT_DOWNLOADS: usize = 3;
pub const NETWORK_BASE_BACKOFF_MS: u64 = 1000;
pub const NETWORK_MAX_BACKOFF_MS: u64 = 60_000;
/// The server's `blob_download` bucket allows 600 a minute (`blob.ts:96`);
/// one token per download leaves room for its manifest and chunk reads.
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
    /// Whether the vault is there to read now (Electron's `isVaultReachable`,
    /// `vault/init.ts:74`). A removable, network or cloud vault that is away
    /// answers `false`, and its missing files are not deletions.
    fn is_reachable(&self) -> bool;
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
/// Runs one transfer: [`super::transfer::AttachmentTransfer::download_to_file`] in the app.
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
    /// Set by [`DownloadQueue::clear`]: the vault is gone, nothing runs again.
    disposed: bool,
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
            if state.disposed {
                return Err(QueueCleared);
            }
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

    /// Retires the queue (vault switch, stop): drops every queued download and
    /// turns later ones away; their callers get [`QueueCleared`]. Running
    /// transfers finish and answer their callers, except one that would retry:
    /// it ends with [`QueueCleared`] instead of going back into the queue
    /// (`download-queue.ts:363-370`).
    pub fn clear(&self) {
        let mut state = lock(&self.inner.state);
        state.disposed = true;
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
    while !state.disposed && !state.queue.is_empty() && state.running < MAX_CONCURRENT_DOWNLOADS {
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
            Retry::RateLimited(_) | Retry::Network if state.disposed => {
                state.waiters.remove(&item.request.key());
            }
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
