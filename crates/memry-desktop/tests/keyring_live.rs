//! `KeyringStore` against the live OS keychain (`--features live-os-secrets`). Every test uses a
//! device suffix of its own (`e2e-live-...`, so accounts like `master-key-e2e-live-...` under
//! `com.memrynote.memry`) or the service `com.memrynote.memry.test`, and removes what it wrote, so
//! the real accounts of a developer's machine are never touched. CI runs them: macOS (a
//! throw-away default keychain on the runner), Windows (Credential Manager) and Linux under a
//! private session bus (`gnome-keyring-daemon --unlock`, a locked keyring, a restarted daemon, and
//! again with no Secret Service at all).
#![cfg(feature = "live-os-secrets")]

use std::sync::Arc;

use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::e2e::E2eGate;
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::seams::secure_store::{
    DeviceIdentityStore, GenericSecrets, KeyringStore, STORE_KEYS, SecureStoreHealth,
    keychain_absent,
};

/// A name no other test of any run uses. The tests run in parallel threads, and the Windows clock
/// ticks in 100 ns steps, so two calls can read the same time: the counter keeps them apart.
/// (Two tests once shared the account `e2e-live-account-<pid>-<nanos>` on windows-11-arm and one
/// read the other's value.)
fn unique(tag: &str) -> String {
    static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("e2e-live-{tag}-{}-{nanos}-{n}", std::process::id())
}

/// Warnings of the store (why the keychain answered `Locked`) show in a failing test's output.
fn store(suffix: &str) -> KeyringStore {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("warn")
        .with_writer(std::io::stderr)
        .try_init();
    KeyringStore::new(
        Some(suffix.to_owned()),
        E2eGate::from_env(&LaunchEnv::default()),
        std::path::Path::new("."),
    )
}

/// Removes the entries of a test's device suffix when the test ends, pass or fail.
struct Cleanup(Arc<KeyringStore>);

impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = self.0.clear();
    }
}

fn no_secret_service() -> bool {
    std::env::var("MEMRY_LIVE_NO_SECRET_SERVICE").is_ok_and(|v| v == "1")
}

/// The macOS rows write to the default keychain: they run on CI (`CI` is set) and nowhere else.
fn skip_on_a_developer_mac() -> bool {
    cfg!(target_os = "macos") && std::env::var_os("CI").is_none()
}

#[test]
fn the_five_sync_secrets_round_trip_in_the_real_keychain() {
    if no_secret_service() || skip_on_a_developer_mac() {
        return;
    }
    let store = Arc::new(store(&unique("sync")));
    let _cleanup = Cleanup(store.clone());
    for (n, key) in STORE_KEYS.into_iter().enumerate() {
        let n = u8::try_from(n).unwrap();
        for value in [vec![n; 32], (0..64_u8).map(|b| b ^ n).collect::<Vec<_>>()] {
            store.set(key, value.clone()).unwrap();
            assert_eq!(store.get(key).unwrap(), Some(value));
        }
    }
    store.delete(SecureStoreKey::MasterKey).unwrap();
    assert_eq!(store.get(SecureStoreKey::MasterKey).unwrap(), None);
    store.clear().unwrap();
    for key in STORE_KEYS {
        assert_eq!(store.get(key).unwrap(), None);
    }
    assert_eq!(store.health(), SecureStoreHealth::Ready);
}

#[test]
fn a_generic_secret_of_forty_raw_bytes_round_trips() {
    if no_secret_service() || skip_on_a_developer_mac() {
        return;
    }
    let store = store(&unique("generic"));
    let account = unique("account");
    let value: Vec<u8> = (0..40).map(|b| b * 5 + 1).collect();
    assert_eq!(
        store
            .get_secret("com.memrynote.memry.test", &account)
            .unwrap(),
        None
    );
    store
        .set_secret("com.memrynote.memry.test", &account, &value)
        .unwrap();
    let read = store
        .get_secret("com.memrynote.memry.test", &account)
        .unwrap();
    store
        .delete_secret("com.memrynote.memry.test", &account)
        .unwrap();
    assert_eq!(read, Some(value));
    assert_eq!(
        store
            .get_secret("com.memrynote.memry.test", &account)
            .unwrap(),
        None
    );
}

/// Credential Manager holds a blob of at most 2560 bytes. The five real values are at most 90.
#[cfg(windows)]
#[test]
fn a_big_generic_value_is_failed_not_locked_on_windows() {
    let store = store(&unique("blob"));
    let account = unique("account");
    let fits = vec![7_u8; 1500];
    store
        .set_secret("com.memrynote.memry.test", &account, &fits)
        .unwrap();
    assert_eq!(
        store
            .get_secret("com.memrynote.memry.test", &account)
            .unwrap(),
        Some(fits)
    );
    let too_big = vec![7_u8; 3000];
    let result = store.set_secret("com.memrynote.memry.test", &account, &too_big);
    store
        .delete_secret("com.memrynote.memry.test", &account)
        .unwrap();
    assert!(
        matches!(result, Err(SecureStoreError::Failed { .. })),
        "a refused write is Failed, got {result:?}"
    );
}

