//! The device identity store until the OS keychain lands (Step 15, #3532).
//!
//! Settings clocks name the device by the id derived from its signing key, so the shell needs
//! that key before it can write a synced setting, and sign-in later reuses it (core
//! `ensure_device_identity`). This store holds **only** that key, in `<profile>/device-key`
//! (mode 0600 on Unix, an atomic rename everywhere). Every other entry refuses: a master key or
//! a token never goes to a file. Step 15 must move this file's key into the keychain, not mint
//! a new one, or clocks written before it would name a device that no longer exists.

use std::fs;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Arc;

use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};

const FILE_NAME: &str = "device-key";

pub struct ProfileDeviceKeyStore {
    path: PathBuf,
}

impl ProfileDeviceKeyStore {
    pub fn shared(data_dir: &std::path::Path) -> Arc<dyn SecureStore> {
        Arc::new(Self {
            path: data_dir.join(FILE_NAME),
        })
    }
}

fn failed(what: impl std::fmt::Display) -> SecureStoreError {
    SecureStoreError::Failed {
        what: what.to_string(),
    }
}

fn refuse(key: SecureStoreKey) -> SecureStoreError {
    SecureStoreError::Denied {
        what: format!("{key:?} needs the OS keychain, which this build does not have yet"),
    }
}

impl SecureStore for ProfileDeviceKeyStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        if key != SecureStoreKey::DeviceSigningKey {
            return Ok(None);
        }
        match fs::read(&self.path) {
            Ok(bytes) => Ok(Some(bytes)),
            // Absent is `None`; any other failure is reported, so an unreadable key never
            // looks missing and gets a second identity minted over it.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(failed(error)),
        }
    }

    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        if key != SecureStoreKey::DeviceSigningKey {
            return Err(refuse(key));
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(failed)?;
        }
        let temp = self.path.with_extension("tmp");
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&temp).map_err(failed)?;
        file.write_all(&value).map_err(failed)?;
        file.sync_all().map_err(failed)?;
        fs::rename(&temp, &self.path).map_err(failed)
    }

    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        if key != SecureStoreKey::DeviceSigningKey {
            return Ok(());
        }
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(failed(error)),
        }
    }

    fn clear(&self) -> Result<(), SecureStoreError> {
        self.delete(SecureStoreKey::DeviceSigningKey)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_signing_key_is_stored_and_it_is_private() {
        let dir = tempfile::tempdir().expect("tmp");
        let store = ProfileDeviceKeyStore::shared(dir.path());
        assert_eq!(
            store.get(SecureStoreKey::DeviceSigningKey).expect("get"),
            None
        );
        store
            .set(SecureStoreKey::DeviceSigningKey, vec![7; 64])
            .expect("set");
        assert_eq!(
            store.get(SecureStoreKey::DeviceSigningKey).expect("get"),
            Some(vec![7; 64])
        );
        assert!(store.set(SecureStoreKey::MasterKey, vec![1]).is_err());
        assert!(store.set(SecureStoreKey::AccessToken, vec![1]).is_err());
        assert_eq!(store.get(SecureStoreKey::MasterKey).expect("get"), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join(FILE_NAME))
                .expect("meta")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        store.clear().expect("clear");
        assert_eq!(
            store.get(SecureStoreKey::DeviceSigningKey).expect("get"),
            None
        );
    }
}
