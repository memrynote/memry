//! A note's attachment kept here until it uploads (#5510, §14.7).
//!
//! [`VaultSync::upload_attachment`] keeps the bytes and their row before it
//! touches the network, then tries the upload once. One that did not get
//! through waits in `note_attachment_uploads` (see
//! [`crate::domain::attachment_uploads`]) and goes up on a later sync pass,
//! before that pass pushes, so the note's new reference leaves in the same
//! push.
//!
//! **Exactly one upload per attachment.** Every upload runs under the vault's
//! upload gate and re-reads its row under it, and the row goes in the same
//! transaction that stores the manifest and adds the reference. A second
//! caller then finds no row and uploads nothing. A crash between the manifest
//! PUT and that transaction uploads again under the same id, which replaces
//! the manifest and never mints a second id.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use crate::api::errors::ApiError;
use crate::domain::attachment_uploads::PendingUpload;

#[allow(unused_imports)]
use super::*;

static UPLOAD_GATES: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn upload_gate(vault_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut gates = UPLOAD_GATES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    Arc::clone(gates.entry(vault_id.to_owned()).or_default())
}

/// Whether the server refused the upload in a way no retry changes: a 4xx
/// other than an expired session (401), a timeout (408) or a rate limit (429),
/// or bytes that would not frame. Everything else, the network above all,
/// keeps the upload owed.
pub(super) fn is_refused(error: &SyncError) -> bool {
    match error {
        SyncError::Api {
            source: ApiError::Status { status, .. },
        } => (400..500).contains(status) && !matches!(status, 401 | 408 | 429),
        SyncError::AttachmentCorrupt { .. } => true,
        _ => false,
    }
}

/// Why the server refused an owed upload (#5532).
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum AttachmentRefusal {
    /// 413, or the `STORAGE_QUOTA_EXCEEDED` code: the plan's storage is full.
    StorageFull,
    /// 403: the account may not upload it.
    NotAllowed,
    /// Any other refusal: a 4xx such as a 400, or bytes that would not frame.
    Rejected,
}

/// What a walk over the owed uploads has to tell the user (#5532).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum QueuedAttachmentNews {
    /// The server refused the upload, and the user was not told of this
    /// refusal yet. It stays owed. `status` is the HTTP status, 0 for bytes
    /// that would not frame. `note_title` is empty for an untitled note.
    Refused {
        attachment_id: String,
        note_id: String,
        note_title: String,
        refusal: AttachmentRefusal,
        status: u16,
    },
    /// An upload the user was told was refused has landed.
    Uploaded {
        attachment_id: String,
        note_id: String,
    },
}

/// The refusal in `error` and its status, when no retry changes it.
fn refusal(error: &SyncError) -> Option<(AttachmentRefusal, u16)> {
    if !is_refused(error) {
        return None;
    }
    let SyncError::Api {
        source: ApiError::Status { status, code, .. },
    } = error
    else {
        return Some((AttachmentRefusal::Rejected, 0));
    };
    let refusal = match (status, code.as_deref()) {
        (413, _) | (_, Some("STORAGE_QUOTA_EXCEEDED")) => AttachmentRefusal::StorageFull,
        (403, _) => AttachmentRefusal::NotAllowed,
        _ => AttachmentRefusal::Rejected,
    };
    Some((refusal, *status))
}

/// What one walk over the owed uploads did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QueuedUploadSummary {
    pub uploaded: u32,
    /// Refused by the server this time and still owed. The sync pass counts
    /// them as rejected.
    pub refused: u32,
    /// Refusals the user was not told of yet, and landed uploads they were.
    pub news: Vec<QueuedAttachmentNews>,
}

impl VaultSync {
    /// Uploads every attachment still owed, oldest first. The sync pass runs
    /// it before its push.
    ///
    /// **A refused upload stays owed.** The picture is in a note this user
    /// sees, and the bytes here are the only copy: clearing the row would let
    /// the block unbind and the cache evict them. The next pass tries again,
    /// as desktop's attachment outbox does, so space freed later still gets
    /// it up. Any other failure ends the walk and keeps the rest for the next
    /// pass. A refusal is news until the pass that returns it records it as
    /// told ([`Self::remember_told`]), and its later upload is news too, so
    /// the shell can take back what it showed.
    pub async fn upload_queued_attachments(&self) -> Result<QueuedUploadSummary, SyncError> {
        let ids = self
            .db
            .call(|conn| attachment_uploads::pending_ids(conn))
            .await?;
        let mut summary = QueuedUploadSummary::default();
        for attachment_id in ids {
            let id = attachment_id.clone();
            let told = self
                .db
                .call(move |conn| {
                    let Some(upload) = attachment_uploads::get(conn, &id)? else {
                        return Ok(None);
                    };
                    let told = attachment_uploads::told_refusal(conn, &id)?;
                    Ok(told.map(|_| upload.note_id))
                })
                .await?;
            match self
                .upload_queued(&attachment_id, RetryPolicy::polled())
                .await
            {
                Ok(true) => {
                    summary.uploaded += 1;
                    if let Some(note_id) = told {
                        summary.news.push(QueuedAttachmentNews::Uploaded {
                            attachment_id,
                            note_id,
                        });
                    }
                }
                Ok(false) => {}
                Err(error) => match refusal(&error) {
                    Some((refusal, status)) => {
                        summary.refused += 1;
                        if let Some(news) = self.refused(attachment_id, refusal, status).await? {
                            summary.news.push(news);
                        }
                    }
                    None if matches!(error, SyncError::Locked) => return Err(SyncError::Locked),
                    None => break,
                },
            }
        }
        Ok(summary)
    }

