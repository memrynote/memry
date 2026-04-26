//! Vault filesystem layer.
//!
//! Owns `.md` IO, frontmatter parse/serialize, the per-vault JSON
//! preferences blob, the multi-vault registry, and the live `notify`
//! watcher. Vault state (current path, watcher handle, status) lives in
//! `state::VaultRuntime`, held as `AppState.vault`. All commands in
//! `commands/vault.rs` are thin async wrappers that delegate here.
//!
//! Path discipline: every external path crosses through `paths.rs`
//! before any `fs.rs` call. There are no `tokio::fs` or `std::fs` calls
//! outside `fs.rs` and `preferences.rs`, so the canonicalize+escape
//! guard cannot be bypassed by accident.

pub mod frontmatter;
pub mod fs;
pub mod notes_io;
pub mod paths;
pub mod preferences;
pub mod registry;
pub mod state;
pub mod watcher;

pub(crate) fn frontmatter_iso(secs: u64) -> String {
    frontmatter::unix_secs_to_iso(secs)
}

pub use frontmatter::{NoteFrontmatter, ParsedNote};
pub use notes_io::{NoteOnDisk, ReadNoteResult};
pub use preferences::{VaultConfig, VaultPreferences};
pub use registry::{VaultInfo, VaultRegistry};
pub use state::{VaultRuntime, VaultStatus};
