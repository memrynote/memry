use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use keyring_core::Error;
use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};

use super::*;

mod fake;
use fake::{Gate, Mode, rig, rig_with};

const SECRET: &[u8] = b"super-secret-bytes-0123456789abc";

fn no_storage() -> Error {
    Error::NoStorageAccess("denied".into())
}

#[test]
fn an_oversized_stored_value_is_failed_not_decoded() {
    let rig = rig();
    rig.fake.put(
        "com.memry.sync",
        "master-key",
        &vec![b'A'; MAX_STORED_TEXT + 4],
    );
    let Err(SecureStoreError::Failed { what }) = rig.store.get(SecureStoreKey::MasterKey) else {
        panic!("an oversized value is Failed");
    };
    assert!(what.contains("too long"));
    rig.fake
        .put("com.memry.sync", "master-key", &vec![b'A'; MAX_STORED_TEXT]);
    assert!(rig.store.get(SecureStoreKey::MasterKey).is_ok());
}

#[test]
fn the_deadline_is_five_seconds() {
    assert_eq!(DEADLINE, Duration::from_secs(5));
}

#[test]
fn keys_round_trip_as_base64_text_under_the_keytar_accounts() {
    let rig = rig_with(Some("e2e-x"), Duration::from_secs(5), false);
    for (key, account) in [
        (SecureStoreKey::MasterKey, "master-key-e2e-x"),
        (SecureStoreKey::DeviceSigningKey, "device-signing-key-e2e-x"),
        (SecureStoreKey::AccessToken, "access-token-e2e-x"),
        (SecureStoreKey::RefreshToken, "refresh-token-e2e-x"),
        (SecureStoreKey::SetupToken, "setup-token-e2e-x"),
    ] {
        for value in [vec![7_u8; 32], (0..64_u8).collect::<Vec<_>>()] {
            rig.store.set(key, value.clone()).unwrap();
            assert_eq!(rig.store.get(key).unwrap(), Some(value.clone()));
            let stored = rig.fake.stored("com.memry.sync", account).unwrap();
            assert_eq!(stored, STANDARD.encode(&value).into_bytes());
        }
    }
}

