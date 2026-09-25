//! Uploading an attachment, chapter 14 §14.2, §14.5, §14.8 (N209–N212).
//!
//! The mirror of [`super::attachments`]: plaintext in, a signed manifest and a
//! set of content-addressed chunks out.
//!
//! ## What the chapter pins, and what it deliberately does not
//!
//! **Framing is normative**: every chunk on the wire is `nonce(24) ‖
//! ciphertext`, and **all chunks share one file key**, wrapped once in the
//! manifest (§14.2). A writer that drew a key per chunk would produce a file
//! no reader can open, because the manifest carries exactly one wrapped key.
//!
//! **The chunk size is not.** `CHUNK_SIZE = 8 MiB` is a desktop constant that
//! does not appear in `packages/contracts`, and §14.9 says a future writer MAY
//! choose another. [`DEFAULT_CHUNK_SIZE`] is therefore this port's choice
//! rather than the protocol's, matched to desktop so the two produce
//! comparable files, and it is carried per file in the manifest.
//!
//! **The cap is normative**: at most 128 chunks per session
//! (`blob-api.ts:17`), so the effective ceiling is 1 GiB before plan limits.
//!
//! **Quota is reserved against ciphertext** (§14.8). `encryptedSize` is sent
//! explicitly rather than left for the server to derive, because a client that
//! sizes its own plan check against `manifest.size` under-counts by a nonce
//! and a tag per chunk and tells the user a file will fit when it will not.
//!
//! ## Addressing
//!
//! A chunk's identity is the SHA-256 of its **framed ciphertext** — of
//! `nonce ‖ ciphertext`, not of the plaintext (§14.3). The plaintext hash is a
//! separate value the reader checks after decrypt, and both travel in the
//! manifest. Getting these two the wrong way round produces a file that
//! uploads cleanly and fails every reader's integrity check.

use crate::protocol::attachment_manifest::{AttachmentChunkRef, AttachmentManifest};
use crate::protocol::attachments::{AttachmentError, hex_sha256};
use crate::protocol::http::{ApiRequest, Auth, HttpClient, RetryPolicy};

/// This port's chunk size, and **not** a contract constant (§14.9).
///
/// Matched to desktop's so the two produce comparable files. The manifest
/// carries it per file, and a reader sizes chunks from `chunks[j].size`.
pub const DEFAULT_CHUNK_SIZE: usize = 8 * 1024 * 1024;

/// At most this many chunks per upload session (§14.2, `blob-api.ts:17`).
pub const MAX_CHUNKS_PER_SESSION: usize = 128;

/// `dereference` takes at most this many hashes (§14.6).
pub const DEREFERENCE_CAP: usize = 4096;

/// The AEAD nonce every chunk is framed with.
const CHUNK_NONCE_LEN: usize = 24;
/// The AEAD tag every chunk carries.
const CHUNK_TAG_LEN: usize = 16;

/// One chunk, framed and addressed, ready to put.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FramedChunk {
    pub index: u32,
    /// `nonce ‖ ciphertext`, which is what goes on the wire.
    pub framed: Vec<u8>,
    /// The manifest entry describing it.
    pub reference: AttachmentChunkRef,
}

