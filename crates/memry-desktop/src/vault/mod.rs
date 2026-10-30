//! Everything that touches the user's vault folder (Step 12, #3529).
//!
//! Pure foundations (hashes, paths, atomic writes, note reads and writes, file kinds, the walk),
//! the config owner and init, the watcher (`watch`), which reads `note_files` and writes nothing,
//! the consumer and write-back, the side files under `.memry/` (the activity log, custom
//! icons, property definitions), and the tree operations (the folder move `move_dir` with its
//! journal `move_journal`, the journal renames of a date format change, the Obsidian
//! open-as-copy).

pub mod activity;
pub mod config;
pub mod consumer;
pub mod file_types;
pub mod fs_atomic;
pub mod hash;
pub mod icons;
pub mod import_copy;
pub mod init;
pub mod journal_format;
pub mod journal_rename;
pub mod layout;
pub mod move_dir;
pub mod move_journal;
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
