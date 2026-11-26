//! Attachment upload, dereference and the byte transfer behind them (N209-N212).
//!
//! Split from `sync.rs` along the seam the `impl` blocks already drew.

use std::io::Write as _;

#[allow(unused_imports)]
use super::*;

#[uniffi::export(async_runtime = "tokio")]
impl VaultSync {
    /// Uploads a file and attaches it to a note (N214).
    ///
    /// The whole chain of §14.2–§14.5 in one call, because every step is
    /// useless alone and a shell that could stop between them would leave
    /// chunks in R2 that no manifest names.
    ///
    /// **The note's reference list is merged, never replaced.** A note can
    /// embed several pictures and each upload lands separately, so replacing
    /// drops every id but the last.
    ///
    /// The reference is recorded **after** the manifest is stored, in that
    /// order: a note pointing at an attachment whose manifest is not there yet
    /// shows a broken picture on every other device, while a manifest nothing
    /// references yet is merely unreachable and is what `dereference` exists
    /// to collect.
    pub async fn upload_attachment(
        &self,
        note_id: String,
        filename: String,
        mime_type: String,
        bytes: Vec<u8>,
    ) -> Result<String, SyncError> {
        // The bytes are kept before anything goes over the network (#5510):
        // the file and its row land first, under the id this returns, so the
        // shell inserts the block whether or not the upload gets through. The
        // upload is tried once here. One that fails for want of a network or
        // a healthy server stays owed, and the next sync pass sends it under
        // the same id (`note_uploads`). Only a refusal no retry can fix, a 4xx
        // such as a quota or file-size 413, takes the attach back. Said here
        // rather than in the doc comment, which UniFFI checksums into the
        // generated Swift.
        let attachment_id = self
            .queue_note_attachment(note_id, filename, mime_type, &bytes)
            .await?;
        match self
            .upload_queued(&attachment_id, RetryPolicy::never())
            .await
        {
            Err(error) if is_refused(&error) => {
                self.discard_queued(&attachment_id).await?;
                Err(error)
            }
            // Uploaded, or kept for the next sync pass.
            _ => Ok(attachment_id),
        }
    }

    /// Detaches an attachment from a note and releases its bytes (N215, N212).
    ///
    /// **Dereferencing is not optional here.** §14.8: "a client that later
    /// gains the ability to delete an attachment MUST dereference", and
    /// gaining it is exactly what this phase did. A client that dropped the
    /// reference without telling the server would leak the user's own quota,
    /// silently and permanently.
    ///
    /// The reference is dropped **before** the chunks are released, so a
    /// failure between the two leaves bytes nothing points at — reachable
    /// only by a later sweep — rather than a note pointing at bytes that are
    /// gone.
    pub async fn detach_attachment(
        &self,
        note_id: String,
        attachment_id: String,
    ) -> Result<(), SyncError> {
        let device_id = self.session.device_id()?;
        let id = attachment_id.clone();
        let note = note_id.clone();
        let now = now_ms();

        let (row, still_referenced) = self
            .db
            .call(move |conn| {
                // A picture removed before its upload never uploads (#5510).
                attachment_uploads::clear(conn, &id)?;
                notes::remove_attachment_reference(conn, &note, &id, &device_id, now)?;
                let row = attachments::get(conn, &id)?;
                // Another note may embed the same attachment. Releasing its
                // chunks then would break that note's picture.
                let others = attachments::for_note_count_excluding(conn, &id, &note)?;
                Ok((row, others > 0))
            })
            .await?;

        if still_referenced {
            return Ok(());
        }

        if let Some(row) = row
            && let Some(manifest) = row.manifest.as_deref()
            && let Ok(manifest) =
                serde_json::from_str::<protocol::attachment_manifest::AttachmentManifest>(manifest)
        {
            let hashes: Vec<String> = manifest
                .chunks
                .iter()
                .map(|chunk| chunk.encrypted_hash.clone())
                .collect();
            attachment_upload::dereference(&self.session.http(), &self.vault_id, &hashes)
                .await
                .map_err(attachment_error)?;
        }
        Ok(())
    }
}

