//! The device identity store until the OS keychain lands (Step 15, #3532).
//!
//! Settings clocks name the device by the id derived from its signing key, so the shell needs
//! that key before it can write a synced setting, and sign-in later reuses it (core
//! `ensure_device_identity`). This store holds **only** that key, in `<profile>/device-key`
//! (mode 0600 on Unix, an atomic rename everywhere). Windows has no 0600 equivalent: the file
//! inherits the profile directory's ACL, which is acceptable until Step 15 moves the key to the
//! keychain. Every other entry refuses: a master key or
//! a token never goes to a file. Step 15 must move this file's key into the keychain, not mint
//! a new one, or clocks written before it would name a device that no longer exists.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};

const FILE_NAME: &str = "device-key";
const KEY_LEN: usize = 64;

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
            Ok(bytes) if bytes.len() == KEY_LEN => Ok(Some(bytes)),
            Ok(bytes) => Err(failed(format!(
                "device-key holds {} bytes, expected {KEY_LEN}",
                bytes.len()
            ))),
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
        // Temp file, sync, rename over, folder sync: the one atomic writer of the vault tier.
        crate::vault::fs_atomic::atomic_write(&self.path, &value)
            .map_err(|error| failed(error.source))
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
    fn a_key_of_the_wrong_length_is_reported_not_returned() {
        let dir = tempfile::tempdir().expect("tmp");
        fs::write(dir.path().join(FILE_NAME), [1u8; 10]).expect("seed");
        let store = ProfileDeviceKeyStore::shared(dir.path());
        assert!(store.get(SecureStoreKey::DeviceSigningKey).is_err());
    }

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
