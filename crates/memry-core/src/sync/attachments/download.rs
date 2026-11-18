//! Streaming download of one attachment into a vault file (§14.7's chain),
//! Electron's `downloadAttachment` (`apps/desktop/src/main/sync/attachments.ts:740-960`).
//!
//! The manifest's signature is checked before its key is unwrapped
//! (`fetch_manifest`, §14.4.1). Each chunk is decrypted, checked against its
//! plaintext hash, appended to the partial file and fsynced before the
//! sidecar counts it ([`super::resume`]), so the file is never held in memory
//! and an interrupted download resumes at its first missing chunk, across a
//! restart. The destination appears only by renaming a partial whose whole-file
//! checksum matched: a partial download never replaces a good local file.
//!
//! A transport failure, a 429, a 5xx or a full disk keeps the partial; any
//! other failure (a bad chunk, a 4xx) discards it so the next try starts clean.
//! A rename that fails (the destination open in another process on Windows)
//! keeps the fully verified partial too, where Electron discards it: the retry
//! then only renames.
//!
//! One download runs per destination at a time ([`AttachmentTransfer::hold`]);
//! a second one for the same file waits for it, then finds the file in place
//! (a `Dir` target) or lands it again (a `Path` target).

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::pin::pin;

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::presign::UrlWindow;
use super::resume::{self, ResumePoint, ResumeState};
use super::transfer::{AttachmentTransfer, TransferError, is_disk_full, now_ms};
use crate::api::errors::ApiError;
use crate::protocol::attachment_manifest::{AttachmentChunkRef, AttachmentManifest};
use crate::protocol::attachments::{
    AttachmentError, decode_chunk, fetch_chunk_presigned, fetch_chunk_proxied, fetch_manifest,
};

/// Where a download lands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadTarget {
    /// This exact file (a file note's linked path).
    Path(PathBuf),
    /// This directory, under the manifest's file name made safe
    /// (`attachments/<ownerId>/` for an inline image).
    Dir(PathBuf),
}

/// A download that landed.
#[derive(Debug, Clone)]
pub struct Downloaded {
    pub path: PathBuf,
    pub manifest: AttachmentManifest,
    /// The file was already there at the manifest's size (a `Dir` target
    /// only), so nothing was fetched.
    pub already_present: bool,
}

/// The partial file being written, and what it holds so far.
struct Landing {
    file: File,
    whole: Sha256,
    state_path: PathBuf,
    point: ResumePoint,
}

/// This transfer's presigned urls (`DirectDownloadState`): one refresh after a
/// rejected url, then the Worker for the rest of the file.
#[derive(Default)]
struct Direct {
    window: Option<UrlWindow>,
    refresh_used: bool,
    proxied: bool,
}

impl AttachmentTransfer {
    /// Downloads `attachment_id` to `target` and returns where it landed.
    pub async fn download_to_file(
        &self,
        attachment_id: &str,
        target: DownloadTarget,
    ) -> Result<Downloaded, TransferError> {
        let (manifest, file_key) = fetch_manifest(
            &self.http,
            &self.vault_id,
            attachment_id,
            &self.vault_key,
            self.signers.as_ref(),
        )
        .await?;
        let file_key = Zeroizing::new(file_key);
        let dest = match &target {
            DownloadTarget::Path(path) => path.clone(),
            // A crafted manifest cannot leave the directory: base name, then
            // the vault's file-name rules.
            DownloadTarget::Dir(dir) => dir.join((self.sanitize)(base_name(&manifest.filename))),
        };
        let _held = self.hold(&dest).await;
        if matches!(target, DownloadTarget::Dir(_))
            && fs::metadata(&dest).is_ok_and(|meta| meta.is_file() && meta.len() == manifest.size)
        {
            return Ok(Downloaded {
                path: dest,
                manifest,
                already_present: true,
            });
        }

        let (partial, state_path) = resume::partial_paths(&dest, attachment_id, self.sanitize);
        let landed = self
            .land(&manifest, &file_key, &dest, &partial, &state_path)
            .await;
        let landing = match landed {
            Ok(landing) => landing,
            Err(error) => {
                if !(error.is_resumable() || matches!(error, TransferError::DiskFull(_))) {
                    resume::discard(&partial, &state_path);
                }
                return Err(error);
            }
        };
        drop(landing.file);
        if hex::encode(landing.whole.finalize()) != manifest.checksum {
            resume::discard(&partial, &state_path);
            return Err(AttachmentError::ChecksumMismatch.into());
        }
        fs::rename(&partial, &dest).map_err(io_error)?;
        let _ = fs::remove_file(&state_path);
        Ok(Downloaded {
            path: dest,
            manifest,
            already_present: false,
        })
    }

