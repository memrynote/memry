//! The drivers: the upload re-drive every 5 minutes, the download re-drive every 15, the
//! deleted-asset release hourly, each also at start; a reconnect runs both re-drives. One task
//! runs them one at a time, so no two rounds of one runner overlap (Electron's `running` flags).

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Weak};
use std::time::Duration;

use memry_core::api::errors::{ApiError, StorageError};
use memry_core::domain::notes;
use memry_core::protocol::attachments::AttachmentError;
use memry_core::sync::attachments::backfill::backfill;
use memry_core::sync::attachments::download::DownloadTarget;
use memry_core::sync::attachments::outbox::drain_uploads;
use memry_core::sync::attachments::queue::{self, DownloadRequest, DownloadSource};
use memry_core::sync::attachments::records::record_downloaded;
use memry_core::sync::attachments::release::release_due;
use memry_core::sync::attachments::revival::settle_revived;
use memry_core::sync::attachments::store::download_failures::{self, FailureReason};
use memry_core::sync::attachments::store::files;
use memry_core::sync::attachments::transfer::TransferError;
use memry_core::sync::driver::AttachmentDownload;
use rusqlite::{Connection, OptionalExtension, params};
use tokio::time::{MissedTickBehavior, interval};

use super::{Inner, Live, lock};

pub(super) const UPLOAD_EVERY: Duration = Duration::from_secs(5 * 60);
pub(super) const DOWNLOAD_EVERY: Duration = Duration::from_secs(15 * 60);
pub(super) const RELEASE_EVERY: Duration = Duration::from_secs(60 * 60);
/// `REDRIVE_BATCH_LIMIT` and `REDRIVE_MAX_ROUNDS` (`attachment-download-redriver.ts:19-27`).
const REDRIVE_BATCH: usize = 25;
const REDRIVE_ROUNDS: usize = 5;

pub(super) async fn drive(inner: Weak<Inner>, live: Live) {
    let mut uploads = interval(UPLOAD_EVERY);
    let mut downloads = interval(DOWNLOAD_EVERY);
    let mut release = interval(RELEASE_EVERY);
    for timer in [&mut uploads, &mut downloads, &mut release] {
        timer.set_missed_tick_behavior(MissedTickBehavior::Delay);
    }
    loop {
        // Biased: at start the uploads run first, then the downloads, then the release.
        let round = tokio::select! {
            biased;
            _ = uploads.tick() => Round::Uploads,
            () = live.uploads.notified() => Round::Uploads,
            () = live.reconnect.notified() => Round::Reconnect,
            _ = downloads.tick() => Round::Downloads,
            _ = release.tick() => Round::Release,
            () = live.release.notified() => Round::Release,
        };
        let Some(inner) = inner.upgrade() else { return };
        match round {
            Round::Uploads => redrive_uploads(&inner, &live).await,
            Round::Reconnect => {
                redrive_uploads(&inner, &live).await;
                redrive_downloads(&inner, &live).await;
            }
            Round::Downloads => redrive_downloads(&inner, &live).await,
            Round::Release => release_round(&inner, &live).await,
        }
    }
}

enum Round {
    Uploads,
    Reconnect,
    Downloads,
    Release,
}

/// `attachmentUploadRedriver.redrive`: the revived notes, then the backfill, then the drain. A
/// step that fails never skips the next; an unreachable vault skips the round, since every file
/// would read as deleted.
async fn redrive_uploads(inner: &Inner, live: &Live) {
    if !inner.vault.is_reachable() {
        tracing::info!("attachment upload re-drive skipped: the vault is not reachable");
        return;
    }
    let db = &inner.db;
    match settle_revived(
        db,
        live.transfer.server(),
        Arc::clone(&inner.vault),
        &live.device_id,
    )
    .await
    {
        Ok(report) if !report.pending.is_empty() => {
            tracing::warn!(pending = ?report.pending, "revived-note attachment checks deferred");
        }
        Ok(_) => {}
        Err(error) => tracing::warn!(%error, "revived-note attachment check skipped"),
    }
    if let Err(error) = backfill(db, Arc::clone(&inner.vault)).await {
        tracing::warn!(%error, "attachment backfill skipped");
    }
    match drain_uploads(
        db.clone(),
        Arc::clone(&live.transfer),
        Arc::clone(&inner.vault),
        Arc::clone(&live.device_id),
    )
    .await
    {
        Ok(drain) => {
            for (row, reason) in &drain.dropped {
                tracing::warn!(owner_id = %row.owner_id, path = %row.disk_path, %reason, "attachment upload dropped");
            }
            for row in &drain.stuck {
                tracing::error!(owner_id = %row.owner_id, path = %row.disk_path, attempts = row.attempts, "attachment upload stuck");
            }
            if drain.revoked {
                tracing::warn!("attachment uploads stopped: this device is revoked");
            }
            if drain.uploaded + drain.failed + drain.unreachable > 0 {
                tracing::info!(
                    uploaded = drain.uploaded,
                    failed = drain.failed,
                    unreachable = drain.unreachable,
                    "attachment upload re-drive"
                );
            }
        }
        Err(error) => tracing::warn!(%error, "attachment upload re-drive failed"),
    }
}