/// Splits and encrypts a file into framed chunks (§14.2).
///
/// `nonce_for` supplies each chunk's 24-byte nonce. Injected rather than drawn
/// here for the reason every vector generator injects its entropy: a random
/// value cannot be reproduced, and a writer whose output cannot be pinned is a
/// writer nothing holds to the other port.
///
/// **One file key for every chunk.** The manifest wraps exactly one, so a key
/// per chunk would produce a file no reader can open.
pub fn frame_chunks(
    plaintext: &[u8],
    file_key: &[u8],
    chunk_size: usize,
    mut nonce_for: impl FnMut(u32) -> Vec<u8>,
) -> Result<Vec<FramedChunk>, AttachmentError> {
    let chunk_size = chunk_size.max(1);
    // An empty file is one empty chunk rather than none: a manifest with no
    // chunks has nothing to address, and a reader assembling zero chunks
    // cannot tell it from a file that failed to upload.
    let slices: Vec<&[u8]> = if plaintext.is_empty() {
        vec![&[]]
    } else {
        plaintext.chunks(chunk_size).collect()
    };

    if slices.len() > MAX_CHUNKS_PER_SESSION {
        return Err(AttachmentError::TooManyChunks {
            chunks: slices.len(),
            cap: MAX_CHUNKS_PER_SESSION,
        });
    }

    let mut out = Vec::with_capacity(slices.len());
    for (index, slice) in slices.into_iter().enumerate() {
        let index = index as u32;
        let nonce = nonce_for(index);
        let ciphertext = crate::crypto::sodium::aead_encrypt(slice, None, &nonce, file_key)
            .map_err(|_| AttachmentError::Undecryptable)?;

        let mut framed = nonce;
        framed.extend_from_slice(&ciphertext);

        out.push(FramedChunk {
            index,
            reference: AttachmentChunkRef {
                index,
                // The PLAINTEXT hash: the reader's integrity check after
                // decrypt (§14.3).
                hash: hex_sha256(slice),
                // The FRAMED CIPHERTEXT hash: how R2 addresses it. Swapping
                // these two produces a file that uploads cleanly and fails
                // every reader.
                encrypted_hash: hex_sha256(&framed),
                size: slice.len() as u64,
            },
            framed,
        });
    }
    Ok(out)
}

/// The manifest describing a framed file (§14.4).
pub fn build_manifest(
    attachment_id: &str,
    filename: &str,
    mime_type: &str,
    plaintext: &[u8],
    chunks: &[FramedChunk],
    chunk_size: usize,
    created_at: i64,
) -> AttachmentManifest {
    AttachmentManifest {
        id: attachment_id.to_owned(),
        filename: filename.to_owned(),
        mime_type: mime_type.to_owned(),
        size: plaintext.len() as u64,
        checksum: hex_sha256(plaintext),
        chunks: chunks.iter().map(|chunk| chunk.reference.clone()).collect(),
        chunk_size: chunk_size as u64,
        created_at,
    }
}

/// Ciphertext bytes this upload puts on the wire, which is what quota is
/// reserved against (§14.8).
///
/// Computed from the frames rather than from `manifest.size`, because the
/// difference is exactly the per-chunk nonce and tag that a plaintext figure
/// leaves out.
pub fn encrypted_size(chunks: &[FramedChunk]) -> u64 {
    chunks.iter().map(|chunk| chunk.framed.len() as u64).sum()
}

/// The same figure before framing, for a caller checking a plan limit ahead of
/// encrypting.
pub fn encrypted_size_of(plaintext_len: usize, chunk_size: usize) -> u64 {
    let chunk_size = chunk_size.max(1);
    let count = if plaintext_len == 0 {
        1
    } else {
        plaintext_len.div_ceil(chunk_size)
    };
    (plaintext_len + count * (CHUNK_NONCE_LEN + CHUNK_TAG_LEN)) as u64
}

/// An open upload session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadSession {
    pub session_id: String,
    pub expires_at: i64,
    /// chunk hash to presigned PUT url, when the deployment presigns.
    pub chunk_urls: std::collections::HashMap<String, String>,
}

/// Where a session has got to, for a resume.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadStatus {
    pub session_id: String,
    pub attachment_id: String,
    pub chunk_count: u32,
    /// Indices already on the server.
    pub uploaded_chunks: Vec<u32>,
    pub expires_at: i64,
}

