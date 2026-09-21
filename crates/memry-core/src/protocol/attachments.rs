//! Downloading an attachment, chapter 14 §14.4–§14.9 (N200, N201, N202).
//!
//! The resolution chain §14.7 spells out, in order:
//!
//! ```text
//! note.attachmentReferences[i]                    -> an attachment id
//! GET /sync/attachments/<id>/manifest             -> the encrypted manifest
//! verify signature, unwrap file key, decrypt      -> the manifest
//! manifest.chunks[j].encryptedHash                -> the R2 chunk address
//! presign-batch or GET /attachments/chunks/<hash> -> nonce ‖ ciphertext
//! strip 24-byte nonce, AEAD decrypt under the file key
//! verify manifest.chunks[j].hash over the plaintext
//! concatenate in index order, verify manifest.checksum
//! ```
//!
//! **Three rules here are the ones a reader gets wrong, so each is enforced
//! rather than described.**
//!
//! The signature is verified **before** the file key is unwrapped and the body
//! decrypted (§14.4.1). That order lives in
//! [`super::attachment_manifest::decrypt`] and this module cannot reach past
//! it, which is why the manifest fetch has no decrypt of its own.
//!
//! An **unresolvable signer device is a hard failure, not a fallback**
//! (§14.4.1). [`SignerResolver`] answers `None` for a device this vault cannot
//! place, and [`fetch_manifest`] turns that into an error rather than skipping
//! the check. A manifest is the only thing that names a file, so "I could not
//! check who signed this" and "this is fine" must never be the same branch.
//!
//! **A chunk's length comes from `chunks[j].size`, never from `chunkSize`**
//! (§14.9). `CHUNK_SIZE` is a desktop constant that does not appear in
//! `packages/contracts`, and a writer may choose another; the committed
//! `attachment-manifest` class carries one that chose 2 bytes precisely so a
//! port that hardcoded 8 MiB fails here rather than truncating a download.

use std::collections::HashMap;

use sha2::{Digest as _, Sha256};

use super::attachment_manifest::{AttachmentManifest, EncryptedAttachmentManifest, ManifestError};
use super::http::{ApiRequest, Auth, HttpClient, RetryPolicy};
use crate::api::errors::ApiError;
use crate::crypto::sodium;

/// The AEAD nonce every chunk is framed with (§14.2).
const CHUNK_NONCE_LEN: usize = 24;

/// `presign-batch` takes at most this many hashes in one call (§14.6).
pub const PRESIGN_BATCH_CAP: usize = 1024;

/// The typed, permanent signal that this deployment has no presign secrets.
const PRESIGN_UNAVAILABLE: &str = "STORAGE_PRESIGN_UNAVAILABLE";

/// What went wrong downloading an attachment.
#[derive(Debug, thiserror::Error)]
pub enum AttachmentError {
    #[error(transparent)]
    Api(#[from] ApiError),
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    /// The device that signed the manifest is not one this vault can place.
    ///
    /// **A hard failure, never a fallback** (§14.4.1). Its own variant so a
    /// caller cannot accidentally treat it as a transport hiccup and retry.
    #[error("the manifest signer {device_id} could not be resolved")]
    UnresolvableSigner { device_id: String },
    /// A chunk arrived shorter than its nonce.
    #[error("chunk {hash} is {len} bytes, too short to carry a {CHUNK_NONCE_LEN}-byte nonce")]
    ChunkTooShort { hash: String, len: usize },
    /// A chunk decrypted, and was not the chunk the manifest named.
    ///
    /// The ciphertext hash proves the server returned the bytes it was asked
    /// for; only this proves they decrypt to the right content (§14.3).
    #[error("chunk {index} failed its plaintext hash check")]
    ChunkHashMismatch { index: u32 },
    /// A chunk's decrypted length disagreed with the manifest.
    #[error("chunk {index} decrypted to {actual} bytes, the manifest says {expected}")]
    ChunkSizeMismatch {
        index: u32,
        expected: u64,
        actual: u64,
    },
    /// The assembled file failed its whole-file checksum.
    #[error("the assembled file failed its checksum")]
    ChecksumMismatch,
    /// A chunk the manifest names never arrived.
    #[error("chunk {hash} was not returned")]
    MissingChunk { hash: String },
    #[error("a chunk could not be decrypted")]
    Undecryptable,
}

/// Maps a signer device id to its Ed25519 public key.
///
/// A trait rather than a closure so the caller's device store stays behind a
/// seam, and so `None` is an explicit answer: "this vault does not know that
/// device", which §14.4.1 makes fatal.
pub trait SignerResolver: Send + Sync {
    fn public_key(&self, device_id: &str) -> Option<Vec<u8>>;
}

/// Which transfer path this deployment supports (§14.6).
///
/// Held by the caller across calls, because `Unavailable` is **permanent for
/// that deployment**: §14.6 forbids retrying the presign route on a timer, and
/// a value that is recomputed per download is a timer with extra steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferPath {
    /// Not yet determined. The next download tries presign once.
    Unknown,
    /// Presigned direct-to-R2 GETs work here.
    Presigned,
    /// `STORAGE_PRESIGN_UNAVAILABLE` came back. Use the proxied route and do
    /// not ask again.
    Proxied,
}