/// `redriveAttachmentDownloads`: the oldest due failures, 25 at a time. A row whose owner is no
/// live note, or no longer references the id, can never be driven again and is deleted as the
/// walk meets it; another round runs only when a round requested nothing and purged something.
async fn redrive_downloads(inner: &Arc<Inner>, live: &Live) {
    if !(inner.auto_download)() {
        return;
    }
    let root = inner.vault.root().to_owned();
    for _ in 0..REDRIVE_ROUNDS {
        let root = root.clone();
        let walked = inner
            .db
            .call(move |conn| {
                let now = now_ms();
                let mut requests = Vec::new();
                let mut purged = 0;
                for row in download_failures::list_redrivable(conn, now, REDRIVE_BATCH)? {
                    match target_of(conn, &root, &row.owner_id, &row.attachment_id)? {
                        Some(target) => requests.push(DownloadRequest {
                            owner_id: row.owner_id,
                            attachment_id: row.attachment_id,
                            target,
                            source: DownloadSource::Redrive,
                            size_hint: None,
                            recency_hint: None,
                        }),
                        None => {
                            download_failures::clear(conn, &row.owner_id, &row.attachment_id)?;
                            purged += 1;
                        }
                    }
                }
                Ok((requests, purged))
            })
            .await;
        let (requests, purged) = match walked {
            Ok(walked) => walked,
            Err(error) => {
                tracing::warn!(%error, "attachment download re-drive failed");
                return;
            }
        };
        let requested = requests.len();
        for request in requests {
            let (inner, live) = (Arc::clone(inner), live.clone());
            inner
                .runtime
                .clone()
                .spawn(async move { download(&inner, &live, request).await });
        }
        if requested > 0 || purged > 0 {
            tracing::info!(requested, purged, "re-drove failed attachment downloads");
        }
        if requested > 0 || purged == 0 {
            return;
        }
    }
}