#[test]
fn an_item_electron_stored_reads_back_as_its_bytes() {
    let rig = rig();
    rig.fake.put(
        "com.memry.sync",
        "master-key",
        b"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    );
    let expected: Vec<u8> = (0..32).collect();
    assert_eq!(
        rig.store.get(SecureStoreKey::MasterKey).unwrap(),
        Some(expected)
    );
}

#[test]
fn an_absent_entry_is_none_and_deleting_it_is_fine() {
    let rig = rig();
    assert_eq!(rig.store.get(SecureStoreKey::MasterKey).unwrap(), None);
    rig.store.delete(SecureStoreKey::MasterKey).unwrap();
}

#[test]
fn clear_removes_all_five_entries() {
    let rig = rig();
    for key in KEYS {
        rig.store.set(key, vec![1; 32]).unwrap();
    }
    rig.store.clear().unwrap();
    for key in KEYS {
        assert_eq!(rig.store.get(key).unwrap(), None);
    }
    rig.store.clear().unwrap();
}

#[test]
fn clear_keeps_going_after_a_failure_and_reports_it() {
    let rig = rig();
    for key in KEYS {
        rig.store.set(key, vec![1; 32]).unwrap();
    }
    rig.fake.set_mode(Mode::Fail(no_storage));
    assert_eq!(rig.store.clear(), Err(SecureStoreError::Locked));
    rig.fake.set_mode(Mode::Normal);
    assert!(rig.store.get(SecureStoreKey::SetupToken).unwrap().is_some());
}

#[test]
fn a_keychain_that_cannot_be_reached_is_locked_never_absent() {
    for error in [
        no_storage as fn() -> Error,
        || Error::PlatformFailure("dbus".into()),
        || Error::NoDefaultStore,
    ] {
        let rig = rig();
        rig.store
            .set(SecureStoreKey::MasterKey, vec![9; 32])
            .unwrap();
        rig.fake.set_mode(Mode::Fail(error));
        assert_eq!(
            rig.store.get(SecureStoreKey::MasterKey),
            Err(SecureStoreError::Locked)
        );
        assert_eq!(
            rig.store.set(SecureStoreKey::MasterKey, vec![1; 32]),
            Err(SecureStoreError::Locked)
        );
        assert_eq!(rig.store.health(), SecureStoreHealth::Unavailable);
        rig.fake.set_mode(Mode::Normal);
        assert_eq!(
            rig.store.get(SecureStoreKey::MasterKey).unwrap(),
            Some(vec![9; 32])
        );
        assert_eq!(rig.store.health(), SecureStoreHealth::Ready);
    }
}

#[test]
fn a_store_that_fails_to_build_is_locked_and_is_built_again_on_the_next_call() {
    let rig = rig();
    *rig.build_error.lock().unwrap() = Some(|| Error::PlatformFailure("no secret service".into()));
    assert_eq!(
        rig.store.get(SecureStoreKey::MasterKey),
        Err(SecureStoreError::Locked)
    );
    assert_eq!(
        rig.store.get(SecureStoreKey::MasterKey),
        Err(SecureStoreError::Locked)
    );
    assert_eq!(rig.builds.load(Ordering::SeqCst), 2);
    *rig.build_error.lock().unwrap() = None;
    assert_eq!(rig.store.get(SecureStoreKey::MasterKey).unwrap(), None);
    let builds = rig.builds.load(Ordering::SeqCst);
    rig.store.get(SecureStoreKey::MasterKey).unwrap();
    assert_eq!(
        rig.builds.load(Ordering::SeqCst),
        builds,
        "a working store is kept"
    );
}

#[test]
fn a_malformed_value_or_a_refused_write_is_failed_and_names_no_secret() {
    let rig = rig();
    rig.fake
        .put("com.memry.sync", "master-key", b"not base64 !!");
    let Err(SecureStoreError::Failed { what }) = rig.store.get(SecureStoreKey::MasterKey) else {
        panic!("a malformed value is Failed");
    };
    assert!(!what.contains("not base64"));
    rig.fake
        .put("com.memry.sync", "master-key", &[0xff, 0xfe, 0xfd]);
    assert!(matches!(
        rig.store.get(SecureStoreKey::MasterKey),
        Err(SecureStoreError::Failed { .. })
    ));

    for error in [
        (|| Error::BadEncoding(SECRET.to_vec())) as fn() -> Error,
        || Error::BadDataFormat(SECRET.to_vec(), "x".into()),
        || Error::TooLong("blob".to_owned(), 2560),
    ] {
        rig.fake.set_mode(Mode::Fail(error));
        let Err(SecureStoreError::Failed { what }) = rig.store.get(SecureStoreKey::AccessToken)
        else {
            panic!("these are Failed, not Locked");
        };
        assert!(!what.contains("super-secret"));
        assert_eq!(rig.store.health(), SecureStoreHealth::Ready);
    }
}

#[test]
fn the_windows_target_names_service_and_account_for_every_service() {
    let windows = rig_with(None, Duration::from_secs(5), true);
    windows
        .store
        .set(SecureStoreKey::MasterKey, vec![1; 32])
        .unwrap();
    windows
        .store
        .set_secret("com.memry.test", "ai-key", b"x")
        .unwrap();
    let targets = windows.fake.targets.lock().unwrap().clone();
    assert_eq!(
        targets,
        [
            Some("com.memry.sync/master-key".to_owned()),
            Some("com.memry.test/ai-key".to_owned())
        ]
    );
    let plain = rig();
    plain
        .store
        .set(SecureStoreKey::MasterKey, vec![1; 32])
        .unwrap();
    assert_eq!(plain.fake.targets.lock().unwrap().clone(), [None]);
}

#[test]
fn every_call_runs_on_the_keyring_thread() {
    let rig = rig();
    rig.store.get(SecureStoreKey::MasterKey).unwrap();
    let names = rig.fake.reader_threads.lock().unwrap().clone();
    assert_eq!(names, [Some("memry-keyring".to_owned())]);
}

#[test]
fn generic_secrets_round_trip_raw_bytes() {
    let rig = rig();
    let value: Vec<u8> = (0..40).map(|n| n * 3).collect();
    assert_eq!(rig.store.get_secret("com.memry.test", "k").unwrap(), None);
    rig.store.set_secret("com.memry.test", "k", &value).unwrap();
    assert_eq!(rig.fake.stored("com.memry.test", "k"), Some(value.clone()));
    assert_eq!(
        rig.store.get_secret("com.memry.test", "k").unwrap(),
        Some(value)
    );
    rig.store.delete_secret("com.memry.test", "k").unwrap();
    assert_eq!(rig.store.get_secret("com.memry.test", "k").unwrap(), None);
    rig.fake.set_mode(Mode::Fail(no_storage));
    assert_eq!(
        rig.store.get_secret("com.memry.test", "k"),
        Err(SecureStoreError::Locked)
    );
}

#[test]
fn a_panicking_store_is_failed_and_the_thread_survives() {
    let rig = rig();
    rig.fake.set_mode(Mode::Panic);
    assert!(matches!(
        rig.store.get(SecureStoreKey::MasterKey),
        Err(SecureStoreError::Failed { .. })
    ));
    rig.fake.set_mode(Mode::Normal);
    assert_eq!(rig.store.get(SecureStoreKey::MasterKey).unwrap(), None);
}

fn recovery_counter(store: &KeyringStore) -> Arc<AtomicUsize> {
    let fired = Arc::new(AtomicUsize::new(0));
    let counter = fired.clone();
    store.subscribe_recovered(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    fired
}

fn wait_for(what: &str, condition: impl Fn() -> bool) {
    let start = Instant::now();
    while !condition() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "timed out waiting for {what}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn a_call_that_never_answers_is_locked_at_the_deadline_then_at_once_and_recovers() {
    let deadline = Duration::from_millis(150);
    let rig = rig_with(None, deadline, false);
    rig.store
        .set(SecureStoreKey::MasterKey, vec![5; 32])
        .unwrap();
    let fired = recovery_counter(&rig.store);
    let gate = Arc::new(Gate::default());
    rig.fake.set_mode(Mode::Block(gate.clone()));

    let start = Instant::now();
    assert_eq!(
        rig.store.get(SecureStoreKey::MasterKey),
        Err(SecureStoreError::Locked)
    );
    assert!(
        start.elapsed() >= deadline,
        "the call waited for its deadline"
    );
    assert_eq!(rig.store.health(), SecureStoreHealth::Unavailable);

    let start = Instant::now();
    for key in KEYS {
        assert_eq!(rig.store.get(key), Err(SecureStoreError::Locked));
        assert_eq!(
            rig.store.set(key, vec![1; 32]),
            Err(SecureStoreError::Locked)
        );
    }
    assert!(start.elapsed() < deadline, "a latched call answers at once");
    assert_eq!(fired.load(Ordering::SeqCst), 0);

    gate.release();
    wait_for("the recovery listener", || {
        fired.load(Ordering::SeqCst) == 1
    });
    rig.fake.set_mode(Mode::Normal);
    assert_eq!(
        rig.store.get(SecureStoreKey::MasterKey).unwrap(),
        Some(vec![5; 32])
    );
    assert_eq!(rig.store.health(), SecureStoreHealth::Ready);
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(
        fired.load(Ordering::SeqCst),
        1,
        "the listener fires once per outage"
    );
}

#[test]
fn a_write_queued_behind_a_stuck_call_is_dropped_when_its_caller_gave_up() {
    let rig = rig_with(None, Duration::from_millis(200), false);
    let fired = recovery_counter(&rig.store);
    let gate = Arc::new(Gate::default());
    rig.fake.set_mode(Mode::Block(gate.clone()));

    let reader = {
        let store = rig.store.clone();
        std::thread::spawn(move || store.get(SecureStoreKey::MasterKey))
    };
    std::thread::sleep(Duration::from_millis(40));
    let writer = {
        let store = rig.store.clone();
        std::thread::spawn(move || store.set(SecureStoreKey::AccessToken, vec![3; 32]))
    };
    assert_eq!(reader.join().unwrap(), Err(SecureStoreError::Locked));
    assert_eq!(writer.join().unwrap(), Err(SecureStoreError::Locked));

    gate.release();
    wait_for("the recovery listener", || {
        fired.load(Ordering::SeqCst) == 1
    });
    rig.fake.set_mode(Mode::Normal);
    assert_eq!(rig.store.get(SecureStoreKey::AccessToken).unwrap(), None);
    assert_eq!(rig.fake.stored("com.memry.sync", "access-token"), None);
}

#[test]
fn concurrent_reads_of_one_account_share_one_call() {
    let rig = rig();
    rig.store
        .set(SecureStoreKey::MasterKey, vec![8; 32])
        .unwrap();
    let gate = Arc::new(Gate::default());
    rig.fake.set_mode(Mode::Block(gate.clone()));
    let reads_before = rig.fake.reads.load(Ordering::SeqCst);

    let readers: Vec<_> = (0..4)
        .map(|_| {
            let store = rig.store.clone();
            std::thread::spawn(move || store.get(SecureStoreKey::MasterKey))
        })
        .collect();
    wait_for("the first read to reach the store", || {
        rig.fake.reads.load(Ordering::SeqCst) > reads_before
    });
    std::thread::sleep(Duration::from_millis(100));
    gate.release();
    for reader in readers {
        assert_eq!(reader.join().unwrap().unwrap(), Some(vec![8; 32]));
    }
    assert_eq!(rig.fake.reads.load(Ordering::SeqCst) - reads_before, 1);
}

#[test]
fn a_keychain_that_comes_back_after_an_error_fires_the_listener_once() {
    let rig = rig();
    let fired = recovery_counter(&rig.store);
    rig.fake.set_mode(Mode::Fail(no_storage));
    assert_eq!(
        rig.store.get(SecureStoreKey::MasterKey),
        Err(SecureStoreError::Locked)
    );
    assert_eq!(
        rig.store.get(SecureStoreKey::MasterKey),
        Err(SecureStoreError::Locked)
    );
    assert_eq!(fired.load(Ordering::SeqCst), 0);
    rig.fake.set_mode(Mode::Normal);
    assert_eq!(rig.store.get(SecureStoreKey::MasterKey).unwrap(), None);
    rig.store.get(SecureStoreKey::MasterKey).unwrap();
    wait_for("the recovery listener", || {
        fired.load(Ordering::SeqCst) == 1
    });
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(fired.load(Ordering::SeqCst), 1);
}

#[test]
fn a_stuck_call_that_ends_in_an_error_is_not_a_recovery() {
    let rig = rig_with(None, Duration::from_millis(100), false);
    let fired = recovery_counter(&rig.store);
    let gate = Arc::new(Gate::default());
    rig.fake.set_mode(Mode::Block(gate.clone()));
    assert_eq!(
        rig.store.get(SecureStoreKey::MasterKey),
        Err(SecureStoreError::Locked)
    );
    rig.fake.set_mode(Mode::Fail(no_storage));
    gate.release();
    wait_for("the worker to take calls again", || {
        rig.store.get(SecureStoreKey::MasterKey) == Err(SecureStoreError::Locked)
            && rig.store.health() == SecureStoreHealth::Unavailable
    });
    assert_eq!(fired.load(Ordering::SeqCst), 0);
}
