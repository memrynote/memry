//! The shell's own state: where the profile lives, how secrets are stored, and
//! how the core's objects are wired over this crate's transport.
//!
//! Everything here is shell work — a directory layout, a file-backed keychain,
//! a device descriptor. No protocol decision is taken in this file: the routes,
//! the retry ladder and the token lifecycle are all the core's
//! (Constitution I).

use std::fs;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
use std::sync::Arc;

use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::crypto::core_version;
use memry_core::api::errors::{
    ApiError, AuthError, CryptoError, RecoveryError, SecureStoreError, StorageError,
};
use memry_core::crdt::errors::CrdtError;
use memry_core::protocol::auth::DevicePlatform;
use memry_core::protocol::http::HttpClient;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::seams::transport::Transport;
use memry_core::storage::{Db, open_data};
use memry_core::sync::pull::PullError;

use crate::cli::Server;
use crate::transport::NativeTransport;

/// The device name this client registers under, so a desktop device list shows
/// what it is rather than a second Mac.
const DEVICE_NAME: &str = "memry-cli";

/// Everything that can end a command, as one variant per surface so a caller
/// sees the core's own error rather than a rendered string (Constitution II).
#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error("{0}")]
    Api(#[from] ApiError),
    #[error("{0}")]
    Auth(#[from] AuthError),
    #[error("{0}")]
    Crdt(#[from] CrdtError),
    #[error("{0}")]
    Crypto(#[from] CryptoError),
    #[error("{0}")]
    Recovery(#[from] RecoveryError),
    #[error("{0}")]
    SecureStore(#[from] SecureStoreError),
    #[error("{0}")]
    Storage(#[from] StorageError),
    #[error("{0}")]
    BodyPull(#[from] memry_core::sync::body_pull::BodyPullError),
    #[error("{0}")]
    Pull(#[from] PullError),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Refused(String),
}

/// One environment's local state.
///
/// ```text
/// ~/.memry-cli/<server>/
///   secrets/<entry>              the five chapter 01 §1.8 entries, mode 600
///   vault/<vaultId>/data.db      the core's source of record
/// ```
pub struct Cli {
    pub server: Server,
    pub client_platform: String,
    root: PathBuf,
    store: Arc<FileSecureStore>,
    transport: Arc<dyn Transport>,
}

impl Cli {
    pub fn open(server: Server, client_platform: String) -> Result<Self, CliError> {
        let home = std::env::var("HOME").map_err(|_| {
            CliError::Refused("HOME is not set, so there is nowhere to keep a profile".to_string())
        })?;
        let root = PathBuf::from(home).join(".memry-cli").join(&server.label);
        private_dir(&root)?;
        let store = Arc::new(FileSecureStore::open(root.join("secrets"))?);
        Ok(Self {
            server,
            client_platform,
            root,
            store,
            transport: Arc::new(NativeTransport::new().map_err(|error| {
                CliError::Refused(format!("the transport could not be built: {error}"))
            })?),
        })
    }

    /// The session. Built even for the commands that only read, because it owns
    /// the one token manager and a second one would refresh in parallel with it
    /// (chapter 02 §2.9).
    pub fn session(&self) -> Result<AuthSession, CliError> {
        Ok(AuthSession::new(
            self.transport.clone(),
            self.store.clone(),
            self.server.base_url.clone(),
            self.client_platform.clone(),
            DeviceDescriptor {
                name: DEVICE_NAME.to_string(),
                // Chapter 02 §2.12's registration enum, which is the host this
                // binary runs on — not `--client-platform`, which is chapter
                // 11's header and a different vocabulary.
                platform: DevicePlatform::Macos,
                os_version: None,
                app_version: core_version(),
                vault_id: None,
            },
        )?)
    }

    pub fn http(&self) -> Result<Arc<HttpClient>, CliError> {
        Ok(self.session()?.http())
    }

    /// The secure store, for the one command that writes an entry of its own.
    pub fn store(&self) -> Arc<FileSecureStore> {
        self.store.clone()
    }

    pub fn master_key(&self) -> Result<Vec<u8>, CliError> {
        self.store.get(SecureStoreKey::MasterKey)?.ok_or_else(|| {
            CliError::Refused(
                "this profile is locked: run `memry unlock --recovery-phrase-file <path>` first"
                    .to_string(),
            )
        })
    }

    pub fn vault_dir(&self, vault_id: &str) -> PathBuf {
        self.root.join("vault").join(vault_id)
    }

    /// Opens `data.db` for one vault, creating and migrating it on first use.
    pub fn open_vault(&self, vault_id: &str) -> Result<Db, CliError> {
        let dir = self.vault_dir(vault_id);
        private_dir(&dir)?;
        Ok(open_data(&dir.join("data.db"))?)
    }

    /// The vault a command without `--vault` means.
    ///
    /// Quickstart §G4 calls `notes text <id>` with no vault, so exactly one
    /// pulled vault is the only unambiguous reading. Two is refused rather than
    /// guessed at: picking one silently would print another vault's note.
    pub fn only_vault(&self) -> Result<String, CliError> {
        let root = self.root.join("vault");
        let mut found: Vec<String> = Vec::new();
        if root.is_dir() {
            for entry in fs::read_dir(&root)? {
                let entry = entry?;
                if entry.path().is_dir()
                    && let Some(name) = entry.file_name().to_str()
                {
                    found.push(name.to_string());
                }
            }
        }
        found.sort();
        match found.len() {
            1 => Ok(found.remove(0)),
            0 => Err(CliError::Refused(
                "no vault has been pulled yet: run `memry pull --vault <id>`".to_string(),
            )),
            _ => Err(CliError::Refused(format!(
                "this profile holds {} vaults ({}); say which one with --vault",
                found.len(),
                found.join(", ")
            ))),
        }
    }
}

fn private_dir(path: &std::path::Path) -> Result<(), std::io::Error> {
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

/// The `SecureStore` seam over files.
///
/// A headless developer tool has no Keychain prompt to answer, so the entries
/// live in the profile at mode 600 under a 700 directory. That is weaker than
/// the iOS shell's `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and it is
/// why this binary is a test client: it is never shipped to a user.
pub struct FileSecureStore {
    dir: PathBuf,
}

impl FileSecureStore {
    pub fn open(dir: PathBuf) -> Result<Self, CliError> {
        private_dir(&dir)?;
        Ok(Self { dir })
    }

    /// The chapter 01 §1.8 account names, so a file's name says which entry it
    /// is without a lookup table of its own.
    fn path(&self, key: SecureStoreKey) -> PathBuf {
        self.dir.join(match key {
            SecureStoreKey::MasterKey => "master-key",
            SecureStoreKey::DeviceSigningKey => "device-signing-key",
            SecureStoreKey::AccessToken => "access-token",
            SecureStoreKey::RefreshToken => "refresh-token",
            SecureStoreKey::SetupToken => "setup-token",
        })
    }
}

fn failed(what: impl std::fmt::Display) -> SecureStoreError {
    SecureStoreError::Failed {
        what: what.to_string(),
    }
}

impl SecureStore for FileSecureStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        match fs::read(self.path(key)) {
            Ok(bytes) => Ok(Some(bytes)),
            // Absent is `None`. Every other failure is reported: an unreadable
            // entry must never look like a missing one, or the caller mints a
            // second device identity over a key it already had.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(failed(error)),
        }
    }

    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        use std::io::Write as _;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(self.path(key))
            .map_err(failed)?;
        file.write_all(&value).map_err(failed)?;
        file.sync_all().map_err(failed)
    }

    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        match fs::remove_file(self.path(key)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(failed(error)),
        }
    }

    fn clear(&self) -> Result<(), SecureStoreError> {
        for key in [
            SecureStoreKey::MasterKey,
            SecureStoreKey::DeviceSigningKey,
            SecureStoreKey::AccessToken,
            SecureStoreKey::RefreshToken,
            SecureStoreKey::SetupToken,
        ] {
            self.delete(key)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn scratch(label: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("memry-cli-{label}-{}-{unique}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn an_entry_round_trips_as_bytes_at_mode_600() {
        let dir = scratch("secrets");
        let store = FileSecureStore::open(dir.clone()).expect("a store");

        assert_eq!(store.get(SecureStoreKey::MasterKey).expect("read"), None);
        store
            .set(SecureStoreKey::MasterKey, vec![7u8; 32])
            .expect("write");
        assert_eq!(
            store.get(SecureStoreKey::MasterKey).expect("read back"),
            Some(vec![7u8; 32])
        );

        let mode = fs::metadata(dir.join("master-key"))
            .expect("the entry exists")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);

        store.clear().expect("clear");
        assert_eq!(store.get(SecureStoreKey::MasterKey).expect("read"), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_entry_has_its_own_file() {
        let dir = scratch("entries");
        let store = FileSecureStore::open(dir.clone()).expect("a store");
        for (key, value) in [
            (SecureStoreKey::DeviceSigningKey, b"signing".to_vec()),
            (SecureStoreKey::AccessToken, b"access".to_vec()),
            (SecureStoreKey::RefreshToken, b"refresh".to_vec()),
            (SecureStoreKey::SetupToken, b"setup".to_vec()),
        ] {
            store.set(key, value.clone()).expect("write");
            assert_eq!(store.get(key).expect("read"), Some(value));
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
