//! Crypto primitives for M4: nonces, XChaCha20-Poly1305 AEAD blobs, encoding
//! helpers, Argon2id KDF, and Ed25519 sign/verify.
//!
//! Phase A spike A1 confirmed dryoc 0.7.2 ships only the secretstream
//! XChaCha20-Poly1305 variant; the one-shot AEAD API is missing. Blob
//! encrypt/decrypt therefore uses RustCrypto `chacha20poly1305`. Argon2id,
//! `crypto_kdf`, Ed25519, and BLAKE2b stay on dryoc to keep canonical
//! parameter parity with the Electron implementation.

pub mod encoding;
pub mod kdf;
pub mod nonces;
pub mod primitives;
pub mod vectors;

pub use nonces::{generate_nonce, NONCE_LENGTH};
