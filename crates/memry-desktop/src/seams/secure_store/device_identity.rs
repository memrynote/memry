//! The device signing key, in this app's own keychain namespace, moved there once from the file
//! of earlier builds. Every device-key operation of the app goes through this store:
//! [`KeyringStore`] refuses the key.
//!
//! Settings clocks name this device by the id derived from its signing key, and the core reads
//! the key on every writer it builds (`Tasks::over`, `NotesWriter`, journal, canvas, inbox,
//! calendar, `AppSettings::over`). Builds before Step 15 kept the key in `<profile>/device-key`
//! (64 bytes, mode 0600). Minting a new key instead of moving that one would leave every clock
//! written so far naming a device that no longer exists, so this store moves the key and never
//! mints over one that may exist.
//!
//! **Namespace.** The key lives under [`IDENTITY_SERVICE`] (raw bytes), not Electron's
//! `com.memry.sync/device-signing-key`. Electron moves that item into its own encrypted file
//! (`secure-secrets.json`) and deletes it, and reads it back when the file is unreadable, so a key
//! shared there could be deleted under this app or taken over by an Electron run. A profile that
//! has never held a key here mints its own, even when Electron holds an identity on the same
//! machine: Step 37 (#3554) adopts Electron's identity explicitly, before a migrated profile
//! writes anything. Until then only dev and internal builds run, and the clocks they write name
//! this app's own device.
//!
//! **Move.** Keychain write, read back and compare, marker `<profile>/device-key.location`, then
//! the file is removed. Every crash point leaves a state the next read finishes: the keychain and
//! the file hold the same key, so the file is removed (with or without the marker). A keychain
//! key that differs from the file wins, and the file is kept: a key that differs is never deleted.
//! A keychain that refuses the write leaves the file serving the key, and the move is tried again
//! on the next read.
//!
//! **Marker.** Written once the key is known to be in the keychain. From then on the key is never
//! minted: an empty keychain takes a file still on disk back, and with no file the answer is
//! `Failed` ("missing"), so a key deleted outside this app is reported, not replaced. A locked
//! keychain is `Locked`, never the file: a file kept beside a different keychain key would be the
//! wrong identity.
//!
//! **Locked keychain, no marker.** With a file, the file serves the key (it is on disk either way)
//! and the move is tried again on the next read. With no file it is `Locked`, so the core never
//! mints over a key it could not read: an unanswered macOS access prompt is the common case.
//!
//! **No keychain on the system** (Linux with no Secret Service running or activatable, and no
//! marker): the file holds the key, so the app can still write locally, as Electron could. Sign-in
//! is impossible without a keychain, so that key is not registered while it lives in the file;
//! the first read after a keychain appears moves it.
//!
//! **Cache.** A key read from or written to the keychain is kept in memory (zeroized on drop), so
//! a keychain that locks later does not stop writes. A key served from the file is not cached,
//! so the move is retried. Cached reads never wait behind a keychain call.
//!
//! **Delete** removes the marker, then the file, then the keychain item: a crash in between leaves
//! either the key in the keychain (found again, marked again) or nothing, never a file that a
//! later read would move back. On a system with no keychain, removing the file is the delete.
//!
//! The first read of a launch waits for the keychain (at most its 5 s deadline, then `Locked`),
//! and that read happens before the first paint (`startup_state` reads the general settings).

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use zeroize::Zeroizing;

use super::{GenericSecrets, IDENTITY_SERVICE, KeyringStore};
use crate::vault::fs_atomic::atomic_write;

const DSK: SecureStoreKey = SecureStoreKey::DeviceSigningKey;
/// The file of the builds before Step 15 (`profile_store.rs`, removed).
const LEGACY_FILE: &str = "device-key";
const MARKER_FILE: &str = "device-key.location";
const MARKER: &[u8] = b"keychain\n";
/// A libsodium Ed25519 secret key, the shape Electron and the core both store.
const KEY_LEN: usize = 64;
const MISSING: &str = "the device key is missing from the keychain after it moved there; \
     a new one is not minted, so this device keeps its identity once the key is restored";

type Key = Zeroizing<Vec<u8>>;
type Probe = Box<dyn Fn() -> bool + Send + Sync>;

enum Legacy {
    Absent,
    Key(Key),
    Unusable(String),
}

