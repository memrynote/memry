//! The device key moves from the file of earlier builds into the keychain, never mints over a
//! key that may exist, and converges from the state any crash leaves behind. Each test runs the
//! real keychain worker over the fake credential store and real files in a temp dir.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use keyring_core::Error;
use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};

use super::fake::{Mode, Rig, rig};
use super::no_storage;
use crate::seams::secure_store::DeviceIdentityStore;

const DSK: SecureStoreKey = SecureStoreKey::DeviceSigningKey;
const ACCOUNT: &str = "device-signing-key";
/// This app's own namespace for the key.
const OWN: &str = "com.memrynote.memry";
/// Electron's, which Electron moves into its own file and deletes.
const ELECTRON: &str = "com.memry.sync";

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
        DeviceIdentityStore::with_probe(&self.rig.store, self.dir.path(), move || {
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
        self.rig.fake.put(OWN, ACCOUNT, bytes);
    }

    fn keychain(&self) -> Option<Vec<u8>> {
        self.rig.fake.stored(OWN, ACCOUNT)
    }

    fn put_electron(&self, bytes: &[u8]) {
        self.rig
            .fake
            .put(ELECTRON, ACCOUNT, STANDARD.encode(bytes).as_bytes());
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
fn once_the_key_moved_a_locked_keychain_is_locked_even_with_a_file() {
    let w = world();
    w.mark();
    w.write_legacy(&key(1));
    w.keychain_down();
    w.no_keychain.store(true, Ordering::SeqCst);
    let store = w.store();
    assert_eq!(store.get(DSK), Err(SecureStoreError::Locked));
    assert_eq!(store.set(DSK, key(3)), Err(SecureStoreError::Locked));
    assert_eq!(w.legacy_bytes(), Some(key(1)));
}

#[test]
fn once_the_key_moved_an_empty_keychain_takes_the_file_back_never_a_new_key() {
    let w = world();
    w.mark();
    w.write_legacy(&key(1));
    assert_eq!(w.store().get(DSK).unwrap(), Some(key(1)));
    assert_eq!(w.keychain(), Some(key(1)));
    assert!(!exists(&w.legacy()));
}

#[test]
fn once_the_key_moved_an_empty_keychain_is_failed_never_absent() {
    let w = world();
    w.mark();
    let store: Arc<dyn SecureStore> = Arc::new(w.store());
    let Err(SecureStoreError::Failed { what }) = store.get(DSK) else {
        panic!("a key that moved and is gone is Failed");
    };
    assert!(what.contains("missing"), "{what}");
    assert!(ensure_device_identity(store).is_err());
    assert_eq!(w.keychain(), None, "nothing is minted");
}

#[test]
fn electron_moving_its_keychain_item_never_changes_this_device_s_identity() {
    // Electron keeps the device key in its own file and deletes the `com.memry.sync` item; an
    // Electron run whose file is unreadable reads that item back. Neither may reach this key.
    let w = world();
    w.put_electron(&key(9));
    let store: Arc<dyn SecureStore> = Arc::new(w.store());
    ensure_device_identity(store.clone()).unwrap();
    let mine = w.keychain().expect("minted in this app's namespace");
    assert_ne!(
        mine,
        key(9),
        "Electron's identity is adopted only by the Step 37 import"
    );
    assert!(
        w.rig.fake.stored(ELECTRON, ACCOUNT).is_some(),
        "Electron's item is untouched"
    );
    w.rig
        .fake
        .data
        .lock()
        .unwrap()
        .remove(&(ELECTRON.to_owned(), ACCOUNT.to_owned()));
    assert_eq!(
        w.store().get(DSK).unwrap(),
        Some(mine.clone()),
        "after a restart"
    );
    w.put_electron(&key(8));
    assert_eq!(w.store().get(DSK).unwrap(), Some(mine));
}

#[test]
fn a_refused_move_write_serves_the_file_and_keeps_it() {
    let w = world();
    w.write_legacy(&key(1));
    *w.rig.fake.fail_writes.lock().unwrap() = Some(|| Error::TooLong("blob".to_owned(), 10));
    assert_eq!(w.store().get(DSK).unwrap(), Some(key(1)));
    assert_eq!(w.legacy_bytes(), Some(key(1)));
    assert!(!exists(&w.marker()));
}

#[test]
fn a_move_the_keychain_refused_for_good_is_not_tried_again_this_run() {
    let w = world();
    w.write_legacy(&key(1));
    *w.rig.fake.fail_writes.lock().unwrap() = Some(|| Error::TooLong("blob".to_owned(), 10));
    let store = w.store();
    for _ in 0..3 {
        assert_eq!(store.get(DSK).unwrap(), Some(key(1)));
    }
    assert_eq!(w.rig.fake.writes.load(Ordering::SeqCst), 1);
}

#[test]
fn a_delete_with_a_stale_no_keychain_answer_never_drops_a_moved_key() {
    // The probe said "no keychain" earlier; the key has since moved into a keychain that is now
    // locked. The delete cannot reach it, so it fails, and nothing a later read could mint over
    // is removed.
    let w = world();
    w.put_keychain(&key(1));
    w.mark();
    w.keychain_down();
    w.no_keychain.store(true, Ordering::SeqCst);
    let store: Arc<dyn SecureStore> = Arc::new(w.store());
    assert_eq!(store.delete(DSK), Err(SecureStoreError::Locked));
    assert!(exists(&w.marker()));
    assert!(
        ensure_device_identity(store.clone()).is_err(),
        "nothing is minted"
    );
    w.keychain_up();
    assert_eq!(store.get(DSK).unwrap(), Some(key(1)));
}

#[test]
fn the_identity_namespaces_are_closed_to_generic_secrets() {
    use crate::seams::secure_store::GenericSecrets;
    let w = world();
    for service in [OWN, ELECTRON] {
        let denied =
            |r: Result<(), SecureStoreError>| matches!(r, Err(SecureStoreError::Denied { .. }));
        assert!(matches!(
            w.rig.store.get_secret(service, ACCOUNT),
            Err(SecureStoreError::Denied { .. })
        ));
        assert!(denied(w.rig.store.set_secret(service, ACCOUNT, &key(1))));
        assert!(denied(w.rig.store.delete_secret(service, ACCOUNT)));
    }
    assert_eq!(w.keychain(), None);
}

#[test]
fn with_no_keychain_on_the_system_delete_removes_the_file() {
    let w = world();
    w.keychain_down();
    w.no_keychain.store(true, Ordering::SeqCst);
    let store: Arc<dyn SecureStore> = Arc::new(w.store());
    ensure_device_identity(store.clone()).unwrap();
    assert!(exists(&w.legacy()));
    store.delete(DSK).unwrap();
    assert!(!exists(&w.legacy()));
    assert_eq!(store.get(DSK).unwrap(), None);
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