/// Opens an upload session (§14.5).
///
/// The chunk hashes go up front because the client finishes encrypting
/// **before** initiating, so it knows them; a deployment that presigns answers
/// with one PUT url per chunk and the bytes go direct to R2.
pub async fn initiate(
    client: &HttpClient,
    attachment_id: &str,
    filename: &str,
    plaintext_len: u64,
    chunks: &[FramedChunk],
) -> Result<UploadSession, AttachmentError> {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Body<'a> {
        attachment_id: &'a str,
        filename: &'a str,
        total_size: u64,
        chunk_count: usize,
        /// Sent explicitly rather than left to the server's derivation, so the
        /// figure quota is reserved against is the one this client computed
        /// (§14.8).
        encrypted_size: u64,
        chunk_hashes: Vec<String>,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Wire {
        session_id: String,
        expires_at: i64,
        chunk_urls: Option<std::collections::HashMap<String, String>>,
    }

    let wire: Wire = client
        .send_json(
            ApiRequest::post("/sync/attachments/upload/initiate")
                .auth(Auth::Session)
                .json(&Body {
                    attachment_id,
                    filename,
                    total_size: plaintext_len.max(1),
                    chunk_count: chunks.len(),
                    encrypted_size: encrypted_size(chunks),
                    chunk_hashes: chunks
                        .iter()
                        .map(|chunk| chunk.reference.encrypted_hash.clone())
                        .collect(),
                })
                .retry(RetryPolicy::polled()),
        )
        .await?;

    Ok(UploadSession {
        session_id: wire.session_id,
        expires_at: wire.expires_at,
        chunk_urls: wire.chunk_urls.unwrap_or_default(),
    })
}

/// Puts one chunk through the Worker.
pub async fn put_chunk(
    client: &HttpClient,
    session_id: &str,
    chunk: &FramedChunk,
) -> Result<(), AttachmentError> {
    client
        .send(
            ApiRequest::new(
                "PUT",
                &format!(
                    "/sync/attachments/upload/{session_id}/chunk/{}",
                    chunk.index
                ),
            )
            .body(chunk.framed.clone())
            .auth(Auth::Session)
            .retry(RetryPolicy::polled()),
        )
        .await?;
    Ok(())
}

/// Puts one chunk straight to R2.
///
/// Unauthenticated and unretried, for the same reasons the presigned GET is:
/// the url is the authorisation and R2 is not our server, and a failure may
/// mean the signature went stale rather than that the put is impossible.
pub async fn put_chunk_presigned(
    client: &HttpClient,
    url: &str,
    chunk: &FramedChunk,
) -> Result<(), AttachmentError> {
    client
        .send(
            ApiRequest::new("PUT", url)
                .body(chunk.framed.clone())
                .auth(Auth::None)
                .retry(RetryPolicy::never()),
        )
        .await?;
    Ok(())
}

/// A chunk that went straight to R2, as `complete` reports it (`i`, `h`, `b`).
///
/// Such a chunk never passed the Worker, so the session does not know it
/// arrived; the server head-checks each one against R2 before counting it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DirectChunk {
    pub i: u32,
    pub h: String,
    pub b: u64,
}

impl DirectChunk {
    pub fn of(chunk: &FramedChunk) -> Self {
        Self {
            i: chunk.index,
            h: chunk.reference.encrypted_hash.clone(),
            b: chunk.framed.len() as u64,
        }
    }
}

/// Closes a session. `direct` names the chunks PUT to presigned urls; the key
/// is left out when there are none, which is the body an older server knows.
pub async fn complete(
    client: &HttpClient,
    session_id: &str,
    direct: &[DirectChunk],
) -> Result<(), AttachmentError> {
    let body = if direct.is_empty() {
        serde_json::json!({ "sessionId": session_id })
    } else {
        serde_json::json!({ "sessionId": session_id, "directChunks": direct })
    };
    client
        .send(
            ApiRequest::post(&format!("/sync/attachments/upload/{session_id}/complete"))
                .auth(Auth::Session)
                .json(&body)
                .retry(RetryPolicy::polled()),
        )
        .await?;
    Ok(())
}

/// Where a session got to, so an interrupted upload resumes rather than
/// restarting (§14.5).
pub async fn status(
    client: &HttpClient,
    session_id: &str,
) -> Result<UploadStatus, AttachmentError> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Wire {
        session_id: String,
        attachment_id: String,
        chunk_count: u32,
        uploaded_chunks: Vec<u32>,
        expires_at: i64,
    }
    let wire: Wire = client
        .send_json(
            ApiRequest::get(&format!("/sync/attachments/upload/{session_id}"))
                .auth(Auth::Session)
                .retry(RetryPolicy::polled()),
        )
        .await?;
    Ok(UploadStatus {
        session_id: wire.session_id,
        attachment_id: wire.attachment_id,
        chunk_count: wire.chunk_count,
        uploaded_chunks: wire.uploaded_chunks,
        expires_at: wire.expires_at,
    })
}