/// Presigned URLs for a batch of chunk hashes.
#[derive(Debug, Clone)]
pub struct PresignedBatch {
    /// chunk hash to presigned GET URL.
    pub urls: HashMap<String, String>,
    /// Epoch **seconds** after which every URL above stops working
    /// (§14.6). Seconds rather than millis, which is the easy mistake.
    pub expires_at: i64,
}

/// Fetches one attachment's manifest and opens it.
///
/// The signature check, the unwrap and the decrypt all happen inside
/// [`super::attachment_manifest::decrypt`], in that order, and this function
/// does not have the pieces to do them in any other.
pub async fn fetch_manifest(
    client: &HttpClient,
    attachment_id: &str,
    vault_key: &[u8],
    signers: &dyn SignerResolver,
) -> Result<(AttachmentManifest, Vec<u8>), AttachmentError> {
    let envelope: EncryptedAttachmentManifest =
        fetch_manifest_envelope(client, attachment_id).await?;

    // Resolved BEFORE the decrypt is attempted, so an unknown device is
    // refused rather than becoming a decrypt that happened to work.
    let signer_public_key = signers
        .public_key(&envelope.signer_device_id)
        .ok_or_else(|| AttachmentError::UnresolvableSigner {
            device_id: envelope.signer_device_id.clone(),
        })?;

    let (manifest, file_key) =
        super::attachment_manifest::decrypt(&envelope, vault_key, &signer_public_key)?;
    Ok((manifest, file_key.to_vec()))
}

/// The raw envelope, as the route returns it.
async fn fetch_manifest_envelope(
    client: &HttpClient,
    attachment_id: &str,
) -> Result<EncryptedAttachmentManifest, AttachmentError> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Wire {
        encrypted_manifest: String,
        manifest_nonce: String,
        encrypted_file_key: String,
        key_nonce: String,
        manifest_signature: String,
        signer_device_id: String,
    }

    let wire: Wire = client
        .send_json(
            ApiRequest::get(&format!("/sync/attachments/{attachment_id}/manifest"))
                .retry(RetryPolicy::polled()),
        )
        .await?;

    Ok(EncryptedAttachmentManifest {
        encrypted_manifest: wire.encrypted_manifest,
        manifest_nonce: wire.manifest_nonce,
        encrypted_file_key: wire.encrypted_file_key,
        key_nonce: wire.key_nonce,
        manifest_signature: wire.manifest_signature,
        signer_device_id: wire.signer_device_id,
    })
}

