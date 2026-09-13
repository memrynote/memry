//! The packed CRDT envelope, chapter 04 §4.11 and §4.12.
//!
//! A second envelope, not a variant of the record one. A CRDT update travels
//! as a single opaque byte run with a fixed 160-byte header, where the record
//! envelope travels as a JSON object of base64 fields. Nothing is shared
//! between them but the primitives underneath.
//!
//! The header holds no integers, so there is no endianness to get wrong:
//!
//! ```text
//!   0  24  dataNonce   the XChaCha20 nonce of the ciphertext
//!  24  24  keyNonce    the nonce of the wrapped file key
//!  48  48  wrappedKey  a 32-byte file key plus its 16-byte tag
//!  96  64  signature   Ed25519, detached
//! 160   *  ciphertext  the compressed Yjs update, AEAD tag included
//! ```
//!
//! Two facts in §4.12 are easy to lose and expensive to rediscover. The note
//! id is **authenticated, not merely associated**: it is the first run of the
//! signed message, so a packet made for one note read as another fails as a
//! *signature* error, before the cipher is reached. And the signature slot is
//! **excised** from the signed message rather than zeroed in place afterwards,
//! which is why the write path signs the buffer while the slot is still zero
//! and the read path skips those 64 bytes.
//!
//! This lives beside `envelope.rs` rather than inside it because that file is
//! at its 600-line ceiling, and because the two envelopes share no wire shape.

use zeroize::Zeroizing;

use crate::crypto::sodium;
use crate::protocol::compress;
use crate::protocol::envelope::{
    EnvelopeError, FILE_KEY_BYTES, NONCE_BYTES, SIGNATURE_BYTES, WRAPPED_KEY_BYTES,
};

/// Offset of `dataNonce`, §4.11.
pub const DATA_NONCE_OFFSET: usize = 0;
/// Offset of `keyNonce`, §4.11.
pub const KEY_NONCE_OFFSET: usize = DATA_NONCE_OFFSET + NONCE_BYTES;
/// Offset of `wrappedKey`, §4.11.
pub const WRAPPED_KEY_OFFSET: usize = KEY_NONCE_OFFSET + NONCE_BYTES;
/// Offset of the detached signature, §4.11. The chapter calls this out
/// separately because a stale desktop comment once said 72.
pub const SIGNATURE_OFFSET: usize = WRAPPED_KEY_OFFSET + WRAPPED_KEY_BYTES;
/// Total header length, §4.11. Derived, never written as a literal.
pub const HEADER_BYTES: usize = SIGNATURE_OFFSET + SIGNATURE_BYTES;
/// Where the ciphertext starts, §4.11.
pub const CIPHERTEXT_OFFSET: usize = HEADER_BYTES;
/// Minimum accepted length, §4.11. A 160-byte blob is a header with no body
/// and is rejected; 161 is structurally valid and fails later, at the
/// signature.
pub const MIN_PACKED_BYTES: usize = HEADER_BYTES + 1;

/// The per-update key material, §4.3.
///
/// A fresh file key per update, never reused and zeroed on drop.
pub struct CrdtMaterial {
    /// The one-shot file key the ciphertext is under.
    pub file_key: Zeroizing<Vec<u8>>,
    /// The nonce of the ciphertext.
    pub data_nonce: Vec<u8>,
    /// The nonce of the wrapped file key.
    pub key_nonce: Vec<u8>,
}

impl CrdtMaterial {
    /// Fresh random material. Tests pass fixed bytes instead, which is the
    /// only way a vector can pin an AEAD output.
    pub fn random() -> Self {
        Self {
            file_key: Zeroizing::new(sodium::random_bytes(FILE_KEY_BYTES)),
            data_nonce: sodium::random_bytes(NONCE_BYTES),
            key_nonce: sodium::random_bytes(NONCE_BYTES),
        }
    }
}

/// One update to pack.
pub struct CrdtRequest<'a> {
    /// The document id. Authenticated, not merely associated — see §4.12.
    pub note_id: &'a str,
    /// The raw Yjs update. The core never inspects these bytes.
    pub update: &'a [u8],
    /// The vault key the file key is wrapped under.
    pub vault_key: &'a [u8],
    /// This device's Ed25519 secret key.
    pub signing_secret_key: &'a [u8],
}

