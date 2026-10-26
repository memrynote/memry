//! Read-only readers for an installed Electron profile, consumed by the first-launch migration.
//!
//! Nothing here writes to the Electron profile, to a keychain or to the Tauri data dir. LevelDB
//! stores are only ever opened on a scratch copy ([`scratch`]); the profile itself is touched
//! with reads and a lock probe. Errors name the failing part and never carry file content.

pub mod config;
pub mod dictionary;
mod leveldb_log;
pub mod local_storage;
pub mod profile;
pub mod scratch;
pub mod secrets;
pub mod ystore;

use std::path::PathBuf;

pub use config::ElectronConfig;
pub use dictionary::CustomDictionary;
pub use local_storage::LocalStorageSnapshot;
pub use profile::{AppNameCandidates, ElectronProfile, HostOs, IdentityPin, ProfileEnv};
pub use scratch::{ProfileLock, Scratch};
pub use secrets::{SecretEntry, SecretsReport, UnreadableReason, UnreadableSecret};
pub use ystore::{SnapshotWatermark, YStoreReader};

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("no Electron profile found")]
    ProfileNotFound,
    /// A running Electron holds a LevelDB lock; reading now could see a half-written store.
    #[error("the Electron profile is in use ({0})")]
    ProfileInUse(PathBuf),
    #[error("io error on {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// `offset` is a byte offset into the file or value; the content is never included.
    #[error("cannot parse {what} at byte {offset}")]
    Parse { what: &'static str, offset: usize },
    /// A `version` field this reader does not know. Fail closed: read nothing from it.
    #[error("{what} has unsupported version {found}")]
    UnsupportedVersion { what: &'static str, found: String },
    /// A document whose shape is not one the Electron app writes.
    #[error("{0} has an unsupported layout")]
    UnsupportedLayout(&'static str),
    #[error("key source: {0}")]
    KeySource(String),
    #[error("decrypt: {0}")]
    Decrypt(&'static str),
    #[error("leveldb: {0}")]
    LevelDb(String),
}

impl ImportError {
    pub(crate) fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }

    pub(crate) fn parse(what: &'static str, offset: usize) -> Self {
        Self::Parse { what, offset }
    }
}

#[cfg(test)]
mod tests;
