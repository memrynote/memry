//! The content hash Electron stored (`generateContentHash`, `vault/frontmatter.ts`).
//!
//! djb2 over UTF-16 code units: start 5381, `hash = (hash * 33) ^ unit` in 32-bit arithmetic,
//! result as 8 lowercase hex digits of `hash >>> 0`. Hashes already in an Electron vault
//! compare against this value, so it is not SHA-256. Pinned to Electron's output by
//! `tests/fixtures/content-hash.json`.
//!
//! A file is hashed as the text Node's UTF-8 decoder returns: a BOM is a code unit like any
//! other, and an invalid sequence is one U+FFFD per maximal bad subpart (what
//! [`String::from_utf8_lossy`] does too).

use std::io::{self, Read};

/// Incremental form of [`content_hash`]: any split of the input gives the same digest.
#[derive(Debug, Clone)]
pub struct ContentHasher {
    hash: i32,
}

impl Default for ContentHasher {
    fn default() -> Self {
        Self { hash: 5381 }
    }
}

impl ContentHasher {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update(&mut self, chunk: &str) {
        for unit in chunk.encode_utf16() {
            self.step(unit);
        }
    }

    /// For text that holds a lone surrogate, which a Rust `str` cannot.
    pub fn update_utf16(&mut self, units: &[u16]) {
        for unit in units {
            self.step(*unit);
        }
    }

    fn step(&mut self, unit: u16) {
        // JS: `(hash * 33) ^ unit`, where `^` converts the product to int32 first.
        self.hash = self.hash.wrapping_mul(33) ^ i32::from(unit);
    }

    pub fn digest(&self) -> String {
        format!("{:08x}", self.hash as u32)
    }
}

pub fn content_hash(text: &str) -> String {
    let mut hasher = ContentHasher::new();
    hasher.update(text);
    hasher.digest()
}

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
