//! Streaming upload of one vault file (§14.2-§14.5), Electron's
//! `uploadAttachment` (`apps/desktop/src/main/sync/attachments.ts:404-640`).
//!
//! `initiate` needs every chunk's ciphertext hash before the first PUT, and
//! a desktop attachment can be 500 MiB, so the file is read twice, one chunk
//! at a time: the first pass frames it to learn the hashes and the manifest
//! figures and keeps only each chunk's nonce; the second frames it again with
//! the same key and nonces, so each chunk is the same ciphertext, and uploads
//! it. A chunk whose hash differs from the first pass means the file changed:
//! the upload stops before that chunk leaves the device, so no two different
//! plaintexts are ever sent under one nonce.
//!
//! Only `nonce ‖ ciphertext` and the encrypted, signed manifest go on the wire.
//! A crash before `complete` leaves a session the server expires and no
//! reference: the caller's queue row (`store::upload_queue`) uploads the file
//! again from the start under a new id. Nothing on disk holds a key.

use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek};
use std::sync::Arc;

use tokio::sync::mpsc;
use tokio::task::JoinSet;
use zeroize::Zeroizing;

use super::download::blocking;
use super::transfer::{AttachmentTransfer, TransferError, now_ms};
use crate::crypto::sodium;
use crate::protocol::attachment_manifest::{self, AttachmentManifest};
use crate::protocol::attachment_stream::{
    ChunkFramer, FramerSummary, build_manifest_from, complete_with_manifest,
};
use crate::protocol::attachment_upload::{
    DEFAULT_CHUNK_SIZE, DirectChunk, FramedChunk, UploadSession, cancel, initiate, put_chunk,
    put_chunk_presigned, status,
};
use crate::protocol::attachments::{AttachmentError, fetch_manifest};
use crate::protocol::http::HttpClient;

/// `MAX_ATTACHMENT_SIZE`.
pub const MAX_ATTACHMENT_SIZE: u64 = 500 * 1024 * 1024;
/// `MAX_CONCURRENT_CHUNKS`.
const MAX_CONCURRENT_CHUNKS: usize = 4;
const NONCE_LEN: usize = 24;

/// An upload that finished.
#[derive(Debug, Clone)]
pub struct Uploaded {
    pub attachment_id: String,
    /// The server already held these bytes under one of the candidate ids,
    /// so nothing was uploaded.
    pub reused: bool,
    pub manifest: AttachmentManifest,
}

impl AttachmentTransfer {
    /// Uploads `file`, which the shell opened through its vault-root check
    /// (`openUploadFile`), so it is read only through this handle.
    ///
    /// `reusable` lists attachments that may already hold these bytes
    /// (`getReusableAttachmentIds`): a candidate whose manifest has the same
    /// size and checksum is returned instead of a new id.
    pub async fn upload_file(
        &self,
        file: File,
        filename: &str,
        reusable: &[String],
    ) -> Result<Uploaded, TransferError> {
        let size = file.metadata()?.len();
        if size > MAX_ATTACHMENT_SIZE {
            return Err(TransferError::TooLarge {
                size,
                limit: MAX_ATTACHMENT_SIZE,
            });
        }
        if size == 0 {
            return Err(TransferError::EmptyFile);
        }
        let file = Arc::new(file);
        let file_key = Zeroizing::new(sodium::random_bytes(32));
        let (summary, nonces) = blocking({
            let (file, key) = (Arc::clone(&file), file_key.clone());
            move || hash_pass(&file, &key)
        })
        .await?;

        if let Some(found) = self.find_uploaded_copy(reusable, &summary).await? {
            return Ok(Uploaded {
                attachment_id: found.id.clone(),
                reused: true,
                manifest: found,
            });
        }

        let attachment_id = hex::encode(sodium::random_bytes(16));
        let session = initiate(
            &self.http,
            &self.vault_id,
            &attachment_id,
            filename,
            summary.size,
            &summary.chunks,
        )
        .await?;
        // `checkResumableSession`: fails open, a fresh session has nothing.
        let landed: HashSet<u32> = status(&self.http, &self.vault_id, &session.session_id)
            .await
            .map(|status| status.uploaded_chunks.into_iter().collect())
            .unwrap_or_default();
        let direct = match self
            .put_chunks(file, file_key.clone(), nonces, &summary, &session, landed)
            .await
        {
            Ok(direct) => direct,
            Err(error) => {
                // Frees the session's quota now rather than at its expiry; the
                // outcome changes nothing for the retry.
                let _ = cancel(&self.http, &self.vault_id, &session.session_id).await;
                return Err(error);
            }
        };

        let manifest = build_manifest_from(
            &summary,
            &attachment_id,
            filename,
            mime_type(filename),
            now_ms(),
        );
        let envelope = attachment_manifest::encrypt(
            &manifest,
            &file_key,
            &self.vault_key,
            &sodium::random_bytes(NONCE_LEN),
            &sodium::random_bytes(NONCE_LEN),
            self.signer.secret_key(),
            self.signer.device_id(),
        )
        .map_err(AttachmentError::from)?;
        complete_with_manifest(
            &self.http,
            &self.vault_id,
            &session.session_id,
            &envelope,
            &direct,
        )
        .await?;
        Ok(Uploaded {
            attachment_id,
            reused: false,
            manifest,
        })
    }

