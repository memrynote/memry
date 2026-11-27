//! The content hash of a vault file: the core's Electron-compatible djb2
//! ([`memry_core::domain::content_hash`]), streamed over a reader. Pinned to Electron's
//! output by `tests/fixtures/content-hash.json`.

pub use memry_core::domain::content_hash::{ContentHasher, content_hash, hash_reader};
