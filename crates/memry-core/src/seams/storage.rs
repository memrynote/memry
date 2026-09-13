//! The file-protection seam, data-model §A.0 and FR-024.

use crate::api::errors::StorageError;

/// The data-protection class a file is created under.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ProtectionClass {
    /// `completeUntilFirstUserAuthentication`. The only class the databases may
    /// use: a background refresh task can run before the first unlock after a
    /// reboot and must still be able to read them.
    CompleteUntilFirstUserAuthentication,
    /// `complete`. Available for files that are only ever touched while the
    /// device is unlocked.
    Complete,
}

/// Platform file attributes the core cannot set itself.
#[uniffi::export(with_foreign)]
pub trait FileProtection: Send + Sync {
    /// The directory the core keeps its vaults under.
    fn application_support_dir(&self) -> Result<String, StorageError>;

    fn set_protection(&self, path: String, class: ProtectionClass) -> Result<(), StorageError>;

    /// Excludes a path from off-device backup (FR-024).
    ///
    /// Not merely a privacy preference: the secure store does not survive a
    /// phone restore, so a restored database would be unreadable anyway, and
    /// shipping it off the device buys the user nothing for the risk.
    fn exclude_from_backup(&self, path: String) -> Result<(), StorageError>;

    /// Free space, so a first sync can refuse before it fills the disk.
    fn available_bytes(&self) -> Result<u64, StorageError>;
}
