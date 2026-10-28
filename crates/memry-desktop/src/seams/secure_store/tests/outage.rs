//! Outages: the latch lifts, a skipped job is cheap, and "absent" is never an unreadable item.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use keyring_core::Error;
use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};

use super::fake::{Gate, Mode, rig, rig_with};
use super::{no_storage, recovery_counter, wait_for};
use crate::seams::secure_store::SecureStoreHealth;

#[test]
fn a_call_that_finishes_at_its_deadline_never_leaves_the_latch_set() {
    // The worker finishes while the caller's timer fires. The caller used to latch after the
    // worker had cleared the latch, so every later call answered `Locked` for good.
    let deadline = Duration::from_millis(5);
    let rig = rig_with(None, deadline, false);
    for round in 0..400_u64 {
        let pause = deadline + Duration::from_micros(round % 5 * 200) - Duration::from_micros(400);
        rig.fake.set_mode(Mode::Sleep(pause));
        let _ = rig.store.get(SecureStoreKey::MasterKey);
        rig.fake.set_mode(Mode::Normal);
        wait_for(&format!("the keychain to answer (round {round})"), || {
            rig.store.get(SecureStoreKey::MasterKey) == Ok(None)
        });
    }
    assert_eq!(rig.store.health(), SecureStoreHealth::Ready);
}

#[test]
fn a_read_nobody_waits_for_is_not_run_but_one_somebody_waits_for_is() {
    // One deadline serves every caller, so the order is set by it: the joiner arrives half a
    // deadline after the orphan, before the stuck call latches (one deadline after it began)
    // and with half a deadline left when the gate opens. The halves are a second each, so a
    // slow runner cannot reorder them (at 200 ms the joiner once arrived after the latch).
    let deadline = Duration::from_secs(2);
    let rig = rig_with(None, deadline, false);
    let gate = Arc::new(Gate::default());
    rig.fake.set_mode(Mode::Block(gate.clone()));
    let stuck = {
        let store = rig.store.clone();
        std::thread::spawn(move || store.set(SecureStoreKey::AccessToken, vec![1; 32]))
    };
    gate.wait_entered(1);
    let orphan = {
        let store = rig.store.clone();
        std::thread::spawn(move || store.get(SecureStoreKey::MasterKey))
    };
    std::thread::sleep(deadline / 2);
    let joiner = {
        let store = rig.store.clone();
        std::thread::spawn(move || store.get(SecureStoreKey::MasterKey))
    };
    assert_eq!(stuck.join().unwrap(), Err(SecureStoreError::Locked));
    assert_eq!(orphan.join().unwrap(), Err(SecureStoreError::Locked));
    // The first reader gave up, the second still waits: the read runs once, for the second.
    rig.fake.set_mode(Mode::Normal);
    gate.release();
    assert_eq!(joiner.join().unwrap(), Ok(None));
    assert_eq!(rig.fake.reads.load(Ordering::SeqCst), 1);
    wait_for("the latch to lift", || {
        rig.store.health() == SecureStoreHealth::Ready
    });

    // Nobody waits for this one: it never reaches the keychain, and the latch still lifts.
    let gate = Arc::new(Gate::default());
    rig.fake.set_mode(Mode::Block(gate.clone()));
    let stuck = {
        let store = rig.store.clone();
        std::thread::spawn(move || store.set(SecureStoreKey::AccessToken, vec![1; 32]))
    };
    gate.wait_entered(1);
    let orphan = {
        let store = rig.store.clone();
        std::thread::spawn(move || store.get(SecureStoreKey::RefreshToken))
    };
    assert_eq!(stuck.join().unwrap(), Err(SecureStoreError::Locked));
    assert_eq!(orphan.join().unwrap(), Err(SecureStoreError::Locked));
    let reads = rig.fake.reads.load(Ordering::SeqCst);
    rig.fake.set_mode(Mode::Normal);
    gate.release();
    wait_for("the latch to lift", || {
        rig.store.get(SecureStoreKey::SetupToken) == Ok(None)
    });
    assert_eq!(
        rig.fake.reads.load(Ordering::SeqCst),
        reads + 1,
        "only the new read reached the keychain"
    );
}

