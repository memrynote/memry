//! The vault config's cross-process lock: the app and the command line write one file.

use std::path::Path;
use std::time::Duration;

use serde_json::Value;

/// Set in the child processes of the test below: `<vault>|<key prefix>`.
const WORKER: &str = "MEMRY_VAULT_CONFIG_LOCK_WORKER";
const UPDATES: usize = 200;

fn wait_for(path: &Path) {
    for _ in 0..6000 {
        if path.exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("{} never appeared", path.display());
}

/// Two processes each write their own keys into one vault's config, starting together; every
/// key survives.
#[test]
fn updates_from_two_processes_do_not_lose_each_other() {
    let dir = tempfile::tempdir().expect("tempdir");
    let vault = dir.path().join("vault");
    std::fs::create_dir_all(vault.join(".memry")).expect("vault");
    let exe = std::env::current_exe().expect("test binary");
    let children: Vec<_> = ["a", "b"]
        .into_iter()
        .map(|tag| {
            std::process::Command::new(&exe)
                .args([
                    "--exact",
                    "vault::config::lock_tests::worker",
                    "--test-threads=1",
                ])
                .env(WORKER, format!("{}|{tag}", vault.display()))
                .stdout(std::process::Stdio::null())
                .spawn()
                .expect("spawn worker")
        })
        .collect();
    for tag in ["a", "b"] {
        wait_for(&dir.path().join(format!("ready-{tag}")));
    }
    std::fs::write(dir.path().join("go"), b"").expect("go");
    for mut child in children {
        assert!(child.wait().expect("wait").success(), "worker failed");
    }
    let written = super::read_map(&vault).expect("config");
    assert_eq!(written.len(), 2 * UPDATES);
}

/// The child side of the test above; does nothing in a normal run.
#[test]
fn worker() {
    let Some(spec) = std::env::var_os(WORKER) else {
        return;
    };
    let spec = spec.into_string().expect("utf-8 spec");
    let (vault, tag) = spec.rsplit_once('|').expect("spec");
    let vault = Path::new(vault);
    let dir = vault.parent().expect("dir");
    std::fs::write(dir.join(format!("ready-{tag}")), b"").expect("ready");
    wait_for(&dir.join("go"));
    for n in 0..UPDATES {
        super::update(vault, |map| {
            map.insert(format!("{tag}{n}"), Value::from(n));
        })
        .expect("update");
    }
}

/// A lock another process does not let go of fails the write instead of hanging it, and
/// leaves the file as it was.
#[test]
fn a_lock_held_past_the_wait_fails_the_write() {
    let dir = tempfile::tempdir().expect("tempdir");
    let vault = dir.path();
    std::fs::create_dir(vault.join(".memry")).expect("memry");
    let held = std::fs::File::create(vault.join(".memry/config.json.lock")).expect("lock");
    held.lock().expect("hold");
    let error = super::update(vault, |map| {
        map.insert("a".into(), Value::Null);
    })
    .expect_err("held");
    assert!(error.to_string().contains("held the lock"), "{error}");
    assert!(!super::config_path(vault).exists(), "nothing written");
}

/// Root ignores file modes, so these tests mean nothing as root.
#[cfg(unix)]
fn as_root() -> bool {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() == 0 }
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).expect("chmod");
}

/// A lock file this user may only read (another user's, left by `sudo memrynote`) still locks:
/// the lock is taken on a read-only handle, and the write goes ahead.
#[cfg(unix)]
#[test]
fn a_read_only_lock_file_still_locks_the_write() {
    if as_root() {
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let vault = dir.path();
    std::fs::create_dir(vault.join(".memry")).expect("memry");
    let lock = vault.join(".memry/config.json.lock");
    std::fs::write(&lock, b"").expect("lock file");
    set_mode(&lock, 0o444);
    super::update(vault, |map| {
        map.insert("a".into(), Value::from(1));
    })
    .expect("written");
    // The read-only handle holds a real lock: a holder makes the write wait, then fail.
    let held = std::fs::File::open(&lock).expect("read-only handle");
    held.lock().expect("hold");
    let error = super::update(vault, |map| {
        map.insert("b".into(), Value::Null);
    })
    .expect_err("held");
    assert!(error.to_string().contains("held the lock"), "{error}");
    assert_eq!(super::read_map(vault).expect("config").len(), 1);
}

/// A lock file this user cannot open at all: the write goes ahead unlocked, as on a file system
/// without locks, instead of failing every config write of the app.
#[cfg(unix)]
#[test]
fn a_lock_file_that_cannot_be_opened_writes_unlocked() {
    if as_root() {
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let vault = dir.path();
    std::fs::create_dir(vault.join(".memry")).expect("memry");
    let lock = vault.join(".memry/config.json.lock");
    std::fs::write(&lock, b"").expect("lock file");
    set_mode(&lock, 0o000);
    super::update(vault, |map| {
        map.insert("a".into(), Value::from(1));
    })
    .expect("written");
    assert_eq!(super::read_map(vault).expect("config")["a"], 1);
}

/// A `.memry` folder that refuses the lock file refuses the config write too: the error is
/// the localised permission one.
#[cfg(unix)]
#[test]
fn a_folder_that_refuses_the_lock_file_is_permission_denied() {
    if as_root() {
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let vault = dir.path();
    let memry = vault.join(".memry");
    std::fs::create_dir(&memry).expect("memry");
    set_mode(&memry, 0o555);
    let result = super::update(vault, |map| {
        map.insert("a".into(), Value::Null);
    });
    set_mode(&memry, 0o755);
    assert!(
        matches!(result, Err(super::ConfigError::PermissionDenied)),
        "{result:?}"
    );
}