    /// `findUploadedCopy`: the first candidate holding exactly these bytes. A
    /// candidate the server no longer has, or one this device cannot verify,
    /// is no match; a transport failure fails the upload, so it is retried
    /// rather than made a second time.
    async fn find_uploaded_copy(
        &self,
        candidates: &[String],
        summary: &FramerSummary,
    ) -> Result<Option<AttachmentManifest>, TransferError> {
        for candidate in candidates {
            match fetch_manifest(
                &self.http,
                &self.vault_id,
                candidate,
                &self.vault_key,
                self.signers.as_ref(),
            )
            .await
            {
                Ok((manifest, key)) => {
                    drop(Zeroizing::new(key));
                    if manifest.size == summary.size && manifest.checksum == summary.checksum {
                        return Ok(Some(manifest));
                    }
                }
                Err(error) => {
                    let error = TransferError::from(error);
                    if error.is_resumable() {
                        return Err(error);
                    }
                }
            }
        }
        Ok(None)
    }

    /// The second pass: frames the file again and PUTs each chunk the session
    /// does not hold, four at a time, presigned first and through the Worker
    /// when that fails. Returns the chunks that went straight to R2.
    async fn put_chunks(
        &self,
        file: Arc<File>,
        file_key: Zeroizing<Vec<u8>>,
        nonces: Vec<Vec<u8>>,
        summary: &FramerSummary,
        session: &UploadSession,
        landed: HashSet<u32>,
    ) -> Result<Vec<DirectChunk>, TransferError> {
        // One framed chunk waits while four are on the wire.
        let (sender, mut receiver) = mpsc::channel(1);
        let expected = summary.clone();
        let producer = tokio::task::spawn_blocking(move || {
            reframe(&file, &file_key, nonces, &expected, &landed, &sender);
        });

        let mut puts = JoinSet::new();
        let mut direct = Vec::new();
        loop {
            while puts.len() >= MAX_CONCURRENT_CHUNKS {
                direct.extend(joined(puts.join_next().await)?);
            }
            match receiver.recv().await {
                Some(Ok(chunk)) => {
                    let chunk: FramedChunk = chunk;
                    let url = session
                        .chunk_urls
                        .get(&chunk.reference.encrypted_hash)
                        .cloned();
                    puts.spawn(put_one(
                        Arc::clone(&self.http),
                        self.vault_id.clone(),
                        session.session_id.clone(),
                        url,
                        chunk,
                    ));
                }
                Some(Err(error)) => return Err(error),
                None => break,
            }
        }
        while !puts.is_empty() {
            direct.extend(joined(puts.join_next().await)?);
        }
        // A producer that panicked closed the channel early: never a success.
        producer.await.map_err(join_failed)?;
        Ok(direct)
    }
}