/// Abandons a session.
pub async fn cancel(client: &HttpClient, session_id: &str) -> Result<(), AttachmentError> {
    client
        .send(
            ApiRequest::new("DELETE", &format!("/sync/attachments/upload/{session_id}"))
                .auth(Auth::Session)
                .retry(RetryPolicy::never()),
        )
        .await?;
    Ok(())
}

/// Stores the signed manifest.
pub async fn put_manifest(
    client: &HttpClient,
    attachment_id: &str,
    envelope: &crate::protocol::attachment_manifest::EncryptedAttachmentManifest,
) -> Result<(), AttachmentError> {
    let body = serde_json::json!({
        "encryptedManifest": envelope.encrypted_manifest,
        "manifestNonce": envelope.manifest_nonce,
        "encryptedFileKey": envelope.encrypted_file_key,
        "keyNonce": envelope.key_nonce,
        "manifestSignature": envelope.manifest_signature,
        "signerDeviceId": envelope.signer_device_id,
    });
    client
        .send(
            ApiRequest::new(
                "PUT",
                &format!("/sync/attachments/{attachment_id}/manifest"),
            )
            .json(&body)
            .auth(Auth::Session)
            .retry(RetryPolicy::polled()),
        )
        .await?;
    Ok(())
}

/// Tells the server a set of chunks is no longer referenced (§14.8).
///
/// **Not optional for this build.** §14.8: "a client that later gains the
/// ability to delete an attachment MUST dereference", and gaining that ability
/// is exactly what Phase C did. A client that deletes without dereferencing
/// leaks the user's own quota, silently and permanently.
///
/// Split at the 4096 cap. The route is rate limited to 20 requests per 60 s,
/// so a caller with more than 81,920 hashes must pace itself; that is the
/// caller's job because only it knows whether the work is interactive.
pub async fn dereference(
    client: &HttpClient,
    chunk_hashes: &[String],
) -> Result<(), AttachmentError> {
    for window in chunk_hashes.chunks(DEREFERENCE_CAP) {
        client
            .send(
                ApiRequest::post("/sync/attachments/dereference")
                    .auth(Auth::Session)
                    .json(&serde_json::json!({ "chunkHashes": window }))
                    .retry(RetryPolicy::polled()),
            )
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE_KEY: [u8; 32] = [7u8; 32];

    fn nonces(index: u32) -> Vec<u8> {
        vec![index as u8; CHUNK_NONCE_LEN]
    }

    #[test]
    fn a_file_frames_into_chunks_with_a_short_final_one() {
        let plaintext: Vec<u8> = (0..10u8).collect();
        let chunks = frame_chunks(&plaintext, &FILE_KEY, 4, nonces).expect("frame");

        assert_eq!(chunks.len(), 3, "4 + 4 + 2");
        assert_eq!(chunks[0].reference.size, 4);
        assert_eq!(chunks[2].reference.size, 2, "the final chunk is short");
        for chunk in &chunks {
            assert_eq!(
                chunk.framed.len(),
                CHUNK_NONCE_LEN + chunk.reference.size as usize + CHUNK_TAG_LEN,
                "every chunk is nonce || ciphertext"
            );
        }
    }

    /// §14.3. The two hashes are different values over different bytes, and
    /// swapping them produces a file that uploads cleanly and fails every
    /// reader's integrity check.
    #[test]
    fn a_chunk_is_addressed_by_its_ciphertext_and_checked_by_its_plaintext() {
        let plaintext = b"hello";
        let chunks = frame_chunks(plaintext, &FILE_KEY, 8, nonces).expect("frame");
        let reference = &chunks[0].reference;

        assert_eq!(reference.hash, hex_sha256(plaintext), "the plaintext hash");
        assert_eq!(
            reference.encrypted_hash,
            hex_sha256(&chunks[0].framed),
            "the framed-ciphertext hash"
        );
        assert_ne!(reference.hash, reference.encrypted_hash);
    }

    /// The reader in `protocol::attachments` must open what this writes. Held
    /// together here rather than trusted, because the two halves are the one
    /// place a framing mistake stays invisible.
    #[test]
    fn what_this_writes_the_reader_reads() {
        let plaintext: Vec<u8> = (0..100u8).collect();
        let chunks = frame_chunks(&plaintext, &FILE_KEY, 32, nonces).expect("frame");
        let manifest = build_manifest(
            "att-1",
            "f.bin",
            "application/octet-stream",
            &plaintext,
            &chunks,
            32,
            0,
        );

        let decoded: Vec<(u32, Vec<u8>)> = chunks
            .iter()
            .map(|chunk| {
                let bytes = crate::protocol::attachments::decode_chunk(
                    &chunk.framed,
                    &FILE_KEY,
                    chunk.index,
                    &chunk.reference.hash,
                    chunk.reference.size,
                )
                .expect("decode");
                (chunk.index, bytes)
            })
            .collect();

        let assembled =
            crate::protocol::attachments::assemble(&manifest, decoded).expect("assemble");
        assert_eq!(assembled, plaintext);
    }

    /// An empty file is one empty chunk, not zero. A manifest with no chunks
    /// has nothing to address, and a reader assembling none cannot tell it
    /// from a file that failed to upload.
    #[test]
    fn an_empty_file_is_one_empty_chunk() {
        let chunks = frame_chunks(&[], &FILE_KEY, DEFAULT_CHUNK_SIZE, nonces).expect("frame");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].reference.size, 0);
    }

    /// §14.2's cap, refused before a byte goes on the wire rather than by the
    /// server after 128 puts.
    #[test]
    fn a_file_past_the_chunk_cap_is_refused_locally() {
        let plaintext = vec![0u8; MAX_CHUNKS_PER_SESSION + 1];
        let error = frame_chunks(&plaintext, &FILE_KEY, 1, nonces).expect_err("must refuse");
        assert!(matches!(
            error,
            AttachmentError::TooManyChunks { cap: 128, .. }
        ));
    }

    /// §14.8: quota is reserved against ciphertext. The gap is exactly the
    /// per-chunk nonce and tag, which is what a `manifest.size` figure leaves
    /// out.
    #[test]
    fn the_quota_figure_is_ciphertext_and_not_plaintext() {
        let plaintext = vec![0u8; 10];
        let chunks = frame_chunks(&plaintext, &FILE_KEY, 4, nonces).expect("frame");

        let measured = encrypted_size(&chunks);
        assert_eq!(measured, 10 + 3 * (CHUNK_NONCE_LEN + CHUNK_TAG_LEN) as u64);
        assert!(measured > plaintext.len() as u64);
        // The ahead-of-time estimate agrees with the measured frames, or a
        // plan check would pass a file the upload then exceeds.
        assert_eq!(encrypted_size_of(plaintext.len(), 4), measured);
    }

    #[test]
    fn the_estimate_agrees_with_the_frames_for_an_empty_file() {
        let chunks = frame_chunks(&[], &FILE_KEY, 4, nonces).expect("frame");
        assert_eq!(encrypted_size_of(0, 4), encrypted_size(&chunks));
    }

    /// The caps are the contract's, stated so a change is a failing test
    /// rather than an over-long request the server rejects.
    #[test]
    fn the_caps_are_the_contract_caps() {
        assert_eq!(MAX_CHUNKS_PER_SESSION, 128);
        assert_eq!(DEREFERENCE_CAP, 4096);
        // Not a contract constant (§14.9), but matched to desktop's so the two
        // ports produce comparable files.
        assert_eq!(DEFAULT_CHUNK_SIZE, 8 * 1024 * 1024);
    }
}