    /// The refusal as news, unless the user was told of it with this status.
    async fn refused(
        &self,
        attachment_id: String,
        refusal: AttachmentRefusal,
        status: u16,
    ) -> Result<Option<QueuedAttachmentNews>, SyncError> {
        Ok(self
            .db
            .call(move |conn| {
                let Some(upload) = attachment_uploads::get(conn, &attachment_id)? else {
                    return Ok(None);
                };
                if attachment_uploads::told_refusal(conn, &attachment_id)? == Some(status) {
                    return Ok(None);
                }
                let note_title = attachment_uploads::note_title(conn, &upload.note_id)?;
                Ok(Some(QueuedAttachmentNews::Refused {
                    attachment_id,
                    note_id: upload.note_id,
                    note_title,
                    refusal,
                    status,
                }))
            })
            .await?)
    }

    /// Records the refusals in `news` as told. The sync pass calls it last,
    /// once nothing can fail before the shell gets its summary: a pass that
    /// fails after the walk leaves them to be told by the next one.
    pub(super) async fn remember_told(
        &self,
        news: &[QueuedAttachmentNews],
    ) -> Result<(), SyncError> {
        let told: Vec<(String, u16)> = news
            .iter()
            .filter_map(|item| match item {
                QueuedAttachmentNews::Refused {
                    attachment_id,
                    status,
                    ..
                } => Some((attachment_id.clone(), *status)),
                QueuedAttachmentNews::Uploaded { .. } => None,
            })
            .collect();
        if told.is_empty() {
            return Ok(());
        }
        self.db
            .call(move |conn| {
                for (attachment_id, status) in &told {
                    attachment_uploads::remember_refusal(conn, attachment_id, *status)?;
                }
                Ok(())
            })
            .await?;
        Ok(())
    }

    /// Keeps the bytes under `images/` and records them as owed an upload,
    /// before anything goes over the network.
    pub(super) async fn queue_note_attachment(
        &self,
        note_id: String,
        filename: String,
        mime_type: String,
        bytes: &[u8],
    ) -> Result<String, SyncError> {
        // 128 bits of libsodium randomness, hex — the same shape a note id
        // takes, and for the same reason: the id becomes a path parameter on
        // `/sync/attachments/:attachment_id/manifest`.
        let attachment_id = hex_id();
        let local_path = self.write_bytes(&attachment_id, bytes)?;
        let upload = PendingUpload {
            attachment_id: attachment_id.clone(),
            note_id,
            filename,
            mime_type,
            local_path,
        };
        let now = now_ms();
        self.db
            .call(move |conn| attachment_uploads::queue(conn, &upload, now))
            .await?;
        Ok(attachment_id)
    }

    /// Takes back an attach the server refused at once, bytes included.
    pub(super) async fn discard_queued(&self, attachment_id: &str) -> Result<(), SyncError> {
        let id = attachment_id.to_owned();
        self.db
            .call(move |conn| attachment_uploads::discard(conn, &id))
            .await?;
        let _ = std::fs::remove_file(
            PathBuf::from(&self.directory)
                .join("images")
                .join(attachment_id),
        );
        Ok(())
    }

    /// Uploads one owed attachment under its own id and references it from
    /// its note.
    ///
    /// - Returns: `false` when nothing was owed (another caller uploaded it,
    ///   or it was detached, before or during the upload) or the note is
    ///   deleted here, which keeps it owed.
    pub(super) async fn upload_queued(
        &self,
        attachment_id: &str,
        initiate: RetryPolicy,
    ) -> Result<bool, SyncError> {
        let _gate = upload_gate(&self.vault_id).lock_owned().await;
        let id = attachment_id.to_owned();
        let pending = self
            .db
            .call(move |conn| {
                let Some(upload) = attachment_uploads::get(conn, &id)? else {
                    return Ok(None);
                };
                let live = attachment_uploads::note_is_live(conn, &upload.note_id)?;
                Ok(live.then_some(upload))
            })
            .await?;
        let Some(upload) = pending else {
            return Ok(false);
        };
        let device_id = self.session.device_id()?;
        let path = PathBuf::from(&self.directory)
            .join("images")
            .join(&upload.local_path);
        let bytes = std::fs::read(path).map_err(storage_error)?;

        let uploaded = self
            .upload_blob(
                upload.attachment_id.clone(),
                &upload.filename,
                &upload.mime_type,
                &bytes,
                initiate,
            )
            .await?;

        let now = now_ms();
        let hashes = uploaded.encrypted_hashes.clone();
        let referenced = self
            .db
            .call(move |conn| {
                let tx = crate::storage::nested_tx::begin(conn).map_err(notes::failed)?;
                // Detached while the bytes were going up: the user removed the
                // picture, so the note must not gain it back.
                if attachment_uploads::get(&tx, &upload.attachment_id)?.is_none() {
                    return Ok(false);
                }
                uploaded.cache(&tx, now)?;
                notes::add_attachment_reference(
                    &tx,
                    &upload.note_id,
                    &upload.attachment_id,
                    &device_id,
                    now,
                )?;
                attachment_uploads::clear(&tx, &upload.attachment_id)?;
                tx.commit().map_err(notes::failed)?;
                Ok(true)
            })
            .await?;
        if !referenced {
            // Nothing will name these chunks, so their quota goes back (§14.8).
            attachment_upload::dereference(&self.session.http(), &self.vault_id, &hashes)
                .await
                .map_err(attachment_error)?;
        }
        Ok(referenced)
    }
}
