//! Everything that touches the user's vault folder (Step 12, #3529).
//!
//! Stage 12b: pure foundations. Hashes, paths, atomic writes, note reads and writes, the file
//! kinds and the vault walk. No watcher and no database yet; those land in later stages.

pub mod config;
pub mod file_types;
pub mod fs_atomic;
pub mod hash;
pub mod init;
pub mod layout;
pub mod note_file;
pub mod path_key;
pub mod paths;
pub mod walk;
