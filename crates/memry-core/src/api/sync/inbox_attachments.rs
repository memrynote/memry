//! An Inbox capture's file between devices (#4157, chapter 14 §14.7.2).
//!
//! Desktop is the reference (`apps/desktop/src/main/inbox/`, the inbox
//! attachment sync); the decisions live in
//! [`crate::domain::inbox::attachments`], and this module does the file reads,
//! the transfers and the clock.
//!
//! **One pass, three jobs**, run by the shell after each sync pass and on a
//! path change, like [`VaultSync::redrive_attachments`]: upload the files of
//! captures made here, download the files of captures made elsewhere, and
//! release the files of captures deleted here 30 days ago. A pass writes the
//! `attachmentId` it uploaded through a local edit, so the shell syncs again
//! after a pass that uploaded something.
//!
//! **A file is read from and written to exactly
//! `attachments/inbox/<itemId>/<file>`.** The path arrives in a synced
//! payload, so anything else is refused rather than followed.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use crate::api::errors::ApiError;
use crate::domain::inbox::{self, attachments as inbox_files};

#[allow(unused_imports)]
use super::*;

/// One pass at a time per vault: two overlapping passes would upload a file
/// twice, and the second upload is a chunk set nothing references.
static PASS_GATES: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn pass_gate(vault_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut gates = PASS_GATES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    Arc::clone(gates.entry(vault_id.to_owned()).or_default())
}

/// What one pass did.
#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct InboxAttachmentSyncSummary {
    /// Files uploaded; each capture now carries its `attachmentId`.
    pub uploaded: u32,
    /// Files written under `attachments/inbox/`.
    pub downloaded: u32,
    /// Downloads held back by the metered policy (FR-045). Not a failure.
    pub deferred: u32,
    /// Failed this time and still owed; the next pass tries again.
    pub failed: u32,
    /// Deleted captures whose chunks were dereferenced.
    pub released: u32,
}

/// A capture's file, attached to a note.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct InboxFileAttachment {
    pub attachment_id: String,
    /// The name an embed in the note must use: peers place a note's download
    /// by its manifest filename.
    pub filename: String,
}

/// Whether the server refused an upload for good: over the plan's storage or
/// its file-size cap (`STORAGE_QUOTA_EXCEEDED`, `STORAGE_FILE_TOO_LARGE`, both
/// 413). Retrying cannot help, so the capture stays local-only.
fn is_permanent_refusal(error: &SyncError) -> bool {
    matches!(
        error,
        SyncError::Api {
            source: ApiError::Status { status, code, .. }
        } if *status == 413
            || matches!(
                code.as_deref(),
                Some("STORAGE_QUOTA_EXCEEDED" | "STORAGE_FILE_TOO_LARGE")
            )
    )
}

#[uniffi::export(async_runtime = "tokio")]
impl VaultSync {
    /// Uploads, downloads and releases Inbox files (#4157). `reachable` is the
    /// shell's observation: nothing is uploaded or released while offline, and
    /// downloads follow FR-045's metered policy through
    /// [`Self::fetch_attachment`].
    ///
    /// One failure never stops the pass: it is counted, and the work stays
    /// owed for the next call. Only a locked device ends it.
    pub async fn sync_inbox_attachments(
        &self,
        reachable: Reachable,
    ) -> Result<InboxAttachmentSyncSummary, SyncError> {
        let _pass = pass_gate(&self.vault_id).lock_owned().await;
        let mut summary = InboxAttachmentSyncSummary::default();
        if reachable != Reachable::Offline {
            self.upload_pending(&mut summary).await?;
        }
        self.download_missing(reachable, &mut summary).await?;
        if reachable != Reachable::Offline {
            self.release_due(&mut summary).await?;
        }
        Ok(summary)
    }

