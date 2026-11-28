//! The run's error and its check name, which the report's `failure.check` and telemetry's
//! `errorCode` carry.

use std::path::PathBuf;

use crate::electron_import::ImportError;
use crate::electron_import::secrets_import::SecretsError;

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("Quit the previous MemryNote app, then start MemryNote again.")]
    ElectronRunning,
    /// A vault opened before the first-launch run finished.
    #[error(
        "MemryNote has not finished moving your data from the previous MemryNote app. Finish \
         moving your data first, then open this vault."
    )]
    NotMigrated,
    /// A folder with Electron data that the first-launch run did not list.
    #[error(
        "The vault at {vault} holds data from the previous MemryNote app that MemryNote did not \
         move. Keep using the previous MemryNote app for it."
    )]
    NotMoved { vault: String },
    #[error(
        "There is not enough free space on {}: moving your data needs {needed} bytes and \
         {available} are free. Free some space and try again.",
        volume.display()
    )]
    DiskSpace {
        volume: PathBuf,
        needed: u64,
        available: u64,
    },
    /// The vault's `data.db` is not at the schema of the last Electron release.
    #[error(
        "The previous MemryNote app has not finished updating the vault at {vault}. Update the \
         previous app, open the vault in it once, quit it, then start MemryNote again."
    )]
    ElectronSchema {
        vault: String,
        found: Option<i64>,
        expected: &'static [i64],
    },
    #[error(
        "These vaults share one sync history, so MemryNote cannot move them: {}. Nothing was \
         changed. Keep using the previous MemryNote app for them.",
        paths.join(", ")
    )]
    SharedStore { paths: Vec<String> },
    #[error(
        "The vault at {vault} cannot be read now. Check that its drive is connected and try again."
    )]
    VaultUnreachable { vault: String },
    #[error(transparent)]
    Secrets(SecretsError),
    #[error("{vault}: {source}")]
    Vault {
        vault: String,
        #[source]
        source: ImportError,
    },
    #[error(transparent)]
    Import(#[from] ImportError),
}

impl RunError {
    /// The failing check or error kind: the report's `failure.check` and telemetry's
    /// `errorCode`. Never a path.
    pub fn check(&self) -> String {
        match self {
            Self::ElectronRunning => "electron-running".into(),
            Self::NotMigrated => "not-migrated".into(),
            Self::NotMoved { .. } => "not-moved".into(),
            Self::DiskSpace { .. } => "disk-space".into(),
            Self::ElectronSchema { .. } => "electron-schema".into(),
            Self::SharedStore { .. } => "shared-store".into(),
            Self::VaultUnreachable { .. } => "vault-unreachable".into(),
            Self::Secrets(error) => format!("secrets:{}", secrets_code(error)),
            Self::Vault { source, .. } | Self::Import(source) => import_code(source),
        }
    }

    pub(super) fn vault(&self) -> Option<String> {
        match self {
            Self::ElectronSchema { vault, .. }
            | Self::VaultUnreachable { vault }
            | Self::NotMoved { vault }
            | Self::Vault { vault, .. } => Some(vault.clone()),
            _ => None,
        }
    }
}

fn secrets_code(error: &SecretsError) -> &'static str {
    match error {
        SecretsError::Read(_) => "read",
        SecretsError::DoneMarker(_) => "done-marker",
        SecretsError::Unreadable(_) => "unreadable",
        SecretsError::KeytarUnlisted(_) => "keytar-unlisted",
        SecretsError::Malformed { .. } => "malformed",
        SecretsError::DeviceKeyMismatch => "device_key_mismatch",
        SecretsError::KeyVerifierMismatch => "KeyVerifierMismatch",
        SecretsError::TargetOccupied { .. } => "target-occupied",
        SecretsError::Keychain(_) => "keychain",
        SecretsError::RollbackIncomplete { cause, .. } => secrets_code(cause),
    }
}

fn import_code(error: &ImportError) -> String {
    match error {
        ImportError::CheckFailed { check, .. } => format!("check-{check}"),
        ImportError::NotReady { .. } => "not-ready".into(),
        ImportError::ProfileInUse(_) => "electron-running".into(),
        ImportError::SourceSchema { .. } => "electron-schema".into(),
        ImportError::DeleteWithoutDevice => "delete-without-device".into(),
        ImportError::MalformedRow { .. } | ImportError::NonTextId { .. } => "malformed-row".into(),
        ImportError::CoreFileExists(_) => "core-file-exists".into(),
        ImportError::SourceChanged(_) => "source-changed".into(),
        ImportError::Io { .. } => "io".into(),
        _ => "import".into(),
    }
}
