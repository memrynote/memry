//! The content hash Electron stored (`generateContentHash`, `vault/frontmatter.ts`).
//!
//! djb2 over UTF-16 code units: start 5381, `hash = (hash * 33) ^ unit` in 32-bit arithmetic,
//! result as 8 lowercase hex digits of `hash >>> 0`. Hashes already in an Electron vault and
//! its `note_snapshots` compare against this value, so it is not SHA-256. Pinned to
//! Electron's output by `memry-desktop`'s `tests/fixtures/content-hash.json`.

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
