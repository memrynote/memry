//! The device key moves from the file of earlier builds into the keychain, never mints over a
//! key that may exist, and converges from the state any crash leaves behind. Each test runs the
//! real keychain worker over the fake credential store and real files in a temp dir.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};

use super::fake::{Mode, Rig, rig};
use super::no_storage;
use crate::seams::secure_store::DeviceIdentityStore;

const DSK: SecureStoreKey = SecureStoreKey::DeviceSigningKey;
const ACCOUNT: &str = "device-signing-key";

fn key(byte: u8) -> Vec<u8> {
    vec![byte; 64]
}

struct World {
    rig: Rig,
    dir: tempfile::TempDir,
    no_keychain: Arc<AtomicBool>,
}

fn world() -> World {
    World {
        rig: rig(),
        dir: tempfile::tempdir().unwrap(),
        no_keychain: Arc::default(),
    }
}

impl World {
    /// A new store over the same keychain and profile, as after a restart.
    fn store(&self) -> DeviceIdentityStore {
        let probe = self.no_keychain.clone();
        DeviceIdentityStore::with_probe(self.rig.store.clone(), self.dir.path(), move || {
            probe.load(Ordering::SeqCst)
        })
    }

    fn legacy(&self) -> PathBuf {
        self.dir.path().join("device-key")
    }

    fn marker(&self) -> PathBuf {
        self.dir.path().join("device-key.location")
    }

    fn write_legacy(&self, bytes: &[u8]) {
        std::fs::write(self.legacy(), bytes).unwrap();
    }

    fn mark(&self) {
        std::fs::write(self.marker(), b"keychain\n").unwrap();
    }

    fn put_keychain(&self, bytes: &[u8]) {
        self.rig
            .fake
            .put("com.memry.sync", ACCOUNT, STANDARD.encode(bytes).as_bytes());
    }

    fn keychain(&self) -> Option<Vec<u8>> {
        self.rig
            .fake
            .stored("com.memry.sync", ACCOUNT)
            .map(|text| STANDARD.decode(text).unwrap())
    }

    fn legacy_bytes(&self) -> Option<Vec<u8>> {
        std::fs::read(self.legacy()).ok()
    }

    fn keychain_down(&self) {
        self.rig.fake.set_mode(Mode::Fail(no_storage));
    }

    fn keychain_up(&self) {
        self.rig.fake.set_mode(Mode::Normal);
    }
}

fn exists(path: &Path) -> bool {
    path.exists()
}

#[test]
fn the_key_of_an_earlier_build_moves_into_the_keychain_and_stays_there() {
    let w = world();
    w.write_legacy(&key(1));
    assert_eq!(w.store().get(DSK).unwrap(), Some(key(1)));
    assert_eq!(w.keychain(), Some(key(1)));
    assert!(!exists(&w.legacy()), "the plaintext file is gone");
    assert!(exists(&w.marker()));
    assert_eq!(w.store().get(DSK).unwrap(), Some(key(1)), "after a restart");
}

#[test]
fn a_crash_after_the_keychain_write_converges_on_the_same_key() {
    // Killed after the keychain write (or a write that timed out and landed later).
    let w = world();
    w.write_legacy(&key(1));
    w.put_keychain(&key(1));
    assert_eq!(w.store().get(DSK).unwrap(), Some(key(1)));
    assert!(!exists(&w.legacy()));
    assert!(exists(&w.marker()));
}

#[test]
fn a_crash_after_the_marker_converges_on_the_same_key() {
    let w = world();
    w.write_legacy(&key(1));
    w.put_keychain(&key(1));
    w.mark();
    assert_eq!(w.store().get(DSK).unwrap(), Some(key(1)));
    assert!(!exists(&w.legacy()));
}

#[test]
fn a_crash_after_the_file_was_removed_converges_on_the_same_key() {
    let w = world();
    w.put_keychain(&key(1));
    w.mark();
    assert_eq!(w.store().get(DSK).unwrap(), Some(key(1)));
}

#[test]
fn a_different_key_in_the_keychain_wins_and_the_file_is_kept() {
    let w = world();
    w.write_legacy(&key(1));
    w.put_keychain(&key(2));
    assert_eq!(w.store().get(DSK).unwrap(), Some(key(2)));
    assert_eq!(
        w.legacy_bytes(),
        Some(key(1)),
        "a key that differs is never deleted"
    );
}

