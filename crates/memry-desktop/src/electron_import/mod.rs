//! Readers for an installed Electron profile, and the first-launch migration phases built on them.
//!
//! Nothing here writes to the Electron profile or to Electron's keychain items. The readers write
//! nothing at all; [`secrets_import`] writes this app's own keychain entries only. LevelDB
//! stores are only ever opened on a scratch copy ([`scratch`]); the profile itself is touched
//! with reads and a lock probe. The migration phases ([`app_state`]) write only the Tauri data
//! dir. Errors name the failing part and never carry file content.

pub mod app_state;
pub mod config;
pub mod dictionary;
pub mod journal_replay;
mod leveldb_log;
mod leveldb_manifest;
mod leveldb_table;
pub mod local_storage;
pub mod profile;
pub mod progress;
pub mod report;
pub mod scratch;
pub mod secrets;
pub mod secrets_import;
pub mod vault_db;
pub mod vault_evidence;
pub mod ystore;
pub mod ystore_import;

use std::path::PathBuf;

pub use config::ElectronConfig;
pub use dictionary::CustomDictionary;
pub use local_storage::LocalStorageSnapshot;
pub use profile::{AppNameCandidates, ElectronProfile, HostOs, IdentityPin, ProfileEnv};
pub use scratch::{ProfileLock, Scratch, TornFile};
pub use secrets::{SecretEntry, SecretsReport, UnreadableReason, UnreadableSecret};
pub use secrets_import::{
    SecretsError, SecretsEvidence, SecretsMode, SecretsOutcome, SecretsPhase, import_secrets,
};
pub use vault_evidence::{VaultEvidence, read_vault_evidence};
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
    /// The Tauri `memry-config.json` refused the merge or could not be written.
    #[error("app config: {0}")]
    AppConfig(#[from] crate::registry::ConfigError),
    /// A copied file's size or sha256 differs from its source; the copy was discarded.
    #[error("the copy of {0} does not match its source")]
    CopyMismatch(PathBuf),
    /// A value written to the Tauri data dir did not read back as written.
    #[error("{0} did not read back as written")]
    ReadBack(&'static str),
    /// A vault database table `vault_db::tables::TABLE_MAP` does not list. Nothing was written.
    #[error("{db} has an unmapped table {table}")]
    UnmappedTable { db: &'static str, table: String },
    /// A `sync_state` key `vault_db::sync_state::SYNC_STATE_KEYS` does not list. Nothing was
    /// written.
    #[error("sync_state has an unmapped key {0}")]
    UnmappedSyncStateKey(String),
    /// The source's last drizzle migration is none of the frozen ones the table map describes.
    #[error("{db} is at migration {found:?}, this build reads {expected:?}")]
    SourceSchema {
        db: &'static str,
        found: Option<i64>,
        expected: &'static [i64],
    },
    /// The source holds rows whose importer this build does not have yet. Nothing was written.
    /// The source holds data whose importer a later build brings. The message is the user's:
    /// `area` in their words, and what to do. `detail` names the table or key, for logs.
    #[error(
        "This version of MemryNote cannot move this vault's {area} yet. Nothing was changed. \
         Keep using the previous MemryNote app for this vault, and update MemryNote to try again."
    )]
    NotReady { area: &'static str, detail: String },
    /// A queued delete has no clock, and `memry-config.json` names no device to stamp one with
    /// as Electron's push does. Staging it would let the core push retire it unsent.
    #[error(
        "A delete in this vault has not synced yet, and MemryNote cannot send it without the \
         previous app's sync device. Nothing was changed. Open the previous MemryNote app, let \
         it finish syncing, then quit it and try again."
    )]
    DeleteWithoutDevice,
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
    /// A source value the import cannot carry over as Electron reads it. `what` names the
    /// column and the fault, never the value.
    #[error("{table} row {rowid}: {what}")]
    MalformedRow {
        table: &'static str,
        rowid: i64,
        what: &'static str,
    },
    #[error("stage check {check} failed: {detail}")]
    CheckFailed { check: u8, detail: String },
    /// A file under `<vault>/.memry/core/` the import must not replace.
    #[error("{0} exists; the import does not replace it")]
    CoreFileExists(PathBuf),
    #[error(transparent)]
    Storage(#[from] memry_core::api::errors::StorageError),
    #[error("sqlite: {0}")]
    Sqlite(String),
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