/// An attachment that is on the server and in the local cache's bytes, whose
/// cache rows are not written yet.
pub(super) struct UploadedBlob {
    pub(super) attachment_id: String,
    pub(super) filename: String,
    pub(super) mime_type: String,
    manifest_text: String,
    remote_size: i64,
    local_path: String,
}

impl UploadedBlob {
    /// The manifest and the bytes' place under `images/`, so a placeholder
    /// reads the row and the bytes need no download.
    pub(super) fn cache(&self, conn: &rusqlite::Connection, now: i64) -> Result<(), StorageError> {
        attachments::put_manifest(
            conn,
            &self.attachment_id,
            &self.manifest_text,
            self.remote_size,
            &self.filename,
            &self.mime_type,
        )?;
        attachments::record_download(conn, &self.attachment_id, &self.local_path, now)
    }
}

impl VaultSync {
    /// The upload chain of §14.2–§14.5 for one file under `attachment_id`:
    /// frame, upload the chunks and store the signed manifest. It writes no
    /// bytes and references the attachment from nothing: the caller keeps the
    /// file at `images/<attachment_id>` ([`Self::write_bytes`]) and references
    /// it after [`UploadedBlob::cache`]. A queued note upload's file is the
    /// only copy, so it is never rewritten here (#5510). `initiate` is the
    /// first call's retry ladder.
    ///
    /// `opened` gets the chunks' R2 addresses once the session is open and
    /// before any chunk goes up, which is where the server starts counting
    /// them (§14.8), so a caller can record them before they can leak.
    pub(super) async fn upload_blob(
        &self,
        attachment_id: String,
        filename: &str,
        mime_type: &str,
        bytes: &[u8],
        initiate: RetryPolicy,
        opened: impl AsyncFnOnce(Vec<String>) -> Result<(), SyncError>,
    ) -> Result<UploadedBlob, SyncError> {
        let master_key = Zeroizing::new(self.session.master_key()?.ok_or(SyncError::Locked)?);
        let vault_key = Zeroizing::new(keys::derive_vault_key(&master_key)?.to_vec());
        let signing_key = self.session.signing_secret_key()?;

        // One file key for every chunk, because the manifest wraps exactly one
        // (§14.2). Fresh per attachment, never reused.
        let file_key = Zeroizing::new(sodium::random_bytes(32));

        let chunks = attachment_upload::frame_chunks(
            bytes,
            &file_key,
            attachment_upload::DEFAULT_CHUNK_SIZE,
            |_| sodium::random_bytes(24),
        )
        .map_err(attachment_error)?;

        let session = attachment_upload::initiate(
            &self.session.http(),
            &self.vault_id,
            &attachment_id,
            filename,
            bytes.len() as u64,
            &chunks
                .iter()
                .map(|chunk| chunk.reference.clone())
                .collect::<Vec<_>>(),
            initiate,
        )
        .await
        .map_err(attachment_error)?;
        opened(
            chunks
                .iter()
                .map(|chunk| chunk.reference.encrypted_hash.clone())
                .collect(),
        )
        .await?;

        // A failure part way leaves a session the server will expire on its
        // own; cancelling is the tidy path and is not load-bearing.
        let direct = match self.put_all(&session, &chunks).await {
            Ok(direct) => direct,
            Err(error) => {
                let _ = attachment_upload::cancel(
                    &self.session.http(),
                    &self.vault_id,
                    &session.session_id,
                )
                .await;
                return Err(error);
            }
        };

        attachment_upload::complete(
            &self.session.http(),
            &self.vault_id,
            &session.session_id,
            &direct,
        )
        .await
        .map_err(attachment_error)?;

        let manifest = attachment_upload::build_manifest(
            &attachment_id,
            filename,
            mime_type,
            bytes,
            &chunks,
            attachment_upload::DEFAULT_CHUNK_SIZE,
            now_ms(),
        );
        let envelope = protocol::attachment_manifest::encrypt(
            &manifest,
            &file_key,
            &vault_key,
            &sodium::random_bytes(24),
            &sodium::random_bytes(24),
            &signing_key,
            // Signed as the server's id for this device, which other devices
            // resolve to a public key; `device_id` stays the local clock id.
            &self.session.registered_device_id()?,
        )
        .map_err(|error| SyncError::AttachmentCorrupt {
            what: error.to_string(),
        })?;
        attachment_upload::put_manifest(
            &self.session.http(),
            &self.vault_id,
            &attachment_id,
            &envelope,
        )
        .await
        .map_err(attachment_error)?;

        let manifest_json =
            protocol::attachment_manifest::manifest_json(&manifest).map_err(|error| {
                SyncError::AttachmentCorrupt {
                    what: error.to_string(),
                }
            })?;
        let manifest_text = String::from_utf8_lossy(&manifest_json).into_owned();
        let remote_size = attachment_upload::encrypted_size(&chunks) as i64;

        Ok(UploadedBlob {
            // `write_bytes`'s name for the file, which the caller owns.
            local_path: attachment_id.clone(),
            attachment_id,
            filename: filename.to_owned(),
            mime_type: mime_type.to_owned(),
            manifest_text,
            remote_size,
        })
    }

