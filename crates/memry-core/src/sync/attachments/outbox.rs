//! The upload outbox drain (#3535 S5): `attachment-outbox.ts`
//! `drainAttachmentOutbox`, three at a time as `upload-queue.ts`.
//!
//! A network error never drops an upload: the row keeps its place in
//! `attachment_upload_queue`. The queue rows are the only state an upload
//! needs, so a drain cut off by a crash resumes from them.

use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use super::queue::{VaultFiles, relative};
use super::records::record_uploaded;
use super::revival::live_notes;
use super::store::upload_queue::{self, PendingUpload, STUCK_UPLOAD_ATTEMPTS};
use super::transfer::{AttachmentTransfer, TransferError, now_ms};
use crate::api::errors::{ApiError, StorageError};
use crate::domain::notes::read_attachment_references;
use crate::protocol::attachments::AttachmentError;
use crate::storage::Db;

pub const MAX_CONCURRENT_UPLOADS: usize = 3;

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
    /// Rows kept untouched because the vault or the note's folder is away.
    pub unreachable: usize,
    /// The server refused this device; the drain stopped and counted nothing.
    pub revoked: bool,
}

enum Settled {
    Uploaded,
    Unreachable,
    Revoked,
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
    // A revoked device is refused for every row alike; trying the rest would
    // count an attempt against rows that did nothing wrong (#3414).
    let revoked = Arc::new(AtomicBool::new(false));
    let mut tasks = JoinSet::new();
    for row in due {
        let (db, transfer, vault) = (db.clone(), transfer.clone(), vault.clone());
        let (device_id, slots, revoked) = (device_id.clone(), slots.clone(), revoked.clone());
        tasks.spawn(async move {
            let _slot = slots.acquire_owned().await;
            if revoked.load(Ordering::SeqCst) {
                return Ok(Settled::Revoked);
            }
            let settled = upload_row(&db, &transfer, &vault, &device_id, row).await;
            if matches!(settled, Ok(Settled::Revoked)) {
                revoked.store(true, Ordering::SeqCst);
            }
            settled
        });
    }
    let mut drained = UploadDrain::default();
    while let Some(joined) = tasks.join_next().await {
        let settled = joined.map_err(|error| StorageError::Failed {
            what: format!("an upload task failed: {error}"),
        })??;
        match settled {
            Settled::Uploaded => drained.uploaded += 1,
            Settled::Unreachable => drained.unreachable += 1,
            Settled::Revoked => drained.revoked = true,
            Settled::Failed(stuck) => {
                drained.failed += 1;
                drained.stuck.extend(stuck);
            }
            Settled::Dropped(row, reason) => drained.dropped.push((row, reason)),
        }
    }
    if drained.revoked {
        eprintln!("memry-core: attachment upload drain stopped: this device was revoked");
    }
    Ok(drained)
}

async fn upload_row(
    db: &Db,
    transfer: &AttachmentTransfer,
    vault: &Arc<dyn VaultFiles>,
    device_id: &str,
    row: PendingUpload,
) -> Result<Settled, StorageError> {
    let Some(rel) = relative(vault.as_ref(), &row.disk_path) else {
        return drop_row(db, row, "the file is outside the vault".to_owned()).await;
    };
    let owner = row.owner_id.clone();
    let reusable = db
        .call(move |conn| read_attachment_references(conn, &owner))
        .await?;
    let name = rel.rsplit('/').next().unwrap_or(&rel).to_owned();
    let mut result = upload_once(transfer, vault.as_ref(), &rel, &name, &reusable).await;
    if matches!(result, Err(TransferError::FileChanged)) {
        // Nothing of the changed bytes left; the new bytes go up from the start.
        result = upload_once(transfer, vault.as_ref(), &rel, &name, &reusable).await;
    }
    match result {
        Ok(attachment_id) => {
            let (owner, path, device) = (row.owner_id.clone(), rel.clone(), device_id.to_owned());
            let queued = row.disk_path.clone();
            let referenced = db
                .call(move |conn| {
                    record_uploaded(
                        conn,
                        &owner,
                        &path,
                        &queued,
                        &attachment_id,
                        &device,
                        now_ms(),
                    )
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
            if file_is_deleted(db, vault.as_ref(), &row.owner_id).await? {
                drop_row(db, row, "the file was deleted".to_owned()).await
            } else {
                Ok(Settled::Unreachable)
            }
        }
        Err(TransferError::Attachment(AttachmentError::Api(ApiError::DeviceRevoked {
            ..
        }))) => Ok(Settled::Revoked),
        Err(error @ (TransferError::EmptyFile | TransferError::TooLarge { .. })) => {
            refuse_row(db, vault.clone(), row, error.to_string()).await
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

/// `uploadFileState` (`attachment-outbox.ts:178-193`): a missing file was
/// deleted only while the vault and its note's folder are there. A vault that
/// is away hides every file at once, and reading that as deletion would drop
/// every queued upload.
async fn file_is_deleted(
    db: &Db,
    vault: &dyn VaultFiles,
    owner_id: &str,
) -> Result<bool, StorageError> {
    if !vault.is_reachable() {
        return Ok(false);
    }
    let owner = owner_id.to_owned();
    let note_path = db
        .call(move |conn| Ok(live_notes(conn, Some(&owner))?.pop().and_then(|n| n.path)))
        .await?;
    Ok(
        match note_path.as_deref().and_then(|path| path.rsplit_once('/')) {
            Some((folder, _)) => vault.list_files(folder).is_ok(),
            None => true,
        },
    )
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

/// Drops a row the uploader refuses for good and remembers the refusal, so the
/// next re-drive does not queue the unchanged file again (#5711,
/// `attachment-outbox.ts:355-357`).
async fn refuse_row(
    db: &Db,
    vault: Arc<dyn VaultFiles>,
    row: PendingUpload,
    reason: String,
) -> Result<Settled, StorageError> {
    eprintln!(
        "memry-core: attachment upload of {} refused: {reason}",
        row.owner_id
    );
    let (owner, path) = (row.owner_id.clone(), row.disk_path.clone());
    db.call(move |conn| upload_queue::refuse(conn, vault.as_ref(), &owner, &path))
        .await?;
    Ok(Settled::Dropped(row, reason))
}