#[test]
fn a_locked_keychain_serves_the_file_and_moves_it_once_the_keychain_answers() {
    let w = world();
    w.write_legacy(&key(1));
    w.keychain_down();
    let store = w.store();
    assert_eq!(store.get(DSK).unwrap(), Some(key(1)));
    assert_eq!(w.legacy_bytes(), Some(key(1)));
    assert!(!exists(&w.marker()));
    w.keychain_up();
    assert_eq!(store.get(DSK).unwrap(), Some(key(1)));
    assert_eq!(w.keychain(), Some(key(1)));
    assert!(!exists(&w.legacy()));
}

#[test]
fn a_locked_keychain_with_no_file_is_locked_and_nothing_is_minted() {
    let w = world();
    w.keychain_down();
    let store: Arc<dyn SecureStore> = Arc::new(w.store());
    assert_eq!(store.get(DSK), Err(SecureStoreError::Locked));
    assert!(ensure_device_identity(store.clone()).is_err());
    assert!(!exists(&w.legacy()), "no key is written to a file");
    w.keychain_up();
    assert_eq!(store.get(DSK).unwrap(), None);
}

#[test]
fn once_the_key_lived_in_the_keychain_a_file_is_never_used() {
    let w = world();
    w.mark();
    w.write_legacy(&key(1));
    w.keychain_down();
    w.no_keychain.store(true, Ordering::SeqCst);
    let store = w.store();
    assert_eq!(store.get(DSK), Err(SecureStoreError::Locked));
    assert_eq!(store.set(DSK, key(3)), Err(SecureStoreError::Locked));
    assert_eq!(w.legacy_bytes(), Some(key(1)));
    w.keychain_up();
    assert_eq!(
        store.get(DSK).unwrap(),
        None,
        "the file is not migrated either"
    );
}

#[test]
fn with_no_keychain_on_the_system_the_key_lives_in_the_file_until_one_appears() {
    let w = world();
    w.keychain_down();
    w.no_keychain.store(true, Ordering::SeqCst);
    let store: Arc<dyn SecureStore> = Arc::new(w.store());
    ensure_device_identity(store.clone()).unwrap();
    let minted = w.legacy_bytes().expect("the key is in the file");
    assert_eq!(minted.len(), 64);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(w.legacy()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    assert_eq!(store.get(DSK).unwrap(), Some(minted.clone()));
    w.keychain_up();
    w.no_keychain.store(false, Ordering::SeqCst);
    assert_eq!(store.get(DSK).unwrap(), Some(minted.clone()));
    assert_eq!(w.keychain(), Some(minted));
    assert!(!exists(&w.legacy()));
}

#[test]
fn a_key_of_the_wrong_length_is_failed_never_absent() {
    let w = world();
    w.write_legacy(&[1; 10]);
    assert!(matches!(
        w.store().get(DSK),
        Err(SecureStoreError::Failed { .. })
    ));
    assert_eq!(w.legacy_bytes(), Some(vec![1; 10]));
    let w = world();
    w.put_keychain(&[2; 32]);
    assert!(matches!(
        w.store().get(DSK),
        Err(SecureStoreError::Failed { .. })
    ));
}

#[test]
fn a_fresh_profile_mints_into_the_keychain_and_keeps_the_key_while_it_locks() {
    let w = world();
    let store: Arc<dyn SecureStore> = Arc::new(w.store());
    ensure_device_identity(store.clone()).unwrap();
    let minted = w.keychain().expect("minted into the keychain");
    assert!(!exists(&w.legacy()));
    assert!(exists(&w.marker()));
    w.keychain_down();
    assert_eq!(store.get(DSK).unwrap(), Some(minted));
    assert_eq!(
        store.get(SecureStoreKey::MasterKey),
        Err(SecureStoreError::Locked),
        "other keys go to the keychain"
    );
}

#[test]
fn deleting_the_key_removes_it_everywhere() {
    let w = world();
    w.write_legacy(&key(1));
    w.put_keychain(&key(1));
    w.mark();
    let store = w.store();
    assert_eq!(store.get(DSK).unwrap(), Some(key(1)));
    w.write_legacy(&key(1));
    store.delete(DSK).unwrap();
    assert_eq!(w.keychain(), None);
    assert!(!exists(&w.legacy()));
    assert_eq!(store.get(DSK).unwrap(), None);
}
