//! The attachment manifest, chapter 14 §14.4 (N205, answers Q3).
//!
//! **Why this is reimplemented rather than shared.** The task offered lifting
//! the logic somewhere both ports call. There is no such place: this core is a
//! standalone Rust port that a Swift shell links as a static library, and it
//! cannot call `packages/sync-client/src/push/attachment-manifest.ts`. §14.4.1
//! forbids the remaining option of not verifying at all, so the only real
//! choice was to reimplement carefully. `research.md` records the decision.
//!
//! It is assembly rather than cryptography — the core already owns canonical
//! CBOR, detached Ed25519, the AEAD, and even the `ATTACHMENT_MANIFEST` field
//! order. Two things carry the risk, and both are stated here because neither
//! fails loudly:
//!
//! **The verification order is normative.** §14.4.1: the signature is checked
//! **before** the file key is unwrapped and the manifest decrypted. The
//! natural way to write [`decrypt`] is to decrypt first and check afterwards,
//! which reads identically in a test that only feeds it valid input and is
//! wrong against a hostile server. The manifest is the only thing that names
//! the file — chunks in R2 are opaque ciphertext addressed by hash — so the
//! signature is what stops a server-side swap from pointing a note's picture
//! at somebody else's bytes.
//!
//! **The signature does not cover the manifest body.** It covers the four
//! envelope fields. The body crosses as `JSON.stringify(manifest)`, so a
//! writer that ordered its fields differently would produce a manifest the
//! other port still parses, and nothing would fail. That is why the field
//! order here is written out by hand in the reference writer's order rather
//! than left to a `serde` derive, and why the vector class pins the manifest
//! bytes and not only the envelope.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use ciborium::value::Value as CborValue;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::crypto::cbor::{self, field_order};
use crate::crypto::sodium;

/// One chunk of an attachment, as the manifest lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct AttachmentChunkRef {
    pub index: u32,
    /// SHA-256 of the **plaintext** chunk: the integrity check after decrypt.
    pub hash: String,
    /// SHA-256 of `nonce ‖ ciphertext`: how the chunk is addressed in R2.
    #[serde(rename = "encryptedHash")]
    pub encrypted_hash: String,
    pub size: u64,
}

/// The manifest itself (§14.4).
///
/// Field order matches the reference writer's object literal, because the
/// manifest crosses as `JSON.stringify` output and this order is what those
/// bytes are. `serde` preserves declaration order for a struct, so the two
/// ports agree as long as this list does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct AttachmentManifest {
    pub id: String,
    pub filename: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    /// Plaintext byte size. **Not** what quota is reserved against (§14.8).
    pub size: u64,
    /// SHA-256 of the whole plaintext file.
    pub checksum: String,
    pub chunks: Vec<AttachmentChunkRef>,
    /// The writer's chunk size, carried per file.
    ///
    /// **Informational only.** §14.9: a reader MUST size every chunk from
    /// `chunks[j].size` and MUST NOT assume this value. `CHUNK_SIZE` is a
    /// desktop constant, not a contract constant.
    #[serde(rename = "chunkSize")]
    pub chunk_size: u64,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

/// The signed, encrypted envelope the manifest travels in.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EncryptedAttachmentManifest {
    pub encrypted_manifest: String,
    pub manifest_nonce: String,
    pub encrypted_file_key: String,
    pub key_nonce: String,
    pub manifest_signature: String,
    pub signer_device_id: String,
}

/// What can go wrong reading a manifest.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum ManifestError {
    /// The signature did not verify.
    ///
    /// Its own variant, carrying the device, because §14.4.1 makes this the
    /// one failure that means "the server may be lying about which bytes are
    /// this note's picture" rather than "something is broken".
    #[error("manifest signature verification failed for device {signer_device_id}")]
    BadSignature { signer_device_id: String },
    /// A base64 field would not decode.
    #[error("manifest field {field} is not valid base64")]
    BadEncoding { field: String },
    /// Unwrap or decrypt failed.
    #[error("manifest could not be decrypted")]
    Undecryptable,
    /// The decrypted bytes were not the manifest.
    #[error("manifest JSON is malformed: {detail}")]
    Malformed { detail: String },
}