    /// Attaches a capture's file to a note it is being filed into.
    ///
    /// A capture whose upload is cached here is referenced from the note and
    /// not uploaded again; the returned `filename` is the manifest's, which an
    /// embed must use. Otherwise the capture's file is read and uploaded into
    /// the note as [`Self::upload_attachment`] does, under the given
    /// `filename`.
    pub async fn attach_inbox_file(
        &self,
        item_id: String,
        note_id: String,
        filename: String,
        mime_type: String,
    ) -> Result<InboxFileAttachment, SyncError> {
        let device_id = self.session.device_id()?;
        let (item, note) = (item_id.clone(), note_id.clone());
        let now = now_ms();
        let reused = self
            .db
            .call(move |conn| {
                let capture = inbox::get(conn, &item)?.ok_or_else(|| StorageError::NotFound {
                    what: format!("no capture {item}"),
                })?;
                let cached = match capture.attachment_id.as_deref() {
                    Some(id) => attachments::get(conn, id)?,
                    None => None,
                };
                let Some((row, filename)) = cached
                    .filter(|row| row.manifest.is_some())
                    .and_then(|row| row.filename.clone().map(|name| (row, name)))
                else {
                    return Ok(Err(capture));
                };
                notes::add_attachment_reference(conn, &note, &row.attachment_id, &device_id, now)?;
                Ok(Ok(InboxFileAttachment {
                    attachment_id: row.attachment_id,
                    filename,
                }))
            })
            .await?;
        let capture = match reused {
            Ok(attached) => return Ok(attached),
            Err(capture) => capture,
        };

        let bytes = self
            .read_capture_file(&capture)?
            .ok_or_else(|| SyncError::Storage {
                source: StorageError::NotFound {
                    what: format!("the file of capture {item_id} is not on this device"),
                },
            })?;
        let attachment_id = self
            .upload_attachment(note_id, filename.clone(), mime_type, bytes)
            .await?;
        // The file now belongs to the note; a later pass must not upload it
        // again for the capture.
        self.db
            .call(move |conn| inbox_files::clear_pending(conn, &item_id))
            .await?;
        Ok(InboxFileAttachment {
            attachment_id,
            filename,
        })
    }
}

impl VaultSync {
    fn vault_file(&self, relative: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(&self.directory).join(relative)
    }

    /// The bytes of a capture's file at its validated path, or `None` when the
    /// path is refused or the file is not there.
    fn read_capture_file(&self, capture: &inbox::InboxItem) -> Result<Option<Vec<u8>>, SyncError> {
        let Some(path) = capture.attachment_path.as_deref() else {
            return Ok(None);
        };
        if inbox_files::capture_file_name(&capture.id, path).is_none() {
            return Ok(None);
        }
        match std::fs::read(self.vault_file(path)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(storage_error(error)),
        }
    }

    /// Uploads every pending capture. A mark with nothing to upload, or an
    /// upload the server refuses for good, is cleared without an id.
    async fn upload_pending(
        &self,
        summary: &mut InboxAttachmentSyncSummary,
    ) -> Result<(), SyncError> {
        let device_id = self.session.device_id()?;
        let pending = self.db.call(|conn| inbox_files::pending_ids(conn)).await?;
        for item_id in pending {
            match self.upload_pending_one(&device_id, &item_id).await {
                Ok(true) => summary.uploaded += 1,
                Ok(false) => {}
                Err(SyncError::Locked) => return Err(SyncError::Locked),
                Err(_) => summary.failed += 1,
            }
        }
        Ok(())
    }