    /// Every chunk up, by whichever transfer path the session offered.
    pub(super) async fn put_all(
        &self,
        session: &attachment_upload::UploadSession,
        chunks: &[attachment_upload::FramedChunk],
    ) -> Result<Vec<attachment_upload::DirectChunk>, SyncError> {
        let mut direct = Vec::new();
        for chunk in chunks {
            // A presigned PUT that fails goes through the Worker instead, as
            // desktop does: a stale signature is not a failed upload.
            if let Some(url) = session.chunk_urls.get(&chunk.reference.encrypted_hash)
                && attachment_upload::put_chunk_presigned(&self.session.http(), url, chunk)
                    .await
                    .is_ok()
            {
                direct.push(attachment_upload::DirectChunk::of(chunk));
                continue;
            }
            attachment_upload::put_chunk(
                &self.session.http(),
                &self.vault_id,
                &session.session_id,
                chunk,
            )
            .await
            .map_err(attachment_error)?;
        }
        Ok(direct)
    }

    /// Every chunk, by whichever transfer path this deployment offers (§14.6).
    ///
    /// Presign is tried once. `STORAGE_PRESIGN_UNAVAILABLE` is permanent for
    /// the deployment, so the proxied path is used for the rest of this file
    /// and the route is not asked again within it.
    ///
    /// **Resumable per chunk** (#1829). Each verified plaintext chunk lands in
    /// `images/.partial/<attachment_id>/<index>` before the next is asked for,
    /// so a download that fails part way keeps what arrived and the retry asks
    /// only for the rest. A landed chunk is re-checked against its manifest
    /// hash before reuse; one that fails is fetched again. The directory goes
    /// once the whole file is assembled.
    pub(super) async fn download_chunks(
        &self,
        attachment_id: &str,
        manifest: &protocol::attachment_manifest::AttachmentManifest,
        file_key: &[u8],
    ) -> Result<Vec<u8>, SyncError> {
        let partial = self.partial_dir(attachment_id);
        std::fs::create_dir_all(&partial).map_err(storage_error)?;

        let mut decoded: Vec<(u32, Vec<u8>)> = Vec::with_capacity(manifest.chunks.len());
        let mut missing = Vec::new();
        for chunk in &manifest.chunks {
            match std::fs::read(partial.join(chunk.index.to_string())) {
                Ok(bytes)
                    if bytes.len() as u64 == chunk.size
                        && protocol_attachments::hex_sha256(&bytes) == chunk.hash =>
                {
                    decoded.push((chunk.index, bytes));
                }
                _ => missing.push(chunk),
            }
        }

        let hashes: Vec<String> = missing
            .iter()
            .map(|chunk| chunk.encrypted_hash.clone())
            .collect();
        let presigned = if hashes.is_empty() {
            None
        } else {
            protocol_attachments::presign_all(&self.session.http(), &self.vault_id, &hashes)
                .await
                .map_err(attachment_error)?
        };

        for chunk in missing {
            let framed = match presigned
                .as_ref()
                .and_then(|batch| batch.urls.get(&chunk.encrypted_hash))
            {
                // A presigned GET goes straight to R2 and carries no session
                // header, so it is an absolute-url fetch rather than an API call.
                Some(url) => protocol_attachments::fetch_chunk_presigned(&self.session.http(), url)
                    .await
                    .map_err(attachment_error)?,
                None => protocol_attachments::fetch_chunk_proxied(
                    &self.session.http(),
                    &self.vault_id,
                    &chunk.encrypted_hash,
                )
                .await
                .map_err(attachment_error)?,
            };
            let plaintext = protocol_attachments::decode_chunk(
                &framed,
                file_key,
                chunk.index,
                &chunk.hash,
                chunk.size,
            )
            .map_err(attachment_error)?;
            std::fs::write(partial.join(chunk.index.to_string()), &plaintext)
                .map_err(storage_error)?;
            decoded.push((chunk.index, plaintext));
        }

        protocol_attachments::assemble(manifest, decoded).map_err(attachment_error)
    }