/// The four fields the signature covers, as canonical CBOR (§14.4.1 step 4).
fn signature_payload(
    encrypted_manifest: &str,
    manifest_nonce: &str,
    encrypted_file_key: &str,
    key_nonce: &str,
) -> Vec<u8> {
    let map: cbor::CanonicalMap = vec![
        (
            "encryptedManifest".to_owned(),
            CborValue::Text(encrypted_manifest.to_owned()),
        ),
        (
            "manifestNonce".to_owned(),
            CborValue::Text(manifest_nonce.to_owned()),
        ),
        (
            "encryptedFileKey".to_owned(),
            CborValue::Text(encrypted_file_key.to_owned()),
        ),
        ("keyNonce".to_owned(), CborValue::Text(key_nonce.to_owned())),
    ];
    // The allowlist is exactly these four keys, so the encode cannot reject a
    // key it does not know and cannot fail on size.
    cbor::encode(field_order::ATTACHMENT_MANIFEST, &map)
        .expect("the four manifest fields are the ATTACHMENT_MANIFEST allowlist")
}

/// The bytes a signature is computed over, for a caller holding an envelope.
pub fn signing_bytes(envelope: &EncryptedAttachmentManifest) -> Vec<u8> {
    signature_payload(
        &envelope.encrypted_manifest,
        &envelope.manifest_nonce,
        &envelope.encrypted_file_key,
        &envelope.key_nonce,
    )
}

/// The manifest's own JSON bytes, which are what gets encrypted.
///
/// `serde_json` writes a struct's fields in declaration order and does not
/// insert whitespace, which is what `JSON.stringify` does too.
pub fn manifest_json(manifest: &AttachmentManifest) -> Result<Vec<u8>, ManifestError> {
    serde_json::to_vec(manifest).map_err(|error| ManifestError::Malformed {
        detail: error.to_string(),
    })
}

/// Encrypts, wraps and signs a manifest (§14.4.1, in that order).
///
/// The nonces and the file key are the caller's, not drawn here: a vector
/// cannot contain a random value and also be reproducible, so entropy is
/// injected exactly as the other classes inject it.
pub fn encrypt(
    manifest: &AttachmentManifest,
    file_key: &[u8],
    vault_key: &[u8],
    manifest_nonce: &[u8],
    key_nonce: &[u8],
    signing_secret_key: &[u8],
    signer_device_id: &str,
) -> Result<EncryptedAttachmentManifest, ManifestError> {
    let body = manifest_json(manifest)?;
    // No AAD, which §14.4.1 step 2 states outright.
    let ciphertext = sodium::aead_encrypt(&body, None, manifest_nonce, file_key)
        .map_err(|_| ManifestError::Undecryptable)?;
    let wrapped_key = sodium::aead_encrypt(file_key, None, key_nonce, vault_key)
        .map_err(|_| ManifestError::Undecryptable)?;

    let encrypted_manifest = BASE64_STANDARD.encode(&ciphertext);
    let manifest_nonce_b64 = BASE64_STANDARD.encode(manifest_nonce);
    let encrypted_file_key = BASE64_STANDARD.encode(&wrapped_key);
    let key_nonce_b64 = BASE64_STANDARD.encode(key_nonce);

    let payload = signature_payload(
        &encrypted_manifest,
        &manifest_nonce_b64,
        &encrypted_file_key,
        &key_nonce_b64,
    );
    let signature = sodium::sign_detached(&payload, signing_secret_key)
        .map_err(|_| ManifestError::Undecryptable)?;

    Ok(EncryptedAttachmentManifest {
        encrypted_manifest,
        manifest_nonce: manifest_nonce_b64,
        encrypted_file_key,
        key_nonce: key_nonce_b64,
        manifest_signature: BASE64_STANDARD.encode(&signature),
        signer_device_id: signer_device_id.to_owned(),
    })
}

