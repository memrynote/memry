//! The done marker, the convergence of a rerun before it, and the rollback of a run that fails
//! after its first write.

use super::*;

fn not_read() -> Result<(SecretsReport, SecretsEvidence), ImportError> {
    panic!("a finished phase reads nothing of Electron")
}

fn done_marker(w: &World) -> std::path::PathBuf {
    w.app_dir.path().join("secrets-import.done")
}

#[test]
fn a_finished_import_is_done_and_never_copies_electron_s_secrets_again() {
    let w = world();
    w.run(&evidence(), SecretsMode::Full).unwrap();
    assert!(done_marker(&w).exists());

    // This app refreshed: the token rotated away from Electron's.
    w.rig
        .store
        .set(SecureStoreKey::RefreshToken, b"rotated".to_vec())
        .unwrap();
    assert_eq!(
        w.import(not_read, SecretsMode::Full),
        Ok(SecretsPhase::Done)
    );
    assert_eq!(
        w.rig.store.get(SecureStoreKey::RefreshToken).unwrap(),
        Some(b"rotated".to_vec())
    );

    // This app signed out: the user is not signed back in with Electron's secrets.
    w.rig.store.clear().unwrap();
    let writes = w.writes();
    assert_eq!(
        w.phase(&evidence(), SecretsMode::Full),
        Ok(SecretsPhase::Done)
    );
    assert_eq!(w.writes(), writes);
    assert_eq!(w.rig.store.get(SecureStoreKey::MasterKey).unwrap(), None);
}

#[test]
fn a_crash_before_the_done_marker_converges_on_rerun() {
    let w = world();
    w.run(&evidence(), SecretsMode::Full).unwrap();
    fs::remove_file(done_marker(&w)).unwrap();
    let own = w.items(true);
    let writes = w.writes();
    let outcome = w.run(&evidence(), SecretsMode::Full).unwrap();
    assert_eq!((outcome.written, outcome.present), (0, 7));
    assert_eq!(outcome.device_key, DeviceKey::AlreadyHeld);
    assert_eq!(w.items(true), own);
    assert_eq!(w.writes(), writes);
    assert!(done_marker(&w).exists());
}

#[test]
fn a_keychain_that_locks_mid_run_rolls_back_only_what_this_run_wrote() {
    let w = world();
    let before = w.electron();
    // Found in place with Electron's value: not this run's write, so the rollback keeps it.
    w.rig.fake.put(
        "com.memrynote.memry.readwise",
        "readwise-token:/v",
        b"rw-token",
    );
    let found = w.items(true);
    *w.rig.fake.locked_account.lock().unwrap() = Some("openai".to_owned());

    assert_eq!(
        w.run(&evidence(), SecretsMode::Full),
        Err(SecretsError::Keychain(SecureStoreError::Locked))
    );
    assert!(w.writes() > 3, "the sync secrets were written first");
    assert_eq!(w.items(true), found, "this run's writes were removed");
    assert_eq!(w.electron(), before);
    assert_eq!(w.identity().get(DSK).unwrap(), None, "no identity adopted");
    assert!(!done_marker(&w).exists());
}

fn read_back_mismatch() -> SecretsError {
    SecretsError::Keychain(SecureStoreError::Failed {
        what: "the master key did not read back from the keychain".to_owned(),
    })
}

#[test]
fn a_master_key_that_reads_back_wrong_is_rolled_back() {
    let w = world();
    let before = w.electron();
    *w.rig.fake.replace_writes.lock().unwrap() = Some(b64(&OTHER_MASTER).into_bytes());

    assert_eq!(
        w.run(&evidence(), SecretsMode::Full),
        Err(read_back_mismatch())
    );
    assert!(w.items(true).is_empty(), "the sync secrets were removed");
    assert_eq!(w.electron(), before);
    assert!(!done_marker(&w).exists());
}

#[test]
fn a_rollback_that_cannot_delete_reports_what_it_left() {
    let w = world();
    let before = w.electron();
    *w.rig.fake.replace_writes.lock().unwrap() = Some(b64(&OTHER_MASTER).into_bytes());
    *w.rig.fake.fail_deletes.lock().unwrap() = Some(|| Error::NoStorageAccess("locked".into()));

    assert_eq!(
        w.run(&evidence(), SecretsMode::Full),
        Err(SecretsError::RollbackIncomplete {
            cause: Box::new(read_back_mismatch()),
            left: 3,
        })
    );
    assert_eq!(
        w.items(true).len(),
        3,
        "master key, access and refresh token"
    );
    assert_eq!(w.electron(), before);
    assert!(!done_marker(&w).exists());
}

/// A write the keychain answers `Failed` may have landed anyway, so it is read back.
#[test]
fn a_refused_write_that_landed_is_rolled_back_with_the_rest() {
    let w = world();
    let before = w.electron();
    *w.rig.fake.lost_ack_account.lock().unwrap() = Some("openai".to_owned());
    *w.rig.fake.locked_account.lock().unwrap() = Some(w.rig.store.identity_account());

    assert_eq!(
        w.run(&evidence(), SecretsMode::Full),
        Err(SecretsError::Keychain(SecureStoreError::Locked))
    );
    assert_eq!(
        w.items(true),
        Items::new(),
        "the landed write was removed too"
    );
    assert_eq!(w.electron(), before);
}

#[test]
fn a_refused_write_that_landed_counts_as_written() {
    let plain = world().run(&evidence(), SecretsMode::Full).unwrap();
    let w = world();
    *w.rig.fake.lost_ack_account.lock().unwrap() = Some("openai".to_owned());

    let outcome = w.run(&evidence(), SecretsMode::Full).unwrap();
    assert_eq!(
        w.own("com.memrynote.memry.voice-transcription", "openai"),
        Some(b"sk-voice".to_vec())
    );
    assert_eq!(outcome, plain);
}

#[test]
fn a_refused_write_that_holds_another_value_stops_and_is_rolled_back() {
    let w = world();
    let before = w.electron();
    *w.rig.fake.replace_writes.lock().unwrap() = Some(b"garbage".to_vec());
    *w.rig.fake.lost_ack_account.lock().unwrap() = Some("openai".to_owned());

    assert_eq!(
        w.run(&evidence(), SecretsMode::SignInAgain),
        Err(SecretsError::Keychain(SecureStoreError::Failed {
            what: "the refused com.memrynote.memry.voice-transcription write read back another \
                   value"
                .to_owned(),
        }))
    );
    assert_eq!(w.items(true), Items::new(), "the other value was removed");
    assert_eq!(w.electron(), before);
    assert!(!done_marker(&w).exists());
}

#[test]
fn a_refused_write_that_cannot_be_read_back_stops_and_is_rolled_back() {
    let w = world();
    let before = w.electron();
    *w.rig.fake.lost_ack_account.lock().unwrap() = Some("openai".to_owned());
    *w.rig.fake.fail_reads_after_a_write.lock().unwrap() =
        Some(|| Error::NoStorageAccess("locked".into()));

    assert_eq!(
        w.run(&evidence(), SecretsMode::SignInAgain),
        Err(SecretsError::Keychain(SecureStoreError::Locked))
    );
    assert_eq!(w.items(true), Items::new(), "the unread write was removed");
    assert_eq!(w.electron(), before);
    assert!(!done_marker(&w).exists());
}
