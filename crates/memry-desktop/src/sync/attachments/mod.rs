//! Attachment sync of the open vault (#3535, Step 18 S6): the shell around core's runners
//! (`memry_core::sync::attachments`), ported from Electron's `attachment-upload-redriver.ts`,
//! `attachment-download-redriver.ts`, `deleted-asset-release-runner.ts` and the
//! `onDownloadNeeded` handler (`ipc/sync-attachment-handlers.ts:642`).
//!
//! [`AttachmentSync`] lives as long as the vault's sync backend. Its [`ApplyObserver`] hears
//! every pulled page from the driver's open on; [`AttachmentSync::start`] hands it the driver's
//! transfer and starts the drivers, [`AttachmentSync::stop`] ends them when the driver closes.
//! Every runner settles its rows in the database before it moves on, so a stop or a crash
//! anywhere converges on the next start.

mod placement;
mod runners;
pub mod vault_files;

pub(crate) use placement::place_linked_downloads;

use std::collections::HashSet;
use std::fmt::Display;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};

use memry_core::api::auth::AuthSession;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::storage::Db;
use memry_core::sync::attachments::queue::{DownloadFn, DownloadQueue, VaultFiles};
use memry_core::sync::attachments::revival;
use memry_core::sync::attachments::store::download_failures;
use memry_core::sync::attachments::transfer::AttachmentTransfer;
use memry_core::sync::driver::{ApplyObserver, AttachmentDownload};
use memry_core::sync::engine::PassReport;
use memry_core::sync::state::SyncState;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::sync::events::OnSyncEvent;

/// Whether background downloads run (`sync.attachmentAutoDownload`); on-demand downloads always
/// do.
pub type AutoDownload = Arc<dyn Fn() -> bool + Send + Sync>;

/// The open vault's attachment drivers and pull observer.
#[derive(Clone)]
pub struct AttachmentSync {
    inner: Arc<Inner>,
}

struct Inner {
    db: Db,
    vault: Arc<dyn VaultFiles>,
    auto_download: AutoDownload,
    /// Tells the renderer what a transfer did.
    on_event: OnSyncEvent,
    runtime: tokio::runtime::Handle,
    /// The last pass pulled to the feed head (`lastRunCaughtUp`); a pause or going offline
    /// clears it.
    caught_up: AtomicBool,
    paused: AtomicBool,
    online: AtomicBool,
    running: Mutex<Option<Running>>,
}

/// What the drivers of one open driver share.
#[derive(Clone)]
struct Live {
    transfer: Arc<AttachmentTransfer>,
    device_id: Arc<str>,
    /// Gates the upload re-drive on a token and a device that is not revoked.
    session: Arc<AuthSession>,
    queue: Arc<DownloadQueue>,
    /// Wakes an upload re-drive (a revived note).
    uploads: Arc<Notify>,
    /// Wakes both re-drives (the network came back).
    reconnect: Arc<Notify>,
    /// Wakes the release (the first pass that caught up).
    release: Arc<Notify>,
    /// `owner::attachment` landed this session (`markDownloadSucceeded`'s session set).
    landed: Arc<Mutex<HashSet<String>>>,
}

struct Running {
    live: Live,
    task: JoinHandle<()>,
}

impl AttachmentSync {
    /// `reachability` wakes the re-drives on a reconnect and resets the download backoff on Wifi.
    pub fn new(
        db: Db,
        vault: Arc<dyn VaultFiles>,
        auto_download: AutoDownload,
        on_event: OnSyncEvent,
        reachability: &dyn Reachability,
        runtime: tokio::runtime::Handle,
    ) -> Self {
        let inner = Arc::new(Inner {
            db,
            vault,
            auto_download,
            on_event,
            runtime,
            caught_up: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            online: AtomicBool::new(reachability.current() != Reachable::Offline),
            running: Mutex::new(None),
        });
        // Weak: the reachability source keeps its observers for good.
        reachability.observe(Arc::new(Network(Arc::downgrade(&inner))));
        Self { inner }
    }

    /// The pull observer, registered with the driver from its open on.
    pub fn observer(&self) -> Arc<dyn ApplyObserver> {
        Arc::new(Observer(Arc::downgrade(&self.inner)))
    }

    /// Starts the drivers over `transfer`; `device_id` stamps the reference writes, and `session`
    /// gates the uploads. The first
    /// round runs at once: the upload re-drive, then the download re-drive, then the release
    /// (`runtime.ts:892-921`).
    pub fn start(&self, transfer: AttachmentTransfer, device_id: &str, session: Arc<AuthSession>) {
        self.stop();
        let transfer = Arc::new(transfer);
        let download: DownloadFn = {
            let transfer = Arc::clone(&transfer);
            Arc::new(move |request| {
                let transfer = Arc::clone(&transfer);
                Box::pin(async move {
                    transfer
                        .download_to_file(&request.attachment_id, request.target)
                        .await
                })
            })
        };
        let live = Live {
            transfer,
            device_id: device_id.into(),
            session,
            queue: Arc::new(DownloadQueue::new(download)),
            uploads: Arc::default(),
            reconnect: Arc::default(),
            release: Arc::default(),
            landed: Arc::default(),
        };
        let task = self
            .inner
            .runtime
            .spawn(runners::drive(Arc::downgrade(&self.inner), live.clone()));
        *lock(&self.inner.running) = Some(Running { live, task });
    }