fn decode(field: &str, value: &str) -> Result<Vec<u8>, ManifestError> {
    BASE64_STANDARD
        .decode(value)
        .map_err(|_| ManifestError::BadEncoding {
            field: field.to_owned(),
        })
}

/// Verifies, unwraps and decrypts a manifest — **in that order** (§14.4.1).
///
/// The order is the whole point of the function. Decrypting first and checking
/// the signature afterwards behaves identically on valid input and hands a
/// hostile server a window in which this client has already acted on bytes it
/// has not authenticated.
///
/// An unresolvable signer device is a hard failure for the caller, not a
/// fallback (§14.4.1): this function takes the signer's public key and cannot
/// be called without one, which is how that rule is enforced rather than
/// documented.
pub fn decrypt(
    envelope: &EncryptedAttachmentManifest,
    vault_key: &[u8],
    signer_public_key: &[u8],
) -> Result<(AttachmentManifest, Zeroizing<Vec<u8>>), ManifestError> {
    // 1. The signature, first.
    let signature = decode("manifestSignature", &envelope.manifest_signature)?;
    if !sodium::sign_verify_detached(&signature, &signing_bytes(envelope), signer_public_key) {
        return Err(ManifestError::BadSignature {
            signer_device_id: envelope.signer_device_id.clone(),
        });
    }

    // 2. Only now the key.
    let wrapped_key = decode("encryptedFileKey", &envelope.encrypted_file_key)?;
    let key_nonce = decode("keyNonce", &envelope.key_nonce)?;
    let file_key = sodium::aead_decrypt(&wrapped_key, None, &key_nonce, vault_key)
        .map_err(|_| ManifestError::Undecryptable)?;

    // 3. And only now the body.
    let ciphertext = decode("encryptedManifest", &envelope.encrypted_manifest)?;
    let manifest_nonce = decode("manifestNonce", &envelope.manifest_nonce)?;
    let body = sodium::aead_decrypt(&ciphertext, None, &manifest_nonce, &file_key)
        .map_err(|_| ManifestError::Undecryptable)?;

    let manifest: AttachmentManifest =
        serde_json::from_slice(&body).map_err(|error| ManifestError::Malformed {
            detail: error.to_string(),
        })?;
    Ok((manifest, file_key))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> AttachmentManifest {
        AttachmentManifest {
            id: "att-1".to_owned(),
            filename: "picture.png".to_owned(),
            mime_type: "image/png".to_owned(),
            size: 12,
            checksum: "a".repeat(64),
            chunks: vec![AttachmentChunkRef {
                index: 0,
                hash: "b".repeat(64),
                encrypted_hash: "c".repeat(64),
                size: 12,
            }],
            chunk_size: 8 * 1024 * 1024,
            created_at: 1_760_000_000_000,
        }
    }

    fn material() -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) {
        (
            vec![7u8; 32], // file key
            vec![9u8; 32], // vault key
            vec![1u8; 24], // manifest nonce
            vec![2u8; 24], // key nonce
        )
    }

    #[test]
    fn a_manifest_round_trips() {
        let (file_key, vault_key, manifest_nonce, key_nonce) = material();
        let (public_key, secret_key) = sodium::sign_seed_keypair(&[3u8; 32]).expect("keypair");

        let envelope = encrypt(
            &manifest(),
            &file_key,
            &vault_key,
            &manifest_nonce,
            &key_nonce,
            &secret_key,
            "device-a",
        )
        .expect("encrypt");

        let (decoded, recovered_key) =
            decrypt(&envelope, &vault_key, &public_key).expect("decrypt");
        assert_eq!(decoded, manifest());
        assert_eq!(recovered_key.as_slice(), file_key.as_slice());
    }

    /// The rule of §14.4.1, asserted rather than trusted: a tampered envelope
    /// is refused, and it is refused as a SIGNATURE failure rather than as a
    /// decrypt failure — which is what tells a caller the server may be lying
    /// rather than that something is broken.
    #[test]
    fn a_tampered_envelope_fails_on_the_signature_and_not_on_the_decrypt() {
        let (file_key, vault_key, manifest_nonce, key_nonce) = material();
        let (public_key, secret_key) = sodium::sign_seed_keypair(&[3u8; 32]).expect("keypair");
        let mut envelope = encrypt(
            &manifest(),
            &file_key,
            &vault_key,
            &manifest_nonce,
            &key_nonce,
            &secret_key,
            "device-a",
        )
        .expect("encrypt");

        // A server-side swap: this manifest now points at somebody else's
        // chunks. The ciphertext is well-formed and would decrypt under a key
        // the attacker also swapped, so only the signature catches it.
        envelope.encrypted_manifest = BASE64_STANDARD.encode(b"not this note's picture");

        match decrypt(&envelope, &vault_key, &public_key) {
            Err(ManifestError::BadSignature { signer_device_id }) => {
                assert_eq!(signer_device_id, "device-a");
            }
            other => panic!("expected a signature refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_manifest_signed_by_another_device_is_refused() {
        let (file_key, vault_key, manifest_nonce, key_nonce) = material();
        let (_, secret_key) = sodium::sign_seed_keypair(&[3u8; 32]).expect("keypair");
        let (other_public, _) = sodium::sign_seed_keypair(&[4u8; 32]).expect("keypair");

        let envelope = encrypt(
            &manifest(),
            &file_key,
            &vault_key,
            &manifest_nonce,
            &key_nonce,
            &secret_key,
            "device-a",
        )
        .expect("encrypt");

        assert!(matches!(
            decrypt(&envelope, &vault_key, &other_public),
            Err(ManifestError::BadSignature { .. })
        ));
    }

    /// The signature covers the four envelope fields and nothing else, in
    /// **canonical CBOR order** — which is deliberately *not* the order the
    /// `ATTACHMENT_MANIFEST` allowlist lists them in.
    ///
    /// The allowlist decides which keys may appear and rejects any other;
    /// `write_map` then sorts by key length and then bytewise, per chapter 04
    /// §4.7. So the wire order is `keyNonce`, `manifestNonce`,
    /// `encryptedFileKey`, `encryptedManifest` — shortest first. Worth pinning
    /// precisely because the two orders differ: a reader comparing this
    /// against the allowlist would conclude the encoder was broken, and a
    /// writer that emitted allowlist order would sign different bytes from
    /// every other port while still producing valid CBOR.
    #[test]
    fn the_signature_payload_is_the_four_fields_in_canonical_order() {
        let bytes = signature_payload("m", "n", "k", "q");
        let value: CborValue = ciborium::de::from_reader(bytes.as_slice()).expect("cbor");
        let CborValue::Map(entries) = value else {
            panic!("the payload is a map");
        };
        let keys: Vec<String> = entries
            .iter()
            .map(|(key, _)| match key {
                CborValue::Text(text) => text.clone(),
                other => panic!("a non-text key: {other:?}"),
            })
            .collect();
        assert_eq!(
            keys,
            [
                "keyNonce",
                "manifestNonce",
                "encryptedFileKey",
                "encryptedManifest"
            ],
            "canonical CBOR sorts by key length then bytewise, not by the allowlist"
        );
    }

    /// §14.9: `chunkSize` is informational and a reader sizes chunks from the
    /// per-chunk `size`. Asserted on the type so the field cannot quietly
    /// become the thing a reader trusts.
    #[test]
    fn the_manifest_json_matches_the_reference_writers_field_order() {
        let json = String::from_utf8(manifest_json(&manifest()).expect("json")).expect("utf8");
        let order: Vec<&str> = [
            "\"id\"",
            "\"filename\"",
            "\"mimeType\"",
            "\"size\"",
            "\"checksum\"",
            "\"chunks\"",
            "\"chunkSize\"",
            "\"createdAt\"",
        ]
        .to_vec();
        let mut last = 0;
        for key in order {
            let at = json.find(key).unwrap_or_else(|| panic!("{key} is missing"));
            assert!(at > last || last == 0, "{key} is out of order in {json}");
            last = at;
        }
        // The chunk's own keys travel in the reference writer's order too.
        assert!(json.contains("\"index\":0"));
        assert!(json.contains("\"encryptedHash\""));
    }
}
