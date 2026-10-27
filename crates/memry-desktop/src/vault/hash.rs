//! The content hash of a vault file: the core's Electron-compatible djb2
//! ([`memry_core::domain::content_hash`]), streamed over a reader. Pinned to Electron's
//! output by `tests/fixtures/content-hash.json`.
//!
//! A file is hashed as the text Node's UTF-8 decoder returns: a BOM is a code unit like any
//! other, and an invalid sequence is one U+FFFD per maximal bad subpart (what
//! [`String::from_utf8_lossy`] does too).

use std::io::{self, Read};

pub use memry_core::domain::content_hash::{ContentHasher, content_hash};

/// Streams a reader through the hasher in 64 KiB chunks, so a file larger than memory
/// hashes to the value [`content_hash`] gives the whole text. Returns the hash and the
/// number of bytes read.
pub fn hash_reader(mut reader: impl Read) -> io::Result<(String, u64)> {
    let mut hasher = ContentHasher::new();
    let mut buf = vec![0u8; 64 * 1024];
    // Bytes of a multi-byte character cut by the chunk boundary, at most 3.
    let mut carry: Vec<u8> = Vec::with_capacity(4);
    let mut total = 0u64;
    loop {
        let read = reader.read(&mut buf)?;
        if read == 0 {
            break;
        }
        total += read as u64;
        carry.extend_from_slice(&buf[..read]);
        let mut start = 0;
        loop {
            match std::str::from_utf8(&carry[start..]) {
                Ok(valid) => {
                    hasher.update(valid);
                    start = carry.len();
                    break;
                }
                Err(err) => {
                    let valid_end = start + err.valid_up_to();
                    hasher.update(&String::from_utf8_lossy(&carry[start..valid_end]));
                    start = valid_end;
                    match err.error_len() {
                        Some(bad) => {
                            hasher.update("\u{FFFD}");
                            start += bad;
                        }
                        // An incomplete character at the end: wait for the next chunk.
                        None => break,
                    }
                }
            }
        }
        carry.drain(..start);
    }
    if !carry.is_empty() {
        hasher.update(&String::from_utf8_lossy(&carry));
    }
    Ok((hasher.digest(), total))
}