    async fn upload_pending_one(&self, device_id: &str, item_id: &str) -> Result<bool, SyncError> {
        let id = item_id.to_owned();
        let capture = self.db.call(move |conn| inbox::get(conn, &id)).await?;
        let drop_mark = || {
            let id = item_id.to_owned();
            self.db
                .call(move |conn| inbox_files::clear_pending(conn, &id))
        };
        let inbox_files::UploadPlan::Upload(target) = inbox_files::plan_upload(capture.as_ref())
        else {
            drop_mark().await?;
            return Ok(false);
        };
        let bytes = capture
            .as_ref()
            .map_or(Ok(None), |capture| self.read_capture_file(capture))?;
        let Some(bytes) = bytes else {
            drop_mark().await?;
            return Ok(false);
        };

        let uploaded = match self
            .upload_blob(&target.filename, &target.mime_type, &bytes)
            .await
        {
            Ok(uploaded) => uploaded,
            Err(error) if is_permanent_refusal(&error) => {
                drop_mark().await?;
                return Ok(false);
            }
            Err(error) => return Err(error),
        };

        let (id, device_id, now) = (item_id.to_owned(), device_id.to_owned(), now_ms());
        let recorded = self
            .db
            .call(move |conn| {
                uploaded.cache(conn, now)?;
                let recorded = match inbox_files::set_attachment_id(
                    conn,
                    &id,
                    &uploaded.attachment_id,
                    &device_id,
                    now,
                ) {
                    Ok(()) => true,
                    // Deleted while the file was going up.
                    Err(StorageError::NotFound { .. }) => false,
                    Err(error) => return Err(error),
                };
                inbox_files::clear_pending(conn, &id)?;
                Ok(recorded)
            })
            .await?;
        Ok(recorded)
    }

    /// Writes the file of every unfiled capture that names an upload and has
    /// no file at its path.
    async fn download_missing(
        &self,
        reachable: Reachable,
        summary: &mut InboxAttachmentSyncSummary,
    ) -> Result<(), SyncError> {
        let candidates = self
            .db
            .call(|conn| inbox_files::unfiled_with_upload(conn))
            .await?;
        for capture in candidates {
            let Some((attachment_id, path)) = inbox_files::download_target(&capture) else {
                continue;
            };
            if self.vault_file(path).exists() {
                continue;
            }
            match self.download_one(attachment_id, path, reachable).await {
                Ok(true) => summary.downloaded += 1,
                Ok(false) => summary.deferred += 1,
                Err(SyncError::Locked) => return Err(SyncError::Locked),
                Err(_) => summary.failed += 1,
            }
        }
        Ok(())
    }

    /// `true` when the file was written, `false` when the metered policy
    /// deferred it.
    async fn download_one(
        &self,
        attachment_id: &str,
        path: &str,
        reachable: Reachable,
    ) -> Result<bool, SyncError> {
        let id = attachment_id.to_owned();
        let cached = self
            .db
            .call(move |conn| attachments::get(conn, &id))
            .await?
            .and_then(|row| row.local_path)
            .filter(|local| self.images_file(local).is_file());
        let local = match cached {
            Some(local) => local,
            None => {
                let fetched = self
                    .fetch_attachment(attachment_id.to_owned(), reachable)
                    .await?;
                match fetched.local_path {
                    Some(local) if fetched.downloaded => local,
                    _ => return Ok(false),
                }
            }
        };
        self.copy_into_vault(&self.images_file(&local), path)?;
        Ok(true)
    }

    fn images_file(&self, local_path: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(&self.directory)
            .join("images")
            .join(local_path)
    }

    /// Copies via a sibling temp file, so a reader never sees half a file.
    fn copy_into_vault(&self, from: &std::path::Path, to_relative: &str) -> Result<(), SyncError> {
        let to = self.vault_file(to_relative);
        let Some(directory) = to.parent() else {
            return Ok(());
        };
        std::fs::create_dir_all(directory).map_err(storage_error)?;
        let partial = to.with_file_name(format!(
            ".{}.part",
            to.file_name().and_then(|n| n.to_str()).unwrap_or("file")
        ));
        let copied = std::fs::copy(from, &partial).and_then(|_| std::fs::rename(&partial, &to));
        if copied.is_err() {
            let _ = std::fs::remove_file(&partial);
        }
        copied.map_err(storage_error)
    }