    /// Waits until no other download of this transfer lands at `dest`, then
    /// holds it until the returned guard drops.
    async fn hold(&self, dest: &Path) -> Held<'_> {
        loop {
            // Registered before the check, so a release between the check and
            // the wait still wakes this one.
            let mut released = pin!(self.landed.notified());
            released.as_mut().enable();
            if self.in_flight().insert(dest.to_path_buf()) {
                return Held {
                    transfer: self,
                    dest: dest.to_path_buf(),
                };
            }
            released.await;
        }
    }

    fn in_flight(&self) -> std::sync::MutexGuard<'_, std::collections::HashSet<PathBuf>> {
        // A poisoned lock only means a panic elsewhere; the set is valid.
        self.landing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Fetches, checks and appends every chunk the partial does not hold yet.
    async fn land(
        &self,
        manifest: &AttachmentManifest,
        file_key: &[u8],
        dest: &Path,
        partial: &Path,
        state_path: &Path,
    ) -> Result<Landing, TransferError> {
        let mut landing = blocking({
            let (dir, partial, state_path, manifest) = (
                dest.parent().map(Path::to_path_buf),
                partial.to_path_buf(),
                state_path.to_path_buf(),
                manifest.clone(),
            );
            move || open_landing(dir, partial, state_path, &manifest)
        })
        .await?;

        let chunks = resume::ordered_chunks(manifest);
        let hashes: Vec<String> = chunks.iter().map(|c| c.encrypted_hash.clone()).collect();
        let mut direct = Direct::default();
        let start = usize::try_from(landing.point.chunks_done).unwrap_or(usize::MAX);
        for (at, chunk) in chunks.iter().enumerate().skip(start) {
            let framed = self.fetch_chunk(chunk, &hashes[at..], &mut direct).await?;
            let state = ResumeState {
                version: 1,
                attachment_id: manifest.id.clone(),
                checksum: manifest.checksum.clone(),
                chunk_count: chunks.len() as u64,
                chunks_done: at as u64 + 1,
                bytes_written: landing.point.bytes_written + chunk.size,
            };
            let key = Zeroizing::new(file_key.to_vec());
            let chunk = chunk.clone();
            landing = blocking(move || append(landing, &framed, &key, &chunk, &state)).await?;
        }
        Ok(landing)
    }

    /// One chunk's framed bytes, presigned first (`downloadChunkDirectOrProxied`).
    async fn fetch_chunk(
        &self,
        chunk: &AttachmentChunkRef,
        pending: &[String],
        direct: &mut Direct,
    ) -> Result<Vec<u8>, AttachmentError> {
        let hash = &chunk.encrypted_hash;
        let Some(url) = self.presigned_url(hash, pending, direct).await else {
            return fetch_chunk_proxied(&self.http, &self.vault_id, hash).await;
        };
        match fetch_chunk_presigned(&self.http, &url).await {
            Ok(framed) => return Ok(framed),
            Err(AttachmentError::Api(ApiError::Status { status: 403, .. }))
                if !direct.refresh_used =>
            {
                // An expired or rejected signature: ask once more, then take
                // the Worker as the answer.
                direct.refresh_used = true;
                direct.window = self
                    .presign
                    .window(&self.http, &self.vault_id, pending, now_ms())
                    .await;
                let retry = direct.window.as_ref().and_then(|w| w.urls.get(hash));
                if let Some(url) = retry
                    && let Ok(framed) = fetch_chunk_presigned(&self.http, url).await
                {
                    return Ok(framed);
                }
            }
            Err(_) => {}
        }
        direct.proxied = true;
        fetch_chunk_proxied(&self.http, &self.vault_id, hash).await
    }

    /// `nextPresignedDownloadUrl`: the url still valid for `hash`, arming a
    /// new window over the remaining chunks when there is none.
    async fn presigned_url(
        &self,
        hash: &str,
        pending: &[String],
        direct: &mut Direct,
    ) -> Option<String> {
        let now = now_ms();
        if direct.proxied || !self.presign.available(now) {
            return None;
        }
        if let Some(window) = &direct.window
            && now < window.expires_at_ms
        {
            return window.urls.get(hash).cloned();
        }
        direct.window = self
            .presign
            .window(&self.http, &self.vault_id, pending, now)
            .await;
        direct.window.as_ref()?.urls.get(hash).cloned()
    }
}

