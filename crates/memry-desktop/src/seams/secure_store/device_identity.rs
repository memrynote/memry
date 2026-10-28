//! The device signing key in the keychain, moved there once from the file of earlier builds.
//!
//! Settings clocks name this device by the id derived from its signing key, and the core reads
//! the key on every writer it builds (`Tasks::over`, `NotesWriter`, journal, canvas, inbox,
//! calendar, `AppSettings::over`). Builds before Step 15 kept the key in `<profile>/device-key`
//! (64 bytes, mode 0600). Minting a new key instead of moving that one would leave every clock
//! written so far naming a device that no longer exists, so this store moves the key and never
//! mints over one that may exist. No Tauri build has shipped to users, so the file exists only on
//! dev, CI and internal profiles; Electron's keychain item is read in place by [`KeyringStore`].
//!
//! Only `DeviceSigningKey` is handled here; every other key goes straight to the keychain.
//!
//! **Move.** Keychain write, read back and compare, marker `<profile>/device-key.location`, then
//! the file is removed. Every crash point leaves a state the next read finishes: the keychain and
//! the file hold the same key, so the file is removed (with or without the marker). A keychain
//! key that differs from the file wins, and the file is kept: a key that differs is never deleted.
//!
//! **Marker.** Written once the key is known to be in the keychain. From then on a file is never
//! read, so a keychain that is locked or gone answers `Locked` instead of reviving a file key.
//!
//! **Locked keychain.** With a file and no marker the file serves the key (it is on disk either
//! way) and the move is tried again on the next read. With no file it is `Locked`, so the core
//! never mints over a key it could not read: an unanswered macOS access prompt for an item
//! Electron wrote is the common case.
//!
//! **No keychain on the system** (Linux with no Secret Service running or activatable, and no
//! marker): the file holds the key, so the app can still write locally, as Electron could. Sign-in
//! is impossible without a keychain, so that key is not registered while it lives in the file;
//! the first read after a keychain appears moves it. If that keychain already holds an Electron
//! key, the keychain wins, and only the clocks written in between name the file's device.
//!
//! **Cache.** A key read from or written to the keychain is kept in memory (zeroized on drop), so
//! a keychain that locks later does not stop writes. A key served from the file is not cached,
//! so the move is retried.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use zeroize::Zeroizing;

use super::KeyringStore;
use crate::vault::fs_atomic::atomic_write;

const DSK: SecureStoreKey = SecureStoreKey::DeviceSigningKey;
/// The file of the builds before Step 15 (`profile_store.rs`, removed).
const LEGACY_FILE: &str = "device-key";
const MARKER_FILE: &str = "device-key.location";
const MARKER: &[u8] = b"keychain\n";
/// A libsodium Ed25519 secret key, the shape Electron and the core both store.
const KEY_LEN: usize = 64;

type Key = Zeroizing<Vec<u8>>;
type Probe = Box<dyn Fn() -> bool + Send + Sync>;

enum Legacy {
    Absent,
    Key(Key),
    Unusable(String),
}

pub struct DeviceIdentityStore {
    keychain: Arc<dyn SecureStore>,
    keychain_absent: Probe,
    dir: PathBuf,
    /// The key read from or written to the keychain. The lock also serializes the device key's
    /// reads and writes, so two first reads never move the file at once.
    cache: Mutex<Option<Key>>,
}

fn failed(what: impl Into<String>) -> SecureStoreError {
    SecureStoreError::Failed { what: what.into() }
}

fn checked(key: Vec<u8>, source: &str) -> Result<Key, SecureStoreError> {
    let key = Zeroizing::new(key);
    if key.len() == KEY_LEN {
        Ok(key)
    } else {
        Err(failed(format!(
            "the device key in the {source} holds {} bytes, expected {KEY_LEN}",
            key.len()
        )))
    }
}

impl DeviceIdentityStore {
    /// `data_dir` is the profile directory that held `device-key`.
    pub fn new(keychain: Arc<KeyringStore>, data_dir: &Path) -> Self {
        Self::with_probe(keychain, data_dir, super::keychain_absent)
    }

