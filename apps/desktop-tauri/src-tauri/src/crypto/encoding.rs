//! Base64 and hex encoding helpers shared by crypto, KDF, signing, and the
//! sync HTTP client. Centralising these here keeps the rest of the crypto
//! layer free of crate-specific imports.

use base64::{engine::general_purpose::STANDARD, Engine as _};

pub fn base64_encode(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

pub fn base64_decode(input: &str) -> Result<Vec<u8>, base64::DecodeError> {
    STANDARD.decode(input)
}

pub fn hex_encode(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

pub fn hex_decode(input: &str) -> Result<Vec<u8>, hex::FromHexError> {
    hex::decode(input)
}