/// The signed message, §4.12: `UTF-8(noteId) ‖ packed[0..96) ‖ packed[160..]`.
///
/// The 64-byte signature slot is excised rather than zeroed, so this is
/// identical on write — where the slot has not been filled yet — and on read,
/// where it holds the signature being checked.
pub fn signed_message(note_id: &str, packed: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(note_id.len() + SIGNATURE_OFFSET + packed.len());
    message.extend_from_slice(note_id.as_bytes());
    message.extend_from_slice(&packed[..SIGNATURE_OFFSET]);
    message.extend_from_slice(&packed[CIPHERTEXT_OFFSET..]);
    message
}

/// Packs one CRDT update, §4.11 and §4.12.
///
/// Compress, wrap the file key with **no** AAD, encrypt the frame with the
/// note id as AAD, then sign. The signature is computed over a buffer whose
/// signature slot is still zero, which is what makes [`signed_message`] the
/// same function on both sides.
pub fn pack(request: &CrdtRequest<'_>, material: &CrdtMaterial) -> Result<Vec<u8>, EnvelopeError> {
    let framed = compress::compress(request.update);

    // No AAD on the key unwrap (§4.12). The record envelope does the same;
    // only the content carries associated data.
    let wrapped_key = sodium::aead_encrypt(
        &material.file_key,
        None,
        &material.key_nonce,
        request.vault_key,
    )?;
    let ciphertext = sodium::aead_encrypt(
        &framed,
        Some(request.note_id.as_bytes()),
        &material.data_nonce,
        material.file_key.as_slice(),
    )?;

    let mut packed = vec![0u8; HEADER_BYTES + ciphertext.len()];
    packed[DATA_NONCE_OFFSET..DATA_NONCE_OFFSET + NONCE_BYTES]
        .copy_from_slice(&material.data_nonce);
    packed[KEY_NONCE_OFFSET..KEY_NONCE_OFFSET + NONCE_BYTES].copy_from_slice(&material.key_nonce);
    packed[WRAPPED_KEY_OFFSET..WRAPPED_KEY_OFFSET + WRAPPED_KEY_BYTES]
        .copy_from_slice(&wrapped_key);
    packed[CIPHERTEXT_OFFSET..].copy_from_slice(&ciphertext);

    // Signed while the slot is still zero-filled.
    let signature = sodium::sign_detached(
        &signed_message(request.note_id, &packed),
        request.signing_secret_key,
    )?;
    packed[SIGNATURE_OFFSET..SIGNATURE_OFFSET + SIGNATURE_BYTES].copy_from_slice(&signature);

    Ok(packed)
}

/// The length guard of §4.11, run before any crypto.
fn check_length(packed: &[u8]) -> Result<(), EnvelopeError> {
    if packed.len() < MIN_PACKED_BYTES {
        return Err(EnvelopeError::Malformed {
            what: format!("CRDT update too short: {} bytes", packed.len()),
        });
    }
    Ok(())
}

/// Verifies the detached signature over §4.12's message.
///
/// Because the note id is the first run of that message, passing the wrong id
/// fails here rather than at the cipher — which is the whole point of
/// authenticating it instead of associating it.
pub fn verify(packed: &[u8], note_id: &str, signer_public_key: &[u8]) -> Result<(), EnvelopeError> {
    check_length(packed)?;
    let signature = &packed[SIGNATURE_OFFSET..SIGNATURE_OFFSET + SIGNATURE_BYTES];
    let message = signed_message(note_id, packed);
    if sodium::sign_verify_detached(signature, &message, signer_public_key) {
        Ok(())
    } else {
        Err(EnvelopeError::SignatureInvalid)
    }
}