pub struct DeviceIdentityStore {
    keyring: Arc<KeyringStore>,
    account: String,
    keychain_absent: Probe,
    dir: PathBuf,
    /// The key read from or written to the keychain.
    cache: Mutex<Option<Key>>,
    /// Serializes the device key's keychain and file work, so two first reads never move the
    /// file at once. Never held by a cached read.
    work: Mutex<()>,
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

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn remove(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

impl DeviceIdentityStore {
    /// `data_dir` is the profile directory that held `device-key`.
    pub fn new(keyring: Arc<KeyringStore>, data_dir: &Path) -> Self {
        Self::with_probe(&keyring, data_dir, super::keychain_absent)
    }

    /// A store with a chosen "no keychain on this system" answer. For tests.
    #[doc(hidden)]
    pub fn with_probe(
        keyring: &Arc<KeyringStore>,
        data_dir: &Path,
        keychain_absent: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Self {
        Self {
            account: keyring.identity_account(),
            keyring: keyring.clone(),
            keychain_absent: Box::new(keychain_absent),
            dir: data_dir.to_owned(),
            cache: Mutex::new(None),
            work: Mutex::new(()),
        }
    }

    fn keychain_get(&self) -> Result<Option<Key>, SecureStoreError> {
        self.keyring
            .get_secret(IDENTITY_SERVICE, &self.account)?
            .map(|key| checked(key, "keychain"))
            .transpose()
    }

    fn keychain_set(&self, key: &[u8]) -> Result<(), SecureStoreError> {
        self.keyring
            .set_secret(IDENTITY_SERVICE, &self.account, key)
    }

    fn legacy_path(&self) -> PathBuf {
        self.dir.join(LEGACY_FILE)
    }

    fn marker_path(&self) -> PathBuf {
        self.dir.join(MARKER_FILE)
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

    /// An unreadable marker counts as present: nothing is then minted.
    fn marked(&self) -> bool {
        match fs::metadata(self.marker_path()) {
            Ok(_) => true,
            Err(error) => error.kind() != ErrorKind::NotFound,
        }
    }

    fn mark(&self) -> Result<(), SecureStoreError> {
        if self.marked() {
            return Ok(());
        }
        atomic_write(&self.marker_path(), MARKER).map_err(|error| {
            failed(format!(
                "the device key marker could not be written: {}",
                error.source
            ))
        })
    }

    /// The keychain holds `key`: mark it, then drop a file that holds the same key.
    fn settle(&self, key: &Key) {
        if let Err(error) = self.mark() {
            tracing::warn!(scope = "DeviceIdentity", "{error}; `device-key` is kept");
            return;
        }
        match self.legacy() {
            Legacy::Key(file) if file == *key => match remove(&self.legacy_path()) {
                Ok(()) => tracing::info!(
                    scope = "DeviceIdentity",
                    "the device key now lives only in the keychain; removed `device-key`"
                ),
                Err(error) => tracing::warn!(
                    scope = "DeviceIdentity",
                    "the device key is in the keychain, but `device-key` could not be removed: {error}"
                ),
            },
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

    /// Copies the file's key into the keychain and removes the file once it reads back. Whatever
    /// keeps the keychain from taking it, the file keeps serving the key.
    fn migrate(&self, key: Key) -> Result<(Key, bool), SecureStoreError> {
        if let Err(error) = self.keychain_set(&key) {
            // A write that timed out may still land; the next read finds it equal and settles.
            tracing::warn!(
                scope = "DeviceIdentity",
                "the device key could not move into the keychain yet ({error}); `device-key` keeps it"
            );
            return Ok((key, false));
        }
        match self.keychain_get() {
            Ok(Some(back)) if back == key => {
                self.settle(&key);
                Ok((key, self.marked()))
            }
            Ok(_) => Err(failed(
                "the device key written to the keychain did not read back; `device-key` is kept",
            )),
            Err(error) => {
                tracing::warn!(
                    scope = "DeviceIdentity",
                    "the moved device key could not be read back yet ({error}); `device-key` keeps it"
                );
                Ok((key, false))
            }
        }
    }

    /// The key and whether it may be cached (it is known to be in the keychain).
    fn read(&self) -> Result<Option<(Key, bool)>, SecureStoreError> {
        match self.keychain_get() {
            Ok(Some(key)) => {
                self.settle(&key);
                Ok(Some((key, true)))
            }
            Ok(None) => match self.legacy() {
                Legacy::Key(key) => self.migrate(key).map(Some),
                Legacy::Absent if self.marked() => Err(failed(MISSING)),
                Legacy::Absent => Ok(None),
                Legacy::Unusable(what) => Err(failed(what)),
            },
            Err(SecureStoreError::Locked) if self.marked() => Err(SecureStoreError::Locked),
            Err(SecureStoreError::Locked) => match self.legacy() {
                Legacy::Key(key) => Ok(Some((key, false))),
                Legacy::Absent if (self.keychain_absent)() => Ok(None),
                Legacy::Absent => Err(SecureStoreError::Locked),
                Legacy::Unusable(what) => Err(failed(what)),
            },
            Err(error) => Err(error),
        }
    }

    fn cached(&self) -> Option<Key> {
        lock(&self.cache).clone()
    }

    fn remember(&self, key: Option<Key>) {
        *lock(&self.cache) = key;
    }
}

impl SecureStore for DeviceIdentityStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        if key != DSK {
            return self.keyring.get(key);
        }
        if let Some(known) = self.cached() {
            return Ok(Some(known.to_vec()));
        }
        let _work = lock(&self.work);
        if let Some(known) = self.cached() {
            return Ok(Some(known.to_vec()));
        }
        Ok(self.read()?.map(|(key, in_keychain)| {
            if in_keychain {
                self.remember(Some(key.clone()));
            }
            key.to_vec()
        }))
    }

    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        if key != DSK {
            return self.keyring.set(key, value);
        }
        let _work = lock(&self.work);
        let value = Zeroizing::new(value);
        match self.keychain_set(&value) {
            Ok(()) => {
                if let Err(error) = self.mark() {
                    tracing::warn!(scope = "DeviceIdentity", "{error}");
                }
                self.remember(Some(value));
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

    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        if key != DSK {
            return self.keyring.delete(key);
        }
        let _work = lock(&self.work);
        self.remember(None);
        let local = |path: PathBuf, what: &str| {
            remove(&path).map_err(|error| failed(format!("{what} could not be removed: {error}")))
        };
        local(self.marker_path(), "the device key marker")?;
        local(self.legacy_path(), "`device-key`")?;
        match self.keyring.delete_secret(IDENTITY_SERVICE, &self.account) {
            Err(SecureStoreError::Locked) if (self.keychain_absent)() => Ok(()),
            other => other,
        }
    }

    fn clear(&self) -> Result<(), SecureStoreError> {
        let device = self.delete(DSK);
        let rest = self.keyring.clear();
        device.and(rest)
    }
}