    /// Dereferences the chunks of every deleted capture past its grace,
    /// unless a live note references the file.
    async fn release_due(&self, summary: &mut InboxAttachmentSyncSummary) -> Result<(), SyncError> {
        let due = self
            .db
            .call(|conn| inbox_files::due_releases(conn, now_ms()))
            .await?;
        for release in due {
            match self.release_one(&release).await {
                Ok(true) => summary.released += 1,
                Ok(false) => {}
                Err(SyncError::Locked) => return Err(SyncError::Locked),
                Err(_) => summary.failed += 1,
            }
        }
        Ok(())
    }

    async fn release_one(&self, release: &inbox_files::Release) -> Result<bool, SyncError> {
        let (item_id, attachment_id) = (release.item_id.clone(), release.attachment_id.clone());
        let (referenced, cached) = self
            .db
            .call(move |conn| {
                Ok((
                    inbox_files::referenced_by_live_note(conn, &attachment_id)?,
                    attachments::get(conn, &attachment_id)?,
                ))
            })
            .await?;
        let forget = || {
            let id = item_id.clone();
            self.db
                .call(move |conn| inbox_files::drop_release(conn, &id))
        };
        if referenced {
            forget().await?;
            return Ok(false);
        }

        let hashes = match cached
            .and_then(|row| row.manifest)
            .as_deref()
            .and_then(chunk_hashes)
        {
            Some(hashes) => hashes,
            None => match self.fetch_chunk_hashes(&release.attachment_id).await {
                Ok(hashes) => hashes,
                // The server no longer has it: nothing left to free.
                Err(SyncError::Api {
                    source: ApiError::Status { status: 404, .. },
                }) => {
                    forget().await?;
                    return Ok(false);
                }
                Err(error) => return Err(error),
            },
        };
        if !hashes.is_empty() {
            attachment_upload::dereference(&self.session.http(), &self.vault_id, &hashes)
                .await
                .map_err(attachment_error)?;
        }
        forget().await?;
        Ok(true)
    }

    async fn fetch_chunk_hashes(&self, attachment_id: &str) -> Result<Vec<String>, SyncError> {
        let master_key = Zeroizing::new(self.session.master_key()?.ok_or(SyncError::Locked)?);
        let vault_key = Zeroizing::new(keys::derive_vault_key(&master_key)?.to_vec());
        let directory = account::device_directory(&self.session.http()).await?;
        let (manifest, _) = protocol_attachments::fetch_manifest(
            &self.session.http(),
            &self.vault_id,
            attachment_id,
            &vault_key,
            &DirectorySigners(directory),
        )
        .await
        .map_err(attachment_error)?;
        Ok(manifest
            .chunks
            .into_iter()
            .map(|chunk| chunk.encrypted_hash)
            .collect())
    }
}

/// The encrypted chunk hashes of a cached manifest.
fn chunk_hashes(manifest: &str) -> Option<Vec<String>> {
    let manifest: protocol::attachment_manifest::AttachmentManifest =
        serde_json::from_str(manifest).ok()?;
    Some(
        manifest
            .chunks
            .into_iter()
            .map(|chunk| chunk.encrypted_hash)
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(status: u16, code: Option<&str>) -> SyncError {
        SyncError::Api {
            source: ApiError::Status {
                status,
                code: code.map(str::to_owned),
                message: String::new(),
            },
        }
    }

    #[test]
    fn quota_and_plan_size_refusals_are_permanent_and_the_rest_are_not() {
        assert!(is_permanent_refusal(&status(
            413,
            Some("STORAGE_QUOTA_EXCEEDED")
        )));
        assert!(is_permanent_refusal(&status(
            413,
            Some("STORAGE_FILE_TOO_LARGE")
        )));
        assert!(is_permanent_refusal(&status(413, None)));
        assert!(!is_permanent_refusal(&status(
            500,
            Some("STORAGE_UPLOAD_FAILED")
        )));
        assert!(!is_permanent_refusal(&status(429, None)));
        assert!(!is_permanent_refusal(&SyncError::Locked));
    }
}