    /// Where one attachment's landed chunks wait for the rest.
    pub(super) fn partial_dir(&self, attachment_id: &str) -> PathBuf {
        PathBuf::from(&self.directory)
            .join("images")
            .join(".partial")
            .join(attachment_id)
    }

    /// Writes the bytes under `images/` and returns the path the row records.
    ///
    /// Relative, because the sandbox container moves between launches on iOS
    /// and an absolute path stored today is a dangling path tomorrow. Written
    /// via a sibling temp file, flushed to disk before the rename, so neither
    /// a reader nor a crash leaves half a file under the attachment's name.
    pub(super) fn write_bytes(
        &self,
        attachment_id: &str,
        bytes: &[u8],
    ) -> Result<String, SyncError> {
        let images = PathBuf::from(&self.directory).join("images");
        std::fs::create_dir_all(&images).map_err(storage_error)?;
        let partial = images.join(format!(".{attachment_id}.part"));
        let written = std::fs::File::create(&partial)
            .and_then(|mut file| {
                file.write_all(bytes)?;
                file.sync_all()
            })
            .and_then(|()| std::fs::rename(&partial, images.join(attachment_id)));
        if written.is_err() {
            let _ = std::fs::remove_file(&partial);
        }
        written.map_err(storage_error)?;
        Ok(attachment_id.to_owned())
    }
}

pub(super) fn storage_error(error: std::io::Error) -> SyncError {
    SyncError::Storage {
        source: StorageError::Failed {
            what: error.to_string(),
        },
    }
}

/// The device directory as a signer resolver.
///
/// `None` for a device the directory does not hold, which §14.4.1 turns into a
/// hard failure — unlike a record, where chapter 01 §1.4.0 leaves the item
/// unverified and refetches.
pub(super) struct DirectorySigners(pub(super) account::DeviceDirectory);

impl protocol_attachments::SignerResolver for DirectorySigners {
    fn public_key(&self, device_id: &str) -> Option<Vec<u8>> {
        self.0.signing_key(device_id).map(<[u8]>::to_vec)
    }
}

/// Maps the protocol tier's failure onto the exported one.
///
/// The two integrity outcomes stay apart: a manifest that would not verify is
/// `AttachmentUnverified` and carries no retry, and bytes that failed their
/// hash are `AttachmentCorrupt` and may be retried.
pub(super) fn attachment_error(error: protocol_attachments::AttachmentError) -> SyncError {
    use protocol_attachments::AttachmentError as E;
    match error {
        E::Api(source) => SyncError::Api { source },
        E::UnresolvableSigner { device_id } => SyncError::AttachmentUnverified { device_id },
        E::Manifest(protocol::attachment_manifest::ManifestError::BadSignature {
            signer_device_id,
        }) => SyncError::AttachmentUnverified {
            device_id: signer_device_id,
        },
        other => SyncError::AttachmentCorrupt {
            what: other.to_string(),
        },
    }
}
