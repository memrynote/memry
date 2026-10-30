//! Everything that touches the user's vault folder (Step 12, #3529).
//!
//! Pure foundations (hashes, paths, atomic writes, note reads and writes, file kinds, the walk),
//! the config owner and init, the watcher (`watch`), which reads `note_files` and writes nothing,
//! the consumer and write-back, the side files under `.memry/` (custom icons, property
//! definitions), and the tree operations (the folder move `move_dir`, the Obsidian
//! open-as-copy).

pub mod config;
pub mod consumer;
pub mod file_types;
pub mod fs_atomic;
pub mod hash;
pub mod icons;
pub mod init;
pub mod layout;
pub mod move_dir;
pub mod note_file;
pub mod obsidian_copy;
pub mod path_key;
pub mod paths;
pub mod properties_file;
pub mod svg;
pub mod trash;
pub mod walk;
pub mod watch;
pub mod writeback;