    /// A store over any keychain and a chosen "no keychain on this system" answer. For tests.
    #[doc(hidden)]
    pub fn with_probe(
        keychain: Arc<dyn SecureStore>,
        data_dir: &Path,
        keychain_absent: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Self {
        Self {
            keychain,
            keychain_absent: Box::new(keychain_absent),
            dir: data_dir.to_owned(),
            cache: Mutex::new(None),
        }
    }

    fn cache(&self) -> MutexGuard<'_, Option<Key>> {
        self.cache.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn legacy_path(&self) -> PathBuf {
        self.dir.join(LEGACY_FILE)
    }

    fn legacy(&self) -> Legacy {
        match fs::read(self.legacy_path()) {
            Ok(bytes) => match checked(bytes, "file `device-key`") {
                Ok(key) => Legacy::Key(key),
                Err(error) => Legacy::Unusable(error.to_string()),
            },
            Err(error) if error.kind() == ErrorKind::NotFound => Legacy::Absent,
            Err(error) => Legacy::Unusable(format!("the file `device-key` is unreadable: {error}")),
        }
    }

    /// An unreadable marker counts as present: the file is then never used.
    fn marked(&self) -> bool {
        match fs::metadata(self.dir.join(MARKER_FILE)) {
            Ok(_) => true,
            Err(error) => error.kind() != ErrorKind::NotFound,
        }
    }

    fn mark(&self) -> Result<(), SecureStoreError> {
        if self.marked() {
            return Ok(());
        }
        atomic_write(&self.dir.join(MARKER_FILE), MARKER).map_err(|error| {
            failed(format!(
                "the device key marker could not be written: {}",
                error.source
            ))
        })
    }

    fn remove_legacy(&self) {
        match fs::remove_file(self.legacy_path()) {
            Ok(()) => tracing::info!(
                scope = "DeviceIdentity",
                "the device key now lives only in the keychain; removed `device-key`"
            ),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => tracing::warn!(
                scope = "DeviceIdentity",
                "the device key is in the keychain, but `device-key` could not be removed: {error}"
            ),
        }
    }

    /// The keychain holds `key`: mark it, then drop a file that holds the same key.
    fn settle(&self, key: &Key) {
        if let Err(error) = self.mark() {
            tracing::warn!(scope = "DeviceIdentity", "{error}; `device-key` is kept");
            return;
        }
        match self.legacy() {
            Legacy::Key(file) if file == *key => self.remove_legacy(),
            Legacy::Key(_) => tracing::warn!(
                scope = "DeviceIdentity",
                "`device-key` holds another key than the keychain; the keychain's is used and the file is kept"
            ),
            Legacy::Unusable(what) => {
                tracing::warn!(scope = "DeviceIdentity", "{what}; the file is kept");
            }
            Legacy::Absent => {}
        }
    }

    /// Copies the file's key into the keychain and removes the file once it reads back.
    fn migrate(&self, key: Key) -> Result<Option<Key>, SecureStoreError> {
        match self.keychain.set(DSK, key.to_vec()) {
            Ok(()) => {}
            // A write that timed out may still land; the next read finds it equal and settles.
            Err(SecureStoreError::Locked) => return Ok(Some(key)),
            Err(error) => return Err(error),
        }
        match self.keychain.get(DSK) {
            Ok(Some(back)) if *back == **key => {
                self.settle(&key);
                Ok(Some(key))
            }
            Ok(_) => Err(failed(
                "the device key written to the keychain did not read back; `device-key` is kept",
            )),
            Err(SecureStoreError::Locked) => Ok(Some(key)),
            Err(error) => Err(error),
        }
    }

    fn read(&self, cache: &mut Option<Key>) -> Result<Option<Key>, SecureStoreError> {
        match self.keychain.get(DSK) {
            Ok(Some(key)) => {
                let key = checked(key, "keychain")?;
                self.settle(&key);
                *cache = Some(key.clone());
                Ok(Some(key))
            }
            Ok(None) if self.marked() => Ok(None),
            Ok(None) => match self.legacy() {
                Legacy::Absent => Ok(None),
                Legacy::Key(key) => {
                    let moved = self.migrate(key)?;
                    if self.marked() {
                        cache.clone_from(&moved);
                    }
                    Ok(moved)
                }
                Legacy::Unusable(what) => Err(failed(what)),
            },
            Err(SecureStoreError::Locked) if self.marked() => Err(SecureStoreError::Locked),
            Err(SecureStoreError::Locked) => match self.legacy() {
                Legacy::Key(key) => Ok(Some(key)),
                Legacy::Absent if (self.keychain_absent)() => Ok(None),
                Legacy::Absent => Err(SecureStoreError::Locked),
                Legacy::Unusable(what) => Err(failed(what)),
            },
            Err(error) => Err(error),
        }
    }
}

impl SecureStore for DeviceIdentityStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        if key != DSK {
            return self.keychain.get(key);
        }
        let mut cache = self.cache();
        if let Some(known) = cache.as_ref() {
            return Ok(Some(known.to_vec()));
        }
        Ok(self.read(&mut cache)?.map(|key| key.to_vec()))
    }

    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        if key != DSK {
            return self.keychain.set(key, value);
        }
        let mut cache = self.cache();
        let value = Zeroizing::new(value);
        match self.keychain.set(DSK, value.to_vec()) {
            Ok(()) => {
                if let Err(error) = self.mark() {
                    tracing::warn!(scope = "DeviceIdentity", "{error}");
                }
                *cache = Some(value);
                Ok(())
            }
            Err(SecureStoreError::Locked)
                if !self.marked()
                    && matches!(self.legacy(), Legacy::Absent)
                    && (self.keychain_absent)() =>
            {
                tracing::warn!(
                    scope = "DeviceIdentity",
                    "this system has no keychain; the device key is kept in `device-key` until one appears"
                );
                atomic_write(&self.legacy_path(), &value).map_err(|error| {
                    failed(format!(
                        "the device key could not be written: {}",
                        error.source
                    ))
                })
            }
            Err(error) => Err(error),
        }
    }

    /// Removes the key from the keychain, then the file. A keychain that cannot be reached
    /// keeps both.
    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        if key != DSK {
            return self.keychain.delete(key);
        }
        let mut cache = self.cache();
        *cache = None;
        self.keychain.delete(DSK)?;
        match fs::remove_file(self.legacy_path()) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(failed(format!(
                "`device-key` could not be removed: {error}"
            ))),
        }
    }

    fn clear(&self) -> Result<(), SecureStoreError> {
        let device = self.delete(DSK);
        let rest = self.keychain.clear();
        device.and(rest)
    }
}