/// `MEMRY_LIVE_NO_SECRET_SERVICE=1`: the session bus has no Secret Service and none is started.
#[test]
fn with_no_secret_service_every_call_is_locked_and_nothing_is_stored() {
    if !no_secret_service() {
        return;
    }
    let store = store(&unique("none"));
    for key in STORE_KEYS {
        assert_eq!(store.get(key), Err(SecureStoreError::Locked));
        assert_eq!(store.set(key, vec![1; 32]), Err(SecureStoreError::Locked));
    }
    assert_eq!(
        store.get_secret("com.memrynote.memry.test", "a"),
        Err(SecureStoreError::Locked)
    );
    assert_eq!(store.health(), SecureStoreHealth::Unavailable);
}

/// The device key a build before Step 15 kept in `<profile>/device-key` moves into the real
/// keychain, the file goes, and a restart reads the same key from the keychain.
#[test]
fn the_device_key_file_of_an_earlier_build_moves_into_the_real_keychain() {
    if no_secret_service() || skip_on_a_developer_mac() {
        return;
    }
    assert!(!keychain_absent(), "this system has a keychain");
    let profile = tempfile::tempdir().unwrap();
    let suffix = unique("identity");
    let store = Arc::new(store(&suffix));
    let _cleanup = Cleanup(store.clone());
    let key: Vec<u8> = (0..64).collect();
    std::fs::write(profile.path().join("device-key"), &key).unwrap();
    let identity = DeviceIdentityStore::new(store.clone(), profile.path());
    let moved = identity.get(SecureStoreKey::DeviceSigningKey);
    // A profile with no file reads the key from the keychain alone.
    let elsewhere = tempfile::tempdir().unwrap();
    let in_keychain = DeviceIdentityStore::new(store.clone(), elsewhere.path())
        .get(SecureStoreKey::DeviceSigningKey);
    let file_left = profile.path().join("device-key").exists();
    let deleted = identity.delete(SecureStoreKey::DeviceSigningKey);
    let after = DeviceIdentityStore::new(store.clone(), elsewhere.path())
        .get(SecureStoreKey::DeviceSigningKey);
    assert_eq!(moved.unwrap(), Some(key.clone()));
    assert_eq!(in_keychain.unwrap(), Some(key));
    assert!(!file_left);
    deleted.unwrap();
    assert!(
        matches!(after, Err(SecureStoreError::Failed { .. })),
        "{after:?}"
    );
}

/// `MEMRY_LIVE_NO_SECRET_SERVICE=1` (Linux): with no Secret Service on the bus the system has no
/// keychain, so a fresh profile's device key is minted into a 0600 file and the app can write.
#[cfg(target_os = "linux")]
#[test]
fn with_no_secret_service_the_device_key_lives_in_a_private_file() {
    use std::os::unix::fs::PermissionsExt;

    if !no_secret_service() {
        return;
    }
    assert!(keychain_absent());
    let profile = tempfile::tempdir().unwrap();
    let identity = Arc::new(DeviceIdentityStore::new(
        Arc::new(store(&unique("nokeychain"))),
        profile.path(),
    ));
    memry_core::api::auth::ensure_device_identity(identity.clone()).unwrap();
    let file = profile.path().join("device-key");
    assert_eq!(std::fs::read(&file).unwrap().len(), 64);
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(
        identity
            .get(SecureStoreKey::DeviceSigningKey)
            .unwrap()
            .is_some()
    );
}