    /// Ends the drivers and clears the download queue; its waiters record nothing.
    pub fn stop(&self) {
        self.inner.caught_up.store(false, Ordering::SeqCst);
        if let Some(running) = lock(&self.inner.running).take() {
            running.task.abort();
            running.live.queue.clear();
        }
    }

    /// A pass pulled to the feed head: the release may trust the local view now. The first one
    /// runs the release a start round skipped, rather than an hour later.
    /// The open's transfer could not be built: the drivers stop, so the observer requests no
    /// download until a later open starts them (Electron releases the claim when it has no
    /// download queue, `sync-attachment-handlers.ts:666`).
    pub fn not_started(&self, error: &dyn Display) {
        tracing::error!(%error, "attachment sync not started; downloads wait for the next open");
        self.stop();
    }

    /// Sync paused or resumed. A pause forgets the last pass's catch-up: only a later pass that
    /// pulls to the feed head says it again.
    pub fn set_paused(&self, paused: bool) {
        if paused {
            self.inner.caught_up.store(false, Ordering::SeqCst);
        }
        self.inner.paused.store(paused, Ordering::SeqCst);
    }

    /// `isCaughtUpWithServer` (`engine.ts:632`): the last pass pulled to the feed head and sync is
    /// neither paused nor offline. Only then does the local view reflect what peers did.
    pub fn caught_up_with_server(&self) -> bool {
        self.inner.caught_up_with_server()
    }

    /// What a pass did (`lastRunCaughtUp`, `full-sync-runner.ts:438,509,514`): caught up only when
    /// it pulled to the feed head with no error or refusal. A skipped pass (`None`) or an offline
    /// one is not. The first catch-up runs the release a start round skipped, not an hour later.
    pub fn heard(&self, pass: Option<&PassReport>) {
        let caught_up = pass.is_some_and(|pass| {
            pass.transitions.contains(&SyncState::Pulling)
                && pass.pull_error.is_none()
                && !pass.pull.has_more
                && !pass.pull.refused
        });
        if !self.inner.caught_up.swap(caught_up, Ordering::SeqCst)
            && caught_up
            && let Some(live) = self.inner.live()
        {
            live.release.notify_one();
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        if let Some(running) = lock(&self.running).take() {
            running.task.abort();
            running.live.queue.clear();
        }
    }
}

impl Inner {
    fn caught_up_with_server(&self) -> bool {
        self.caught_up.load(Ordering::SeqCst)
            && !self.paused.load(Ordering::SeqCst)
            && self.online.load(Ordering::SeqCst)
    }

    fn live(&self) -> Option<Live> {
        lock(&self.running)
            .as_ref()
            .map(|running| running.live.clone())
    }
}

struct Observer(Weak<Inner>);

impl ApplyObserver for Observer {
    fn name(&self) -> &str {
        "attachments"
    }

    /// Durable before anything else (`revival::mark_revived`); the next upload re-drive checks
    /// the note, deferred so it never runs inside the page.
    fn note_revived(&self, note_id: &str) {
        let Some(inner) = self.0.upgrade() else {
            return;
        };
        let id = note_id.to_owned();
        let marked = inner
            .db
            .call_blocking(move |conn| revival::mark_revived(conn, &id, runners::now_ms()));
        if let Err(error) = marked {
            tracing::error!(note_id, %error, "could not record a revived note's attachment check");
        }
        if let Some(live) = inner.live() {
            live.uploads.notify_one();
        }
    }

    fn attachment_download_needed(&self, download: &AttachmentDownload) {
        let Some(inner) = self.0.upgrade() else {
            return;
        };
        let Some(live) = inner.live() else { return };
        let key = download_failures::key(&download.owner_id, &download.attachment_id);
        if !(inner.auto_download)() || lock(&live.landed).contains(&key) {
            return;
        }
        let download = download.clone();
        inner
            .runtime
            .clone()
            .spawn(async move { runners::eager_download(&inner, &live, download).await });
    }
}

struct Network(Weak<Inner>);

impl ReachabilityObserver for Network {
    fn on_change(&self, reachable: Reachable) {
        let Some(inner) = self.0.upgrade() else {
            return;
        };
        let online = reachable != Reachable::Offline;
        let was = inner.online.swap(online, Ordering::SeqCst);
        if !online {
            inner.caught_up.store(false, Ordering::SeqCst);
        }
        let Some(live) = inner.live() else {
            return;
        };
        if reachable == Reachable::Wifi {
            live.queue.network_restored();
        }
        if online && !was {
            live.reconnect.notify_one();
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
