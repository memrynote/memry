//! XChaCha20-Poly1305 AEAD wrappers for blob encrypt/decrypt.
//!
//! `encrypt_blob` returns ciphertext (with the 16-byte Poly1305 tag appended)
//! plus the freshly generated 24-byte nonce. `decrypt_blob` accepts the same
//! ciphertext+tag layout and the original nonce and key. Wrong key length,
//! wrong nonce length, mismatched associated data, and tampered ciphertext
//! all surface as `AppError::Crypto` so callers can render a single error
//! kind across the IPC boundary.

use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    Key, XChaCha20Poly1305, XNonce,
};

use crate::error::{AppError, AppResult};

pub use super::nonces::NONCE_LENGTH;

pub const KEY_LENGTH: usize = 32;
pub const TAG_LENGTH: usize = 16;

#[derive(Debug)]
pub struct EncryptedBlob {
    pub ciphertext: Vec<u8>,
    pub nonce: [u8; NONCE_LENGTH],
}

pub fn encrypt_blob(
    plaintext: &[u8],
    key: &[u8],
    associated_data: Option<&[u8]>,
) -> AppResult<EncryptedBlob> {
    if key.len() != KEY_LENGTH {
        return Err(AppError::Crypto(format!(
            "key length must be {KEY_LENGTH} bytes, got {}",
            key.len()
        )));
    }

    let nonce_bytes = super::nonces::generate_nonce();
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = XNonce::from_slice(&nonce_bytes);

    let ciphertext = match associated_data {
        Some(aad) => cipher
            .encrypt(nonce, Payload { msg: plaintext, aad })
            .map_err(|err| AppError::Crypto(format!("encrypt failed: {err}")))?,
        None => cipher
            .encrypt(nonce, plaintext)
            .map_err(|err| AppError::Crypto(format!("encrypt failed: {err}")))?,
    };

    Ok(EncryptedBlob {
        ciphertext,
        nonce: nonce_bytes,
    })
}

pub fn decrypt_blob(
    ciphertext: &[u8],
    nonce: &[u8],
    key: &[u8],
    associated_data: Option<&[u8]>,
) -> AppResult<Vec<u8>> {
    if key.len() != KEY_LENGTH {
        return Err(AppError::Crypto(format!(
            "key length must be {KEY_LENGTH} bytes, got {}",
            key.len()
        )));
    }
    if nonce.len() != NONCE_LENGTH {
        return Err(AppError::Crypto(format!(
            "nonce length must be {NONCE_LENGTH} bytes, got {}",
            nonce.len()
        )));
    }

    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = XNonce::from_slice(nonce);

    let plaintext = match associated_data {
        Some(aad) => cipher
            .decrypt(nonce, Payload { msg: ciphertext, aad })
            .map_err(|err| AppError::Crypto(format!("decrypt failed: {err}")))?,
        None => cipher
            .decrypt(nonce, ciphertext)
            .map_err(|err| AppError::Crypto(format!("decrypt failed: {err}")))?,
    };

    Ok(plaintext)
}
