//! `images.ts`: the name a Readwise image is stored under, so it can be found again.

use sha2::{Digest, Sha256};

/// `imageFileStem`: `rw-` and the first 16 hex digits of the SHA-256 of the URL's UTF-8 bytes.
pub fn image_file_stem(url: &str) -> String {
    let digest = hex::encode(Sha256::digest(url.as_bytes()));
    format!("rw-{}", &digest[..16])
}