/// A destination held by one download; dropping it lets the next one in.
struct Held<'a> {
    transfer: &'a AttachmentTransfer,
    dest: PathBuf,
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        self.transfer.in_flight().remove(&self.dest);
        self.transfer.landed.notify_waiters();
    }
}

/// Creates the directory, loads the resume point and reopens the partial, with
/// the whole-file hash rebuilt over what it already holds.
fn open_landing(
    dir: Option<PathBuf>,
    partial: PathBuf,
    state_path: PathBuf,
    manifest: &AttachmentManifest,
) -> Result<Landing, TransferError> {
    if let Some(dir) = dir {
        fs::create_dir_all(&dir).map_err(io_error)?;
    }
    let point = resume::load(&partial, &state_path, manifest);
    let mut whole = Sha256::new();
    if point.chunks_done > 0 {
        let mut held = File::open(&partial).map_err(io_error)?;
        let mut buffer = vec![0; 1 << 20];
        loop {
            match held.read(&mut buffer).map_err(io_error)? {
                0 => break,
                read => whole.update(&buffer[..read]),
            }
        }
    }
    let file = resume::private_file(&partial, point.chunks_done > 0).map_err(io_error)?;
    Ok(Landing {
        file,
        whole,
        state_path,
        point,
    })
}

/// Decrypts and checks one chunk, appends it, fsyncs, then records it: the
/// sidecar never counts bytes the OS holds only in its page cache.
fn append(
    mut landing: Landing,
    framed: &[u8],
    file_key: &[u8],
    chunk: &AttachmentChunkRef,
    state: &ResumeState,
) -> Result<Landing, TransferError> {
    let plaintext = Zeroizing::new(decode_chunk(
        framed,
        file_key,
        chunk.index,
        &chunk.hash,
        chunk.size,
    )?);
    landing.whole.update(plaintext.as_slice());
    landing.file.write_all(&plaintext).map_err(io_error)?;
    landing.file.sync_all().map_err(io_error)?;
    resume::persist(&landing.state_path, state).map_err(io_error)?;
    landing.point = ResumePoint {
        chunks_done: state.chunks_done,
        bytes_written: state.bytes_written,
    };
    Ok(landing)
}

/// `path.basename` over either separator.
fn base_name(name: &str) -> &str {
    name.rsplit(['/', '\\']).next().unwrap_or(name)
}

fn io_error(error: io::Error) -> TransferError {
    if is_disk_full(&error) {
        TransferError::DiskFull(error)
    } else {
        TransferError::Io(error)
    }
}

/// Runs disk work off the async runtime.
pub(super) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, TransferError> + Send + 'static,
) -> Result<T, TransferError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| TransferError::Io(io::Error::other(error.to_string())))?
}
