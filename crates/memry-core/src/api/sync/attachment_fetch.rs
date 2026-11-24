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
use std::time::{Duration, Instant};

use tokio::sync::{OnceCell, Semaphore};

use crate::protocol::attachment_manifest::EncryptedAttachmentManifest;

#[allow(unused_imports)]
use super::*;

/// Desktop's `MAX_CONCURRENT_DOWNLOADS`.
const MAX_CONCURRENT_DOWNLOADS: usize = 3;

/// Desktop's `REDRIVE_BATCH_LIMIT`: one re-drive call asks for at most this
/// many, so a vault with thousands missing spreads them over several calls.
const REDRIVE_BATCH_LIMIT: usize = 25;

/// Desktop's `UNSUPPORTED_COOLDOWN_MS`: a server that answered the manifest
/// batch route 404 is not asked again for this long (§14.5.2).
const MANIFEST_BATCH_COOLDOWN: Duration = Duration::from_secs(10 * 60);

/// When each vault's server last answered the manifest batch route 404, keyed
/// like [`DOWNLOAD_GATES`] so every `VaultSync` of the vault shares it.
static MANIFEST_BATCH_UNSUPPORTED: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

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
        self.fetch_with_manifest(attachment_id, reachable, None, &OnceCell::new())
            .await
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
            .call(|conn| Ok(attachments::missing_downloads(conn)))
            .await??;
        let mut summary = AttachmentRedriveSummary {
            downloaded: 0,
            deferred: 0,
            failed: 0,
            remaining: count(missing.len().saturating_sub(REDRIVE_BATCH_LIMIT)),
        };
        // The manifests of this call's downloads are read in one batch first
        // (§14.5.2). The doc comments above feed the UniFFI checksums.
        let window: Vec<String> = missing.into_iter().take(REDRIVE_BATCH_LIMIT).collect();
        let mut prefetched = self.prefetch_manifests(&window, reachable).await?;
        // One device directory for the whole call, read by the first row that
        // downloads, so a deferred or locked re-drive still sends nothing.
        let directory = OnceCell::new();
        for attachment_id in window {
            let manifest = prefetched.remove(&attachment_id);
            match self
                .fetch_with_manifest(attachment_id, reachable, manifest, &directory)
                .await
            {
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

impl VaultSync {
    /// [`Self::fetch_attachment`], opening `prefetched` when a batch already
    /// read this attachment's manifest instead of fetching it alone, and
    /// resolving signers from `directory`, which the first download fills.
    async fn fetch_with_manifest(
        &self,
        attachment_id: String,
        reachable: Reachable,
        prefetched: Option<EncryptedAttachmentManifest>,
        directory: &OnceCell<account::DeviceDirectory>,
    ) -> Result<AttachmentFetchSummary, SyncError> {
        let wanted = attachment_id.clone();
        let cached = self
            .db
            .call(move |conn| Ok(attachments::get(conn, &wanted)))
            .await??;
        if !may_download(cached.as_ref(), reachable) {
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
        let directory = directory
            .get_or_try_init(|| async { account::device_directory(&self.session.http()).await })
            .await?;

        let signers = DirectorySigners(directory.clone());
        let (manifest, file_key) = match prefetched {
            Some(envelope) => protocol_attachments::open_manifest(&envelope, &vault_key, &signers),
            None => {
                protocol_attachments::fetch_manifest(
                    &self.session.http(),
                    &self.vault_id,
                    &attachment_id,
                    &vault_key,
                    &signers,
                )
                .await
            }
        }
        .map_err(attachment_error)?;
        // §14.7: the attachment id is the manifest's own `id`. A manifest that
        // names another attachment, by a single GET or under a batch key,
        // would land that file under this id.
        if manifest.id != attachment_id {
            return Err(SyncError::AttachmentCorrupt {
                what: format!(
                    "manifest names attachment {}, not {attachment_id}",
                    manifest.id
                ),
            });
        }

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

    /// The manifests of `window`'s downloads in one batch call (§14.5.2),
    /// leaving out ids the metered policy defers. Empty when fewer than two
    /// would download, when the device is locked, or when the server has no
    /// batch route; each download then fetches its own manifest, and a
    /// failed batch is reported by those single fetches.
    async fn prefetch_manifests(
        &self,
        window: &[String],
        reachable: Reachable,
    ) -> Result<HashMap<String, EncryptedAttachmentManifest>, SyncError> {
        let wanted = window.to_vec();
        // A row that will not read stays out of the batch and fails on its
        // own in `fetch_with_manifest`, so the rest still download.
        let rows = self
            .db
            .call(move |conn| {
                Ok(wanted
                    .iter()
                    .map(|id| {
                        attachments::get(conn, id)
                            .inspect_err(|error| {
                                eprintln!("memry-core: attachment re-drive: reading {id}: {error}");
                            })
                            .ok()
                    })
                    .collect::<Vec<_>>())
            })
            .await?;
        let ids: Vec<String> = window
            .iter()
            .zip(&rows)
            .filter(|(_, row)| {
                row.as_ref()
                    .is_some_and(|row| may_download(row.as_ref(), reachable))
            })
            .map(|(id, _)| id.clone())
            .collect();
        let unsupported = MANIFEST_BATCH_UNSUPPORTED
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&self.vault_id)
            .is_some_and(|at| at.elapsed() < MANIFEST_BATCH_COOLDOWN);
        // A key that cannot be read fails each row on its own, as before.
        let unlocked = matches!(self.session.master_key(), Ok(Some(_)));
        if ids.len() < 2 || unsupported || !unlocked {
            return Ok(HashMap::new());
        }
        let mut manifests = HashMap::new();
        for chunk in ids.chunks(protocol_attachments::MANIFEST_BATCH_CAP) {
            match protocol_attachments::fetch_manifests_batch(
                &self.session.http(),
                &self.vault_id,
                chunk,
            )
            .await
            {
                Ok(Some(batch)) => manifests.extend(batch),
                Ok(None) => {
                    MANIFEST_BATCH_UNSUPPORTED
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .insert(self.vault_id.clone(), Instant::now());
                    break;
                }
                Err(_) => break,
            }
        }
        Ok(manifests)
    }
}

/// FR-045: the row carries the user's override, and its absence means the
/// default, unmetered-only.
fn may_download(row: Option<&attachments::CachedAttachment>, reachable: Reachable) -> bool {
    attachments::may_download_with(row.is_none_or(|row| row.unmetered_only), reachable)
}