/// `MEMRY_LIVE_LATE_SERVICE=1` (Linux): no Secret Service at first; the test starts
/// `gnome-keyring-daemon` and the next call finds it, and the recovery listener fires.
#[cfg(target_os = "linux")]
#[test]
fn a_secret_service_that_starts_late_is_found_by_the_next_call() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    if std::env::var("MEMRY_LIVE_LATE_SERVICE").is_ok_and(|v| v == "1") {
        let store = Arc::new(store(&unique("late")));
        let _cleanup = Cleanup(store.clone());
        let fired = Arc::new(AtomicUsize::new(0));
        let counter = fired.clone();
        store.subscribe_recovered(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(
            store.get(SecureStoreKey::MasterKey),
            Err(SecureStoreError::Locked)
        );
        assert_eq!(store.health(), SecureStoreHealth::Unavailable);

        // The daemon outlives this test on purpose: the next call must find it running.
        #[allow(clippy::zombie_processes)]
        let mut daemon = Command::new("gnome-keyring-daemon")
            .args(["--unlock", "--components=secrets"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        daemon.stdin.take().unwrap().write_all(b"ci").unwrap();

        let start = Instant::now();
        loop {
            match store.set(SecureStoreKey::MasterKey, vec![4; 32]) {
                Ok(()) => break,
                Err(SecureStoreError::Locked) if start.elapsed() < Duration::from_secs(20) => {
                    std::thread::sleep(Duration::from_millis(200));
                }
                Err(error) => panic!("the late service was not found: {error:?}"),
            }
        }
        assert_eq!(
            store.get(SecureStoreKey::MasterKey).unwrap(),
            Some(vec![4; 32])
        );
        assert_eq!(store.health(), SecureStoreHealth::Ready);
        let start = Instant::now();
        while fired.load(Ordering::SeqCst) == 0 && start.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(fired.load(Ordering::SeqCst), 1);
    }
}

/// An item the store wrote, made with libsecret's tool: the zbus store's attributes `service` and
/// `username`.
#[cfg(target_os = "linux")]
fn secret_tool_store(account: &str, text: &str) {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child = Command::new("secret-tool")
        .args([
            "store",
            "--label",
            "memry-live",
            "service",
            memry_desktop::seams::secure_store::SERVICE,
            "username",
            account,
        ])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success(), "secret-tool store");
}

/// A keyring that holds the store's item but is locked in this session hides the item from every
/// search. The store must say `Locked`, never "no key" (`MEMRY_LIVE_LOCKED_KEYRING=1` with
/// `MEMRY_LIVE_LOCKED_SUFFIX`: CI writes the item, then restarts gnome-keyring without a password
/// and with no prompter to unlock it).
#[cfg(target_os = "linux")]
#[test]
fn a_locked_keyring_is_locked_never_absent() {
    if std::env::var("MEMRY_LIVE_LOCKED_KEYRING").is_ok_and(|v| v == "1") {
        let suffix = std::env::var("MEMRY_LIVE_LOCKED_SUFFIX").unwrap();
        // The check alone: a locked keyring could hide anything, so it never confirms "absent".
        let checked = memry_desktop::seams::secure_store::linux_confirm_absent();
        assert!(
            matches!(checked, Err(keyring_core::Error::NoStorageAccess(_))),
            "{checked:?}"
        );
        let store = store(&suffix);
        assert_eq!(
            store.get(SecureStoreKey::MasterKey),
            Err(SecureStoreError::Locked)
        );
        assert_eq!(
            store.delete(SecureStoreKey::MasterKey),
            Err(SecureStoreError::Locked)
        );
    }
}

/// The store's item, shown by the search as locked (its collection was locked after the item was
/// written, `MEMRY_LIVE_LOCKED_ITEM=1` with `MEMRY_LIVE_LOCKED_SUFFIX`): the store asks the service
/// to unlock it, nobody can answer the prompt in this session, and get and delete are `Locked`,
/// never "absent" and never a reported delete.
#[cfg(target_os = "linux")]
#[test]
fn an_item_that_cannot_be_unlocked_is_locked_for_every_call() {
    if std::env::var("MEMRY_LIVE_LOCKED_ITEM").is_ok_and(|v| v == "1") {
        let suffix = std::env::var("MEMRY_LIVE_LOCKED_SUFFIX").unwrap();
        let store = store(&suffix);
        assert_eq!(
            store.get(SecureStoreKey::MasterKey),
            Err(SecureStoreError::Locked)
        );
        assert_eq!(
            store.delete(SecureStoreKey::MasterKey),
            Err(SecureStoreError::Locked)
        );
    }
}

/// The keyring daemon restarts while the app runs (`MEMRY_LIVE_RESTART_DAEMON=1`, alone in its
/// session: it kills the daemon). The kept Secret Service session of the locked-collection check is
/// gone with it, and the next check runs again on a new connection instead of answering `Locked`.
/// The store's own session is stale too: a read of an item answers `Locked` once (never "absent"),
/// and the store built for the next call reads it.
#[cfg(target_os = "linux")]
#[test]
fn a_keyring_daemon_that_restarts_is_found_by_the_next_call() {
    use std::io::Write;
    use std::process::{Command, Stdio};

    if std::env::var("MEMRY_LIVE_RESTART_DAEMON").is_ok_and(|v| v == "1") {
        let suffix = unique("restart");
        let store = Arc::new(store(&suffix));
        let _cleanup = Cleanup(store.clone());
        // Nothing stored: the check runs and its connection is kept.
        assert_eq!(store.get(SecureStoreKey::MasterKey).unwrap(), None);
        let _ = Command::new("pkill")
            .args(["-x", "gnome-keyring-d"])
            .status();
        std::thread::sleep(std::time::Duration::from_secs(1));
        let mut daemon = Command::new("gnome-keyring-daemon")
            .args(["--unlock", "--components=secrets"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        daemon.stdin.take().unwrap().write_all(b"ci").unwrap();
        assert!(daemon.wait().unwrap().success(), "gnome-keyring-daemon");
        assert_eq!(store.get(SecureStoreKey::MasterKey).unwrap(), None);
        secret_tool_store(
            &format!("master-key-{suffix}"),
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
        );
        let first = store.get(SecureStoreKey::MasterKey);
        assert!(
            matches!(first, Ok(Some(_)) | Err(SecureStoreError::Locked)),
            "{first:?}"
        );
        assert_eq!(
            store.get(SecureStoreKey::MasterKey).unwrap(),
            Some((0..32).collect::<Vec<u8>>())
        );
    }
}