/// Where a re-driven download of `owner_id` lands: its folder for a reference, its own file for
/// a file note, `None` when the owner no longer names it.
fn target_of(
    conn: &Connection,
    root: &Path,
    owner_id: &str,
    attachment_id: &str,
) -> Result<Option<DownloadTarget>, StorageError> {
    let note = conn
        .query_row(
            "SELECT n.attachment_id, f.path
             FROM notes n LEFT JOIN note_files f ON f.note_id = n.id
             WHERE n.id = ?1 AND n.deleted_at IS NULL",
            params![owner_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()
        .map_err(failed)?;
    let Some((own, path)) = note else {
        return Ok(None);
    };
    let references = notes::read_attachment_references(conn, owner_id)?;
    Ok(if references.iter().any(|id| id == attachment_id) {
        owner_dir(root, owner_id).map(DownloadTarget::Dir)
    } else if own.as_deref() == Some(attachment_id) {
        path.and_then(|path| under(root, &path))
            .map(DownloadTarget::Path)
    } else {
        None
    })
}

/// The pull asked for a file (`requestEmbeddedAttachmentDownloads`, `onDownloadNeeded`).
pub(super) async fn eager_download(inner: &Arc<Inner>, live: &Live, wanted: AttachmentDownload) {
    let root = inner.vault.root().to_owned();
    let (owner, id) = (wanted.owner_id.clone(), wanted.attachment_id.clone());
    let own_file = wanted.own_file;
    let decided = inner
        .db
        .call(move |conn| {
            // An unreadable failure table never stops a download (Electron fails open).
            let may = download_failures::may_attempt(conn, &owner, &id, now_ms()).unwrap_or(true);
            if !may {
                return Ok(None);
            }
            if own_file {
                return target_of(conn, &root, &owner, &id);
            }
            // This device uploaded the file from where it lives: a download would duplicate it.
            let held =
                files::path_of(conn, &owner, &id)?.is_some_and(|path| root.join(path).is_file());
            Ok((!held)
                .then(|| owner_dir(&root, &owner))
                .flatten()
                .map(DownloadTarget::Dir))
        })
        .await;
    let target = match decided {
        Ok(Some(target)) => target,
        Ok(None) => return,
        Err(error) => {
            tracing::warn!(owner_id = %wanted.owner_id, %error, "attachment download not requested");
            return;
        }
    };
    // A file note's file already on disk is this device's copy; never overwrite it.
    if let DownloadTarget::Path(path) = &target
        && path.exists()
    {
        return;
    }
    let request = DownloadRequest {
        owner_id: wanted.owner_id,
        attachment_id: wanted.attachment_id,
        target,
        source: DownloadSource::Eager,
        size_hint: None,
        recency_hint: None,
    };
    download(inner, live, request).await;
}

/// One download through the queue, and its outcome recorded: the file's record on success, a
/// failure row (404 `missing`, else `transient`) otherwise. A cleared queue records nothing.
async fn download(inner: &Inner, live: &Live, request: DownloadRequest) {
    let (owner, id) = (request.owner_id.clone(), request.attachment_id.clone());
    let Ok(outcome) = live.queue.enqueue(request).await else {
        return;
    };
    let now = now_ms();
    let written = match &outcome {
        Ok(landed) => {
            let Some(rel) = queue::relative(inner.vault.as_ref(), &landed.path.to_string_lossy())
            else {
                tracing::error!(owner_id = %owner, attachment_id = %id, "a download landed outside the vault");
                return;
            };
            lock(&live.landed).insert(download_failures::key(&owner, &id));
            let (owner, id) = (owner.clone(), id.clone());
            inner
                .db
                .call(move |conn| record_downloaded(conn, &owner, &rel, &id, now))
                .await
        }
        Err(error) => {
            let reason = if is_missing(error) {
                FailureReason::Missing
            } else {
                FailureReason::Transient
            };
            tracing::error!(owner_id = %owner, attachment_id = %id, reason = reason.as_str(), %error, "attachment download failed");
            let (owner, id, text) = (owner.clone(), id.clone(), error.to_string());
            inner
                .db
                .call(move |conn| {
                    download_failures::record_failure(conn, &owner, &id, reason, &text, now)
                        .map(drop)
                })
                .await
        }
    };
    if let Err(error) = written {
        tracing::error!(owner_id = %owner, attachment_id = %id, %error, "could not record an attachment download");
    }
}

/// The server does not have the attachment and never will (`markDownloadFailed`).
fn is_missing(error: &TransferError) -> bool {
    matches!(
        error,
        TransferError::Attachment(AttachmentError::Api(ApiError::Status { status: 404, .. }))
    )
}

/// `deletedAssetReleaseRunner.run`: only once a pass caught up this session and while the vault
/// is reachable. Canvas records stay deferred until Step 30 (#3547) supplies `CanvasAssets`.
async fn release_round(inner: &Inner, live: &Live) {
    if !inner.caught_up.load(Ordering::SeqCst) || !inner.vault.is_reachable() {
        return;
    }
    match release_due(&inner.db, live.transfer.server(), None, now_ms()).await {
        Ok(report) => {
            if report.settled > 0 {
                tracing::info!(
                    settled = report.settled,
                    "freed the attachments of deleted items"
                );
            }
            if !report.deferred.is_empty() {
                tracing::info!(deferred = ?report.deferred, "deleted-item releases deferred");
            }
        }
        Err(error) => tracing::warn!(%error, "deleted-asset release pass failed"),
    }
}

/// `attachments/<ownerId>/`, when the id is one plain name: ids come from peers.
fn owner_dir(root: &Path, owner_id: &str) -> Option<PathBuf> {
    let dir = under(root, &format!("attachments/{owner_id}"));
    if dir.is_none() || owner_id.contains(['/', '\\']) {
        tracing::warn!(
            owner_id,
            "attachment download refused: the owner id is not a plain name"
        );
        return None;
    }
    dir
}

/// `rel` under `root` when every part is a plain name, so a synced path never leaves the vault.
fn under(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = Path::new(rel);
    rel.components()
        .all(|part| matches!(part, Component::Normal(_)))
        .then(|| root.join(rel))
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
