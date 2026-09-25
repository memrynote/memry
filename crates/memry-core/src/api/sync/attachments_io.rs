//! Attachment upload, dereference and the byte transfer behind them (N209-N212).
//!
//! Split from `sync.rs` along the seam the `impl` blocks already drew.

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
        let device_id = self.session.device_id()?;
        let master_key = Zeroizing::new(self.session.master_key()?.ok_or(SyncError::Locked)?);
        let vault_key = Zeroizing::new(keys::derive_vault_key(&master_key)?.to_vec());
        let signing_key = self.session.signing_secret_key()?;

        // One file key for every chunk, because the manifest wraps exactly one
        // (§14.2). Fresh per attachment, never reused.
        let file_key = Zeroizing::new(sodium::random_bytes(32));
        // 128 bits of libsodium randomness, hex — the same shape a note id
        // takes, and for the same reason: the id becomes a path parameter on
        // `/sync/attachments/:attachment_id/manifest`.
        let attachment_id = hex_id();

        let chunks = attachment_upload::frame_chunks(
            &bytes,
            &file_key,
            attachment_upload::DEFAULT_CHUNK_SIZE,
            |_| sodium::random_bytes(24),
        )
        .map_err(attachment_error)?;

        let session = attachment_upload::initiate(
            &self.session.http(),
            &attachment_id,
            &filename,
            bytes.len() as u64,
            &chunks,
        )
        .await
        .map_err(attachment_error)?;

        // A failure part way leaves a session the server will expire on its
        // own; cancelling is the tidy path and is not load-bearing.
        let direct = match self.put_all(&session, &chunks).await {
            Ok(direct) => direct,
            Err(error) => {
                let _ = attachment_upload::cancel(&self.session.http(), &session.session_id).await;
                return Err(error);
            }
        };

        attachment_upload::complete(&self.session.http(), &session.session_id, &direct)
            .await
            .map_err(attachment_error)?;

        let manifest = attachment_upload::build_manifest(
            &attachment_id,
            &filename,
            &mime_type,
            &bytes,
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
        attachment_upload::put_manifest(&self.session.http(), &attachment_id, &envelope)
            .await
            .map_err(attachment_error)?;

        // Local cache first, then the reference: the row is what a placeholder
        // reads, and the push is what tells every other device.
        let manifest_json =
            protocol::attachment_manifest::manifest_json(&manifest).map_err(|error| {
                SyncError::AttachmentCorrupt {
                    what: error.to_string(),
                }
            })?;
        let manifest_text = String::from_utf8_lossy(&manifest_json).into_owned();
        let remote_size = attachment_upload::encrypted_size(&chunks) as i64;
        let local_path = self.write_bytes(&attachment_id, &bytes)?;

        let id = attachment_id.clone();
        let note = note_id.clone();
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
                attachments::record_download(conn, &id, &local_path, now)?;
                notes::add_attachment_reference(conn, &note, &id, &device_id, now)?;
                Ok(())
            })
            .await?;

        Ok(attachment_id)
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
            attachment_upload::dereference(&self.session.http(), &hashes)
                .await
                .map_err(attachment_error)?;
        }
        Ok(())
    }
}

impl VaultSync {
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
            attachment_upload::put_chunk(&self.session.http(), &session.session_id, chunk)
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
    pub(super) async fn download_chunks(
        &self,
        manifest: &protocol::attachment_manifest::AttachmentManifest,
        file_key: &[u8],
    ) -> Result<Vec<u8>, SyncError> {
        let hashes: Vec<String> = manifest
            .chunks
            .iter()
            .map(|chunk| chunk.encrypted_hash.clone())
            .collect();
        let presigned = protocol_attachments::presign_all(&self.session.http(), &hashes)
            .await
            .map_err(attachment_error)?;

        let mut decoded: Vec<(u32, Vec<u8>)> = Vec::with_capacity(manifest.chunks.len());
        for chunk in &manifest.chunks {
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
            decoded.push((chunk.index, plaintext));
        }

        protocol_attachments::assemble(manifest, decoded).map_err(attachment_error)
    }

    /// Writes the bytes under `images/` and returns the path the row records.
    ///
    /// Relative, because the sandbox container moves between launches on iOS
    /// and an absolute path stored today is a dangling path tomorrow.
    pub(super) fn write_bytes(
        &self,
        attachment_id: &str,
        bytes: &[u8],
    ) -> Result<String, SyncError> {
        let images = PathBuf::from(&self.directory).join("images");
        std::fs::create_dir_all(&images).map_err(|error| SyncError::Storage {
            source: StorageError::Failed {
                what: error.to_string(),
            },
        })?;
        std::fs::write(images.join(attachment_id), bytes).map_err(|error| SyncError::Storage {
            source: StorageError::Failed {
                what: error.to_string(),
            },
        })?;
        Ok(attachment_id.to_owned())
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
