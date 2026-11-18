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
