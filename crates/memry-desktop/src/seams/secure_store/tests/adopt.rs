//! `DeviceIdentityStore::adopt_electron`, the Step 37 import's one way to take Electron's key.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};

use super::fake::{Mode, Rig, rig};
use super::no_storage;
use crate::seams::secure_store::{AdoptError, Adoption, DeviceIdentityStore};

const DSK: SecureStoreKey = SecureStoreKey::DeviceSigningKey;
const OWN: &str = "com.memrynote.memry";
const ELECTRON: &str = "com.memry.sync";
const ACCOUNT: &str = "device-signing-key";

fn key(byte: u8) -> Vec<u8> {
    vec![byte; 64]
}

struct World {
    rig: Rig,
    dir: tempfile::TempDir,
}

fn world() -> World {
    let w = World {
        rig: rig(),
        dir: tempfile::tempdir().unwrap(),
    };
    w.rig
        .fake
        .put(ELECTRON, ACCOUNT, STANDARD.encode(key(9)).as_bytes());
    w
}

impl World {
    fn store(&self) -> DeviceIdentityStore {
        DeviceIdentityStore::with_probe(&self.rig.store, self.dir.path(), || false)
    }

    fn keychain(&self) -> Option<Vec<u8>> {
        self.rig.fake.stored(OWN, ACCOUNT)
    }

    fn marker(&self) -> PathBuf {
        self.dir.path().join("device-key.location")
    }

    fn electron_untouched(&self) {
        assert_eq!(
            self.rig.fake.stored(ELECTRON, ACCOUNT),
            Some(STANDARD.encode(key(9)).into_bytes())
        );
    }
}

#[test]
fn a_fresh_profile_adopts_the_key_and_a_restart_reads_it() {
    let w = world();
    assert_eq!(w.store().adopt_electron(&key(9)), Ok(Adoption::Adopted));
    assert_eq!(w.keychain(), Some(key(9)));
    assert!(w.marker().exists());
    assert_eq!(w.store().get(DSK).unwrap(), Some(key(9)));
    w.electron_untouched();
}

#[test]
fn adopting_the_key_already_held_writes_nothing() {
    let w = world();
    w.store().adopt_electron(&key(9)).unwrap();
    let writes = w.rig.fake.writes.load(Ordering::SeqCst);
    let store = w.store();
    assert_eq!(store.adopt_electron(&key(9)), Ok(Adoption::AlreadyHeld));
    assert_eq!(store.adopt_electron(&key(9)), Ok(Adoption::AlreadyHeld));
    assert_eq!(w.rig.fake.writes.load(Ordering::SeqCst), writes);
}

#[test]
fn a_crash_between_the_write_and_the_marker_converges() {
    let w = world();
    w.rig.fake.put(OWN, ACCOUNT, &key(9));
    assert_eq!(w.store().adopt_electron(&key(9)), Ok(Adoption::AlreadyHeld));
    assert!(w.marker().exists());
}

#[test]
fn a_profile_holding_its_own_key_keeps_it() {
    let w = world();
    w.rig.fake.put(OWN, ACCOUNT, &key(5));
    assert_eq!(w.store().adopt_electron(&key(9)), Err(AdoptError::Taken));
    assert_eq!(w.keychain(), Some(key(5)));
    w.electron_untouched();
}

#[test]
fn a_profile_whose_key_is_in_its_old_file_keeps_it() {
    let w = world();
    std::fs::write(w.dir.path().join("device-key"), key(5)).unwrap();
    assert_eq!(w.store().adopt_electron(&key(9)), Err(AdoptError::Taken));
    assert_eq!(w.keychain(), None);
    assert_eq!(
        std::fs::read(w.dir.path().join("device-key")).unwrap(),
        key(5)
    );
}

#[test]
fn a_profile_whose_moved_key_went_missing_is_not_given_another() {
    let w = world();
    std::fs::write(w.marker(), b"keychain\n").unwrap();
    assert_eq!(w.store().adopt_electron(&key(9)), Err(AdoptError::Taken));
    assert_eq!(w.keychain(), None);
}

#[test]
fn a_profile_that_minted_and_served_a_key_this_run_keeps_it() {
    let w = world();
    let store = Arc::new(w.store());
    let shared: Arc<dyn SecureStore> = store.clone();
    ensure_device_identity(shared).unwrap();
    let minted = w.keychain().unwrap();
    assert_eq!(store.adopt_electron(&key(9)), Err(AdoptError::Taken));
    w.rig.fake.set_mode(Mode::Fail(no_storage));
    assert_eq!(
        store.adopt_electron(&key(9)),
        Err(AdoptError::Taken),
        "the key it served decides, with the keychain locked"
    );
    w.rig.fake.set_mode(Mode::Normal);
    assert_eq!(w.keychain(), Some(minted));
}

#[test]
fn a_locked_keychain_writes_nothing() {
    let w = world();
    w.rig.fake.set_mode(Mode::Fail(no_storage));
    assert_eq!(
        w.store().adopt_electron(&key(9)),
        Err(AdoptError::Store(SecureStoreError::Locked))
    );
    w.rig.fake.set_mode(Mode::Normal);
    assert_eq!(w.keychain(), None);
    assert!(!w.marker().exists());
}

#[test]
fn a_refused_write_leaves_no_marker() {
    let w = world();
    *w.rig.fake.fail_writes.lock().unwrap() = Some(no_storage);
    assert!(w.store().adopt_electron(&key(9)).is_err());
    *w.rig.fake.fail_writes.lock().unwrap() = None;
    assert_eq!(w.keychain(), None);
    assert!(!w.marker().exists());
    assert_eq!(w.store().adopt_electron(&key(9)), Ok(Adoption::Adopted));
}

#[test]
fn a_key_of_the_wrong_length_is_refused_before_the_keychain() {
    let w = world();
    assert!(matches!(
        w.store().adopt_electron(&[1; 32]),
        Err(AdoptError::Store(SecureStoreError::Failed { .. }))
    ));
    assert_eq!(w.rig.fake.reads.load(Ordering::SeqCst), 0);
}

#[test]
fn adoptable_answers_as_the_adoption_would_and_writes_nothing() {
    let w = world();
    let writes = w.rig.fake.writes.load(Ordering::SeqCst);
    assert_eq!(w.store().adoptable(&key(9)), Ok(Adoption::Adopted));
    assert_eq!(w.keychain(), None);
    assert!(!w.marker().exists());
    assert_eq!(w.rig.fake.writes.load(Ordering::SeqCst), writes);

    w.store().adopt_electron(&key(9)).unwrap();
    assert_eq!(w.store().adoptable(&key(9)), Ok(Adoption::AlreadyHeld));
    assert_eq!(w.store().adoptable(&key(8)), Err(AdoptError::Taken));
    w.electron_untouched();
}
