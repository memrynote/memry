//! Attachment downloads: the on-demand fetch, its bounded queue, and the
//! re-driver that retries what never arrived (N206, #1829, #3251).
//!
//! Desktop is the reference (`apps/desktop/src/main/sync/download-queue.ts`,
//! `attachment-download-redriver.ts`): at most three downloads at once, and a
//! walk over referenced-but-missing attachments that does not wait for the
//! note to be re-applied by a pull. Without the walk a fresh device that lost
//! one download keeps a broken picture until someone edits the note.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use tokio::sync::Semaphore;

#[allow(unused_imports)]
use super::*;

/// Desktop's `MAX_CONCURRENT_DOWNLOADS`.
const MAX_CONCURRENT_DOWNLOADS: usize = 3;

/// Desktop's `REDRIVE_BATCH_LIMIT`: one re-drive call asks for at most this
/// many, so a vault with thousands missing spreads them over several calls.
const REDRIVE_BATCH_LIMIT: usize = 25;

/// One queue per vault, shared by every `VaultSync` the shell mints for it.
static DOWNLOAD_GATES: LazyLock<Mutex<HashMap<String, Arc<Semaphore>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn download_gate(vault_id: &str) -> Arc<Semaphore> {
    // A poisoned map only means another thread panicked while inserting; the
    // map itself is still a valid set of semaphores.
    let mut gates = DOWNLOAD_GATES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    Arc::clone(
        gates
            .entry(vault_id.to_owned())
            .or_insert_with(|| Arc::new(Semaphore::new(MAX_CONCURRENT_DOWNLOADS))),
    )
}

/// What one re-drive did.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AttachmentRedriveSummary {
    pub downloaded: u32,
    /// Held back by the metered policy (FR-045). Not a failure.
    pub deferred: u32,
    /// Failed this time; still missing, so the next re-drive asks again.
    pub failed: u32,
    /// Missing attachments past this call's batch, left for the next one.
    pub remaining: u32,
}

#[uniffi::export(async_runtime = "tokio")]
impl VaultSync {
    /// Fetches one attachment's bytes into `images/` (N206's data half).
    ///
    /// **`reachable` is the shell's observation and the policy is the core's.**
    /// Only the shell can see the current path; only one place should decide
    /// what that means, and FR-045's rule — lazy, unmetered by default, with
    /// an explicit per-item override — lives in
    /// [`crate::domain::attachments::may_download`] where a test can reach it
    /// without a network.
    ///
    /// **Deferring is a normal outcome, not an error.** A picture waiting for
    /// wifi is exactly what FR-045 asks for, so it comes back as
    /// `deferred: true` with no bytes written. A shell that met an error there
    /// would show a failure for working behaviour.
    ///
    /// The verification order of §14.4.1 is not this function's to choose: it
    /// calls [`crate::protocol::attachments::fetch_manifest`], which checks
    /// the signature before unwrapping the file key, and an unresolvable
    /// signer is refused there rather than skipped.
    pub async fn fetch_attachment(
        &self,
        attachment_id: String,
        reachable: Reachable,
    ) -> Result<AttachmentFetchSummary, SyncError> {
        // The row carries the user's override, and its absence means the
        // default: FR-045 starts every attachment unmetered-only.
        let wanted = attachment_id.clone();
        let cached = self
            .db
            .read(move |conn| Ok(attachments::get(conn, &wanted)))
            .await??;
        let unmetered_only = cached.as_ref().is_none_or(|row| row.unmetered_only);

        if !attachments::may_download_with(unmetered_only, reachable) {
            return Ok(AttachmentFetchSummary {
                downloaded: false,
                deferred: true,
                bytes: 0,
                local_path: cached.and_then(|row| row.local_path),
            });
        }

        // The bounded queue (#1829): every download, on-demand or re-driven,
        // waits here, so a note full of pictures cannot fan out into a burst
        // the `blob_download` bucket answers with 429s.
        let _permit = download_gate(&self.vault_id)
            .acquire_owned()
            .await
            .map_err(|error| SyncError::Storage {
                source: StorageError::Failed {
                    what: error.to_string(),
                },
            })?;

        let master_key = Zeroizing::new(self.session.master_key()?.ok_or(SyncError::Locked)?);
        let vault_key = Zeroizing::new(keys::derive_vault_key(&master_key)?.to_vec());
        let directory = account::device_directory(&self.session.http()).await?;

        let (manifest, file_key) = protocol_attachments::fetch_manifest(
            &self.session.http(),
            &self.vault_id,
            &attachment_id,
            &vault_key,
            &DirectorySigners(directory),
        )
        .await
        .map_err(attachment_error)?;

        let bytes = self
            .download_chunks(&attachment_id, &manifest, &file_key)
            .await?;
        let local_path = self.write_bytes(&attachment_id, &bytes)?;

        let manifest_json =
            protocol::attachment_manifest::manifest_json(&manifest).map_err(|error| {
                SyncError::AttachmentCorrupt {
                    what: error.to_string(),
                }
            })?;
        let manifest_text = String::from_utf8_lossy(&manifest_json).into_owned();
        // Ciphertext, because §14.8 reserves quota against it and the cache
        // budget is measured in the same figure.
        let remote_size: i64 = manifest
            .chunks
            .iter()
            .map(|chunk| chunk.size as i64 + 24 + 16)
            .sum();
        let id = attachment_id.clone();
        let filename = manifest.filename.clone();
        let mime_type = manifest.mime_type.clone();
        let stored = local_path.clone();
        let now = now_ms();
        self.db
            .call(move |conn| {
                attachments::put_manifest(
                    conn,
                    &id,
                    &manifest_text,
                    remote_size,
                    &filename,
                    &mime_type,
                )?;
                attachments::record_download(conn, &id, &stored, now)?;
                Ok(())
            })
            .await?;
        // Only after the row records the file: a crash before this line keeps
        // the landed chunks for the next attempt.
        let _ = std::fs::remove_dir_all(self.partial_dir(&attachment_id));

        Ok(AttachmentFetchSummary {
            downloaded: true,
            deferred: false,
            bytes: bytes.len() as u64,
            local_path: Some(local_path),
        })
    }

    /// Retries every attachment a note references whose bytes are not here
    /// (#1829's re-driver). The shell calls it on reconnect and after a sync
    /// pass; each attachment goes through [`Self::fetch_attachment`], so the
    /// metered policy and the bounded queue apply unchanged and large
    /// prefetch on cellular stays opt-in per item.
    ///
    /// One failure never stops the walk: it is counted and the row stays
    /// missing for the next call.
    pub async fn redrive_attachments(
        &self,
        reachable: Reachable,
    ) -> Result<AttachmentRedriveSummary, SyncError> {
        let missing = self
            .db
            .read(|conn| Ok(attachments::missing_downloads(conn)))
            .await??;
        let mut summary = AttachmentRedriveSummary {
            downloaded: 0,
            deferred: 0,
            failed: 0,
            remaining: count(missing.len().saturating_sub(REDRIVE_BATCH_LIMIT)),
        };
        for attachment_id in missing.into_iter().take(REDRIVE_BATCH_LIMIT) {
            match self.fetch_attachment(attachment_id, reachable).await {
                Ok(fetch) if fetch.downloaded => summary.downloaded += 1,
                Ok(_) => summary.deferred += 1,
                // A locked device fails every row the same way; say so once.
                Err(SyncError::Locked) => return Err(SyncError::Locked),
                Err(_) => summary.failed += 1,
            }
        }
        Ok(summary)
    }
}