/// The first pass: frames the whole file, keeps each chunk's nonce and the
/// manifest figures, and drops the frames.
fn hash_pass(file: &File, file_key: &[u8]) -> Result<(FramerSummary, Vec<Vec<u8>>), TransferError> {
    let mut reader = file;
    reader.rewind()?;
    let mut framer = ChunkFramer::new(
        reader.take(MAX_ATTACHMENT_SIZE + 1),
        file_key,
        DEFAULT_CHUNK_SIZE,
        |_| sodium::random_bytes(NONCE_LEN),
    );
    let mut nonces = Vec::new();
    while let Some(chunk) = framer.next_chunk()? {
        nonces.push(chunk.framed[..NONCE_LEN].to_vec());
    }
    let summary = framer
        .into_summary()
        .ok_or_else(|| TransferError::Io(std::io::Error::other("framing did not finish")))?;
    if summary.size > MAX_ATTACHMENT_SIZE {
        return Err(TransferError::TooLarge {
            size: summary.size,
            limit: MAX_ATTACHMENT_SIZE,
        });
    }
    if summary.size == 0 {
        return Err(TransferError::EmptyFile);
    }
    Ok((summary, nonces))
}

/// Frames the file a second time and sends each chunk the session lacks.
/// Stops at the first chunk that differs from the first pass, and when the
/// receiver is gone.
fn reframe(
    file: &File,
    file_key: &[u8],
    nonces: Vec<Vec<u8>>,
    expected: &FramerSummary,
    landed: &HashSet<u32>,
    sender: &mpsc::Sender<Result<FramedChunk, TransferError>>,
) {
    let send_err = |error: TransferError| {
        let _ = sender.blocking_send(Err(error));
    };
    let mut reader = file;
    if let Err(error) = reader.rewind() {
        return send_err(error.into());
    }
    // A chunk past the first pass's count gets a fresh nonce and then fails
    // the hash check below, so a nonce is reused only for the same bytes.
    let mut framer = ChunkFramer::new(
        reader.take(MAX_ATTACHMENT_SIZE + 1),
        file_key,
        DEFAULT_CHUNK_SIZE,
        |index| {
            nonces
                .get(index as usize)
                .cloned()
                .unwrap_or_else(|| sodium::random_bytes(NONCE_LEN))
        },
    );
    loop {
        match framer.next_chunk() {
            Ok(Some(chunk)) => {
                let first = expected.chunks.get(chunk.index as usize);
                if first.map(|r| &r.encrypted_hash) != Some(&chunk.reference.encrypted_hash) {
                    return send_err(TransferError::FileChanged);
                }
                if landed.contains(&chunk.index) {
                    continue;
                }
                if sender.blocking_send(Ok(chunk)).is_err() {
                    return;
                }
            }
            Ok(None) => break,
            Err(error) => return send_err(error.into()),
        }
    }
    let again = framer.into_summary();
    if again.as_ref() != Some(expected) {
        send_err(TransferError::FileChanged);
    }
}

/// `putChunkToPresignedUrl` once, then the Worker (`uploadChunk`).
async fn put_one(
    http: Arc<HttpClient>,
    vault_id: String,
    session_id: String,
    url: Option<String>,
    chunk: FramedChunk,
) -> Result<Option<DirectChunk>, TransferError> {
    if let Some(url) = url
        && put_chunk_presigned(&http, &url, &chunk).await.is_ok()
    {
        return Ok(Some(DirectChunk::of(&chunk)));
    }
    put_chunk(&http, &vault_id, &session_id, &chunk).await?;
    Ok(None)
}

fn joined(
    next: Option<Result<Result<Option<DirectChunk>, TransferError>, tokio::task::JoinError>>,
) -> Result<Option<DirectChunk>, TransferError> {
    match next {
        Some(result) => result.map_err(join_failed)?,
        None => Ok(None),
    }
}

fn join_failed(error: tokio::task::JoinError) -> TransferError {
    TransferError::Io(std::io::Error::other(error.to_string()))
}

/// `guessMimeType` (`attachments.ts:1558-1579`).
fn mime_type(filename: &str) -> &'static str {
    // `path.extname`: the last dot of the base name, never its first byte.
    let base = filename.rsplit(['/', '\\']).next().unwrap_or(filename);
    let extension = match base.rfind('.') {
        Some(dot) if dot > 0 => base[dot + 1..].to_ascii_lowercase(),
        _ => String::new(),
    };
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "zip" => "application/zip",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        _ => "application/octet-stream",
    }
}