/// Asks for presigned GETs, or reports that this deployment has none.
///
/// `Ok(None)` is the **permanent** answer, and the caller records it as
/// [`TransferPath::Proxied`] rather than asking again. Every other failure is
/// an ordinary error, because "the presign route is broken right now" and
/// "this deployment does not do presigning" are different facts and only the
/// second is forever.
///
/// The hash list must be within [`PRESIGN_BATCH_CAP`]; [`presign_all`] splits
/// a longer one.
pub async fn presign_batch(
    client: &HttpClient,
    chunk_hashes: &[String],
) -> Result<Option<PresignedBatch>, AttachmentError> {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Body<'a> {
        chunk_hashes: &'a [String],
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Wire {
        urls: HashMap<String, String>,
        expires_at: i64,
    }

    let request = ApiRequest::post("/sync/attachments/presign-batch")
        .json(&Body { chunk_hashes })
        .retry(RetryPolicy::polled());

    match client.send_json::<Wire>(request).await {
        Ok(wire) => Ok(Some(PresignedBatch {
            urls: wire.urls,
            expires_at: wire.expires_at,
        })),
        Err(ApiError::Status { code, .. }) if code.as_deref() == Some(PRESIGN_UNAVAILABLE) => {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

/// Presigned GETs for any number of hashes, split to respect the cap.
pub async fn presign_all(
    client: &HttpClient,
    chunk_hashes: &[String],
) -> Result<Option<PresignedBatch>, AttachmentError> {
    let mut urls: HashMap<String, String> = HashMap::new();
    // The soonest expiry across the batches, because a caller holding the set
    // has to refresh before the FIRST url dies, not the last.
    let mut expires_at = i64::MAX;

    for window in chunk_hashes.chunks(PRESIGN_BATCH_CAP) {
        match presign_batch(client, window).await? {
            Some(batch) => {
                expires_at = expires_at.min(batch.expires_at);
                urls.extend(batch.urls);
            }
            // Permanent for the deployment, so there is no point asking for
            // the remaining windows.
            None => return Ok(None),
        }
    }

    Ok(Some(PresignedBatch {
        urls,
        expires_at: if expires_at == i64::MAX {
            0
        } else {
            expires_at
        },
    }))
}

/// One chunk's framed bytes from a presigned URL (§14.6's direct path).
///
/// An **absolute** url rather than an API path, and deliberately unauthenticated:
/// the url is already the authorisation and R2 is not our server, so sending a
/// bearer token to a third-party host would leak it.
///
/// No retry either. A presigned url carries an `expiresAt`, so a failure may
/// mean the signature went stale rather than that the object is unavailable,
/// and the caller's correct move is to re-presign rather than to hammer a dead
/// signature.
pub async fn fetch_chunk_presigned(
    client: &HttpClient,
    url: &str,
) -> Result<Vec<u8>, AttachmentError> {
    let response = client
        .send(
            ApiRequest::get(url)
                .auth(Auth::None)
                .retry(RetryPolicy::never()),
        )
        .await?;
    Ok(response.body)
}

/// One chunk's framed bytes through the Worker (§14.6's proxied path).
pub async fn fetch_chunk_proxied(
    client: &HttpClient,
    chunk_hash: &str,
) -> Result<Vec<u8>, AttachmentError> {
    let response = client
        .send(
            ApiRequest::get(&format!("/sync/attachments/chunks/{chunk_hash}"))
                .retry(RetryPolicy::polled()),
        )
        .await?;
    Ok(response.body)
}

/// Decodes one framed chunk: strip the nonce, decrypt, and prove it is the
/// chunk the manifest named.
///
/// `framed` is `nonce(24) ‖ ciphertext` (§14.2). The plaintext hash check is
/// not optional: the ciphertext hash only proves the server returned the bytes
/// it was asked for (§14.3).
pub fn decode_chunk(
    framed: &[u8],
    file_key: &[u8],
    index: u32,
    expected_plaintext_hash: &str,
    expected_size: u64,
) -> Result<Vec<u8>, AttachmentError> {
    if framed.len() <= CHUNK_NONCE_LEN {
        return Err(AttachmentError::ChunkTooShort {
            hash: expected_plaintext_hash.to_owned(),
            len: framed.len(),
        });
    }
    let (nonce, ciphertext) = framed.split_at(CHUNK_NONCE_LEN);
    let plaintext = sodium::aead_decrypt(ciphertext, None, nonce, file_key)
        .map_err(|_| AttachmentError::Undecryptable)?;

    if hex_sha256(&plaintext) != expected_plaintext_hash {
        return Err(AttachmentError::ChunkHashMismatch { index });
    }
    // §14.9: the manifest's per-chunk size is what a reader sizes against.
    if plaintext.len() as u64 != expected_size {
        return Err(AttachmentError::ChunkSizeMismatch {
            index,
            expected: expected_size,
            actual: plaintext.len() as u64,
        });
    }
    Ok(plaintext.to_vec())
}

/// Concatenates decoded chunks in **index order** and verifies the whole-file
/// checksum.
///
/// Index order rather than arrival order: chunks are fetched concurrently and
/// a file assembled in the order responses landed is a file with its blocks
/// shuffled, which the checksum then catches as a corrupt download rather than
/// as the bug it is.
pub fn assemble(
    manifest: &AttachmentManifest,
    mut decoded: Vec<(u32, Vec<u8>)>,
) -> Result<Vec<u8>, AttachmentError> {
    decoded.sort_by_key(|(index, _)| *index);

    let mut file = Vec::with_capacity(manifest.size as usize);
    for chunk in &manifest.chunks {
        let bytes = decoded
            .iter()
            .find(|(index, _)| *index == chunk.index)
            .map(|(_, bytes)| bytes)
            .ok_or_else(|| AttachmentError::MissingChunk {
                hash: chunk.encrypted_hash.clone(),
            })?;
        file.extend_from_slice(bytes);
    }

    if hex_sha256(&file) != manifest.checksum {
        return Err(AttachmentError::ChecksumMismatch);
    }
    Ok(file)
}

/// Lowercase hex SHA-256, the spelling every hash in this chapter uses.
pub fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::attachment_manifest::AttachmentChunkRef;

    const FILE_KEY: [u8; 32] = [7u8; 32];

    /// Frames a chunk the way a writer does: `nonce ‖ ciphertext`.
    fn framed(plaintext: &[u8], nonce: [u8; 24]) -> Vec<u8> {
        let ciphertext = sodium::aead_encrypt(plaintext, None, &nonce, &FILE_KEY).expect("encrypt");
        let mut out = nonce.to_vec();
        out.extend_from_slice(&ciphertext);
        out
    }

    fn manifest_of(parts: &[&[u8]]) -> AttachmentManifest {
        let whole: Vec<u8> = parts.concat();
        AttachmentManifest {
            id: "att-1".to_owned(),
            filename: "f.bin".to_owned(),
            mime_type: "application/octet-stream".to_owned(),
            size: whole.len() as u64,
            checksum: hex_sha256(&whole),
            chunks: parts
                .iter()
                .enumerate()
                .map(|(index, part)| AttachmentChunkRef {
                    index: index as u32,
                    hash: hex_sha256(part),
                    encrypted_hash: format!("{index:064}"),
                    size: part.len() as u64,
                })
                .collect(),
            chunk_size: 8 * 1024 * 1024,
            created_at: 0,
        }
    }

    #[test]
    fn a_chunk_round_trips_through_the_frame() {
        let plaintext = b"the quick brown fox";
        let bytes = framed(plaintext, [1u8; 24]);
        let decoded =
            decode_chunk(&bytes, &FILE_KEY, 0, &hex_sha256(plaintext), 19).expect("decode");
        assert_eq!(decoded, plaintext);
    }

    /// §14.3: the ciphertext hash proves the server returned what it was
    /// asked for; only the plaintext hash proves it decrypts to the right
    /// content. A reader that skipped this accepts a chunk from another file
    /// that happens to decrypt under the same key.
    #[test]
    fn a_chunk_whose_plaintext_hash_disagrees_is_refused() {
        let bytes = framed(b"actually other bytes", [1u8; 24]);
        let error = decode_chunk(&bytes, &FILE_KEY, 3, &hex_sha256(b"expected"), 20)
            .expect_err("must refuse");
        assert!(matches!(
            error,
            AttachmentError::ChunkHashMismatch { index: 3 }
        ));
    }

    #[test]
    fn a_chunk_shorter_than_its_nonce_is_refused() {
        let error = decode_chunk(&[0u8; 12], &FILE_KEY, 0, "whatever", 0).expect_err("must refuse");
        assert!(matches!(
            error,
            AttachmentError::ChunkTooShort { len: 12, .. }
        ));
    }

    #[test]
    fn a_file_assembles_in_index_order_and_checks_out() {
        let parts: [&[u8]; 3] = [b"alpha", b"beta", b"gamma"];
        let manifest = manifest_of(&parts);
        // Deliberately out of order, as concurrent fetches land.
        let decoded = vec![
            (2u32, parts[2].to_vec()),
            (0u32, parts[0].to_vec()),
            (1u32, parts[1].to_vec()),
        ];
        assert_eq!(
            assemble(&manifest, decoded).expect("assemble"),
            b"alphabetagamma"
        );
    }

    /// The failure this catches is a reader that concatenated in arrival
    /// order: the bytes are all present and the file is wrong.
    #[test]
    fn a_file_assembled_from_the_wrong_bytes_fails_its_checksum() {
        let parts: [&[u8]; 2] = [b"alpha", b"beta"];
        let manifest = manifest_of(&parts);
        let decoded = vec![(0u32, b"alpha".to_vec()), (1u32, b"BETA".to_vec())];
        assert!(matches!(
            assemble(&manifest, decoded),
            Err(AttachmentError::ChecksumMismatch)
        ));
    }

    #[test]
    fn a_missing_chunk_names_itself() {
        let parts: [&[u8]; 2] = [b"alpha", b"beta"];
        let manifest = manifest_of(&parts);
        let decoded = vec![(0u32, b"alpha".to_vec())];
        assert!(matches!(
            assemble(&manifest, decoded),
            Err(AttachmentError::MissingChunk { .. })
        ));
    }

    /// §14.9 again, at the decode boundary: a writer that chose a 2-byte chunk
    /// size produces chunks a reader assuming 8 MiB would mis-size.
    #[test]
    fn a_reader_sizes_a_chunk_from_the_manifest_and_not_from_a_constant() {
        let plaintext = b"ab";
        let bytes = framed(plaintext, [1u8; 24]);
        // The right size, from the manifest.
        assert!(decode_chunk(&bytes, &FILE_KEY, 0, &hex_sha256(plaintext), 2).is_ok());
        // A reader that believed the desktop constant.
        assert!(matches!(
            decode_chunk(
                &bytes,
                &FILE_KEY,
                0,
                &hex_sha256(plaintext),
                8 * 1024 * 1024
            ),
            Err(AttachmentError::ChunkSizeMismatch { .. })
        ));
    }

    #[test]
    fn the_presign_cap_is_the_contract_cap() {
        // §14.6. Stated here so a change to the constant is a failing test
        // rather than a silently over-long request the server rejects.
        assert_eq!(PRESIGN_BATCH_CAP, 1024);
    }
}
