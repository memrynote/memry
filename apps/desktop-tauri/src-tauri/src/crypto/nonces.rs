//! Random 24-byte nonces for XChaCha20-Poly1305.

use chacha20poly1305::aead::{rand_core::RngCore, OsRng};

pub const NONCE_LENGTH: usize = 24;

pub fn generate_nonce() -> [u8; NONCE_LENGTH] {
    let mut buf = [0u8; NONCE_LENGTH];
    OsRng.fill_bytes(&mut buf);
    buf
}