#[test]
fn a_failed_or_panicking_answer_after_an_outage_is_not_a_recovery() {
    let rig = rig();
    let fired = recovery_counter(&rig.store);
    rig.fake.set_mode(Mode::Fail(no_storage));
    assert_eq!(
        rig.store.get(SecureStoreKey::MasterKey),
        Err(SecureStoreError::Locked)
    );
    for mode in [
        Mode::Fail(|| Error::TooLong("blob".to_owned(), 2560)),
        Mode::Panic,
    ] {
        rig.fake.set_mode(mode);
        assert!(matches!(
            rig.store.get(SecureStoreKey::MasterKey),
            Err(SecureStoreError::Failed { .. })
        ));
    }
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(fired.load(Ordering::SeqCst), 0);
    rig.fake.set_mode(Mode::Normal);
    assert_eq!(rig.store.get(SecureStoreKey::MasterKey).unwrap(), None);
    wait_for("the recovery listener", || {
        fired.load(Ordering::SeqCst) == 1
    });
}

#[test]
fn an_entry_the_store_did_not_find_is_absent_only_when_the_platform_agrees() {
    let rig = rig();
    // The item may exist but cannot be seen (a locked collection): never "absent", and a delete
    // never reports success over it.
    *rig.hidden.lock().unwrap() = Some(no_storage);
    assert_eq!(
        rig.store.get(SecureStoreKey::MasterKey),
        Err(SecureStoreError::Locked)
    );
    assert_eq!(
        rig.store.delete(SecureStoreKey::MasterKey),
        Err(SecureStoreError::Locked)
    );
    assert_eq!(rig.store.health(), SecureStoreHealth::Unavailable);
    *rig.hidden.lock().unwrap() = None;
    assert_eq!(rig.store.get(SecureStoreKey::MasterKey).unwrap(), None);
    rig.store.delete(SecureStoreKey::MasterKey).unwrap();
    // An item the store did find is not second-guessed.
    *rig.hidden.lock().unwrap() = Some(no_storage);
    rig.store
        .set(SecureStoreKey::MasterKey, vec![9; 32])
        .unwrap();
    assert_eq!(
        rig.store.get(SecureStoreKey::MasterKey).unwrap(),
        Some(vec![9; 32])
    );
    rig.store.delete(SecureStoreKey::MasterKey).unwrap();
}

#[cfg(feature = "e2e")]
#[test]
fn an_open_e2e_gate_keeps_its_secrets_in_a_file_that_survives_a_restart() {
    use crate::e2e::{E2E_VAR, E2eGate};
    use crate::launch_env::LaunchEnv;
    use crate::seams::secure_store::{GenericSecrets, KeyringStore};

    let dir = tempfile::tempdir().unwrap();
    let mut env = LaunchEnv::default();
    env.set(E2E_VAR, "1");
    let open = || {
        KeyringStore::new(
            Some("e2e-file-test".to_owned()),
            E2eGate::from_env(&env),
            dir.path(),
        )
    };
    let first = open();
    assert_eq!(first.get(SecureStoreKey::MasterKey).unwrap(), None);
    first.set(SecureStoreKey::MasterKey, vec![3; 32]).unwrap();
    first
        .set_secret("com.memrynote.memry.test", "a", b"raw")
        .unwrap();
    drop(first);

    let restarted = open();
    assert_eq!(
        restarted.get(SecureStoreKey::MasterKey).unwrap(),
        Some(vec![3; 32])
    );
    assert_eq!(
        restarted
            .get_secret("com.memrynote.memry.test", "a")
            .unwrap(),
        Some(b"raw".to_vec())
    );
    restarted.delete(SecureStoreKey::MasterKey).unwrap();
    assert_eq!(open().get(SecureStoreKey::MasterKey).unwrap(), None);
}
