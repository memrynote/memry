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

impl VaultSync {
    /// Uploads every attachment still owed, oldest first. The sync pass runs
    /// it before its push.
    ///
    /// A refused upload is not owed any more: the picture stays on this
    /// device and no other device hears of it, as §14.7.2 does for a capture.
    /// Any other failure ends the walk and keeps the rest for the next pass.
    ///
    /// - Returns: how many uploaded.
    pub async fn upload_queued_attachments(&self) -> Result<u32, SyncError> {
        let ids = self
            .db
            .call(|conn| attachment_uploads::pending_ids(conn))
            .await?;
        let mut uploaded = 0;
        for attachment_id in ids {
            match self
                .upload_queued(&attachment_id, RetryPolicy::polled())
                .await
            {
                Ok(true) => uploaded += 1,
                Ok(false) => {}
                Err(error) if is_refused(&error) => {
                    self.db
                        .call(move |conn| attachment_uploads::clear(conn, &attachment_id))
                        .await?;
                }
                Err(SyncError::Locked) => return Err(SyncError::Locked),
                Err(_) => break,
            }
        }
        Ok(uploaded)
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
    ///   or it was detached) or the note is deleted here, which keeps it owed.
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
        self.db
            .call(move |conn| {
                let tx = crate::storage::nested_tx::begin(conn).map_err(notes::failed)?;
                uploaded.cache(&tx, now)?;
                notes::add_attachment_reference(
                    &tx,
                    &upload.note_id,
                    &upload.attachment_id,
                    &device_id,
                    now,
                )?;
                attachment_uploads::clear(&tx, &upload.attachment_id)?;
                tx.commit().map_err(notes::failed)
            })
            .await?;
        Ok(true)
    }
}