/// Opens one packed CRDT update, §4.12.
///
/// Length, then verify, then unwrap the file key, then decrypt, then
/// decompress — in that order, so a forged packet never reaches the cipher and
/// a truncated one never looks like an empty update. The file key is zeroed on
/// drop.
pub fn unpack(
    packed: &[u8],
    note_id: &str,
    vault_key: &[u8],
    signer_public_key: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    verify(packed, note_id, signer_public_key)?;

    let wrapped_key = &packed[WRAPPED_KEY_OFFSET..WRAPPED_KEY_OFFSET + WRAPPED_KEY_BYTES];
    let key_nonce = &packed[KEY_NONCE_OFFSET..KEY_NONCE_OFFSET + NONCE_BYTES];
    let file_key = sodium::aead_decrypt(wrapped_key, None, key_nonce, vault_key)?;

    let data_nonce = &packed[DATA_NONCE_OFFSET..DATA_NONCE_OFFSET + NONCE_BYTES];
    let framed = sodium::aead_decrypt(
        &packed[CIPHERTEXT_OFFSET..],
        Some(note_id.as_bytes()),
        data_nonce,
        file_key.as_slice(),
    )?;

    Ok(compress::decompress(&framed)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signer() -> (Vec<u8>, Zeroizing<Vec<u8>>) {
        sodium::sign_seed_keypair(&[7u8; 32]).expect("keypair")
    }

    #[test]
    fn the_layout_constants_are_the_chapter_table() {
        assert_eq!(DATA_NONCE_OFFSET, 0);
        assert_eq!(KEY_NONCE_OFFSET, 24);
        assert_eq!(WRAPPED_KEY_OFFSET, 48);
        // §4.11 calls this one out because a stale comment said 72.
        assert_eq!(SIGNATURE_OFFSET, 96);
        assert_eq!(HEADER_BYTES, 160);
        assert_eq!(MIN_PACKED_BYTES, 161);
    }

    #[test]
    fn a_packet_round_trips() {
        let (public_key, secret_key) = signer();
        let vault_key = [3u8; 32];
        let update = b"an opaque yjs update the core never inspects".to_vec();
        let packed = pack(
            &CrdtRequest {
                note_id: "abc123def456",
                update: &update,
                vault_key: &vault_key,
                signing_secret_key: &secret_key,
            },
            &CrdtMaterial::random(),
        )
        .expect("pack");

        assert_eq!(
            unpack(&packed, "abc123def456", &vault_key, &public_key).expect("unpack"),
            update
        );
    }

    #[test]
    fn a_one_sixty_byte_blob_is_rejected_before_any_crypto() {
        let (public_key, _) = signer();
        let err = verify(&[0u8; HEADER_BYTES], "abc123def456", &public_key)
            .expect_err("a header with no body is not a packet");
        assert!(err.to_string().contains("CRDT update too short"), "{err}");
    }

    #[test]
    fn one_sixty_one_bytes_passes_the_length_guard_and_fails_at_the_signature() {
        let (public_key, _) = signer();
        assert_eq!(
            verify(&[0u8; MIN_PACKED_BYTES], "abc123def456", &public_key),
            Err(EnvelopeError::SignatureInvalid)
        );
    }

    #[test]
    fn the_note_id_is_authenticated_not_merely_associated() {
        let (public_key, secret_key) = signer();
        let vault_key = [3u8; 32];
        let packed = pack(
            &CrdtRequest {
                note_id: "abc123def456",
                update: b"body",
                vault_key: &vault_key,
                signing_secret_key: &secret_key,
            },
            &CrdtMaterial::random(),
        )
        .expect("pack");

        // A signature error, not an AEAD error: the id is inside the signed
        // message, so the wrong id never reaches the cipher.
        assert_eq!(
            unpack(&packed, "ffffffffffff", &vault_key, &public_key),
            Err(EnvelopeError::SignatureInvalid)
        );
    }

    #[test]
    fn tampering_with_the_ciphertext_fails_at_the_signature() {
        let (public_key, secret_key) = signer();
        let vault_key = [3u8; 32];
        let mut packed = pack(
            &CrdtRequest {
                note_id: "abc123def456",
                update: b"body",
                vault_key: &vault_key,
                signing_secret_key: &secret_key,
            },
            &CrdtMaterial::random(),
        )
        .expect("pack");
        let last = packed.len() - 1;
        packed[last] ^= 0x01;

        assert_eq!(
            unpack(&packed, "abc123def456", &vault_key, &public_key),
            Err(EnvelopeError::SignatureInvalid)
        );
    }

    #[test]
    fn the_signature_slot_is_excised_from_the_signed_message() {
        let packed = {
            let mut p = vec![0u8; HEADER_BYTES + 4];
            p[SIGNATURE_OFFSET..SIGNATURE_OFFSET + SIGNATURE_BYTES].fill(0xAB);
            p[CIPHERTEXT_OFFSET..].copy_from_slice(&[1, 2, 3, 4]);
            p
        };
        let message = signed_message("id", &packed);

        // note id + the 96 bytes before the slot + the 4 ciphertext bytes.
        assert_eq!(message.len(), 2 + SIGNATURE_OFFSET + 4);
        assert!(!message.contains(&0xAB), "the slot leaked into the message");
    }
}
