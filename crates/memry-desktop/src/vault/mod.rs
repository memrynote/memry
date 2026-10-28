//! Everything that touches the user's vault folder (Step 12, #3529).
//!
//! Pure foundations (hashes, paths, atomic writes, note reads and writes, file kinds, the walk),
//! the config owner and init, and the watcher (`watch`), which reads `note_files` and writes nothing.

pub mod config;
pub mod consumer;
pub mod file_types;
pub mod fs_atomic;
pub mod hash;
pub mod init;
pub mod layout;
pub mod note_file;
pub mod path_key;
pub mod paths;
pub mod trash;
pub mod walk;
pub mod watch;
pub mod writeback;
