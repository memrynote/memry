//! Read-only readers for an installed Electron profile, consumed by the first-launch migration.
//!
//! Nothing here writes to the Electron profile, to a keychain or to the Tauri data dir. LevelDB
//! stores are only ever opened on a scratch copy ([`scratch`]); the profile itself is touched
//! with reads and a lock probe. Errors name the failing part and never carry file content.

pub mod config;
pub mod dictionary;
mod leveldb_log;
mod leveldb_manifest;
mod leveldb_table;
pub mod local_storage;
pub mod profile;
pub mod scratch;
pub mod secrets;
pub mod vault_db;
pub mod ystore;

use std::path::PathBuf;

pub use config::ElectronConfig;
pub use dictionary::CustomDictionary;
pub use local_storage::LocalStorageSnapshot;
pub use profile::{AppNameCandidates, ElectronProfile, HostOs, IdentityPin, ProfileEnv};
pub use scratch::{ProfileLock, Scratch, TornFile};
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
    /// A vault database table `vault_db::tables::TABLE_MAP` does not list. Nothing was written.
    #[error("{db} has an unmapped table {table}")]
    UnmappedTable { db: &'static str, table: String },
    /// A `sync_state` key `vault_db::sync_state::SYNC_STATE_KEYS` does not list. Nothing was
    /// written.
    #[error("sync_state has an unmapped key {0}")]
    UnmappedSyncStateKey(String),
    /// The source's last drizzle migration is not the frozen one the table map describes.
    #[error("{db} is at migration {found:?}, this build reads {expected}")]
    SourceSchema {
        db: &'static str,
        found: Option<i64>,
        expected: i64,
    },
    /// The source holds rows whose importer this build does not have yet. Nothing was written.
    #[error("the import of {0} is not built yet")]
    NotReady(String),
    #[error("{path} is {bytes} bytes, over the {max} byte limit")]
    TooLarge { path: PathBuf, bytes: u64, max: u64 },
    /// The source changed while it was copied: Electron was writing. Retry once it has quit.
    #[error("{0} changed while it was copied")]
    SourceChanged(PathBuf),
    /// Reading the copy of a source database failed. `detail` is SQLite's message, which names
    /// tables and columns, never values.
    #[error("{db} copy: {detail}")]
    Source { db: &'static str, detail: String },
    #[error("{table} row {rowid} has an id that is not UTF-8 text")]
    NonTextId { table: String, rowid: i64 },
    #[error("stage check {check} failed: {detail}")]
    CheckFailed { check: u8, detail: String },
    /// A file under `<vault>/.memry/core/` the import must not replace.
    #[error("{0} exists; the import does not replace it")]
    CoreFileExists(PathBuf),
    #[error(transparent)]
    Storage(#[from] memry_core::api::errors::StorageError),
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
