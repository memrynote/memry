use super::*;

fn registry_in(dir: &Path, seed: Option<&str>) -> VaultRegistry {
    let file = dir.join("memry-config.json");
    if let Some(seed) = seed {
        std::fs::write(&file, seed).expect("seed");
    }
    VaultRegistry::new(Arc::new(AppConfig::load(file)))
}

fn no_sandbox() -> SandboxInfo {
    SandboxInfo {
        path: String::new(),
        exists: false,
    }
}

#[test]
fn iso_millis_matches_to_iso_string() {
    assert_eq!(iso_millis(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_millis(1_767_323_045_678), "2026-01-02T03:04:05.678Z");
    assert_eq!(iso_millis(951_782_400_000), "2000-02-29T00:00:00.000Z");
    assert_eq!(iso_millis(-1), "1969-12-31T23:59:59.999Z");
}

#[test]
fn the_first_opened_vault_is_the_default_and_a_reopen_keeps_everything_else() {
    let dir = tempfile::tempdir().expect("dir");
    let registry = registry_in(dir.path(), None);
    let first = registry
        .record_open("/v/a", 1_767_323_045_678)
        .expect("open a");
    assert!(first.is_default);
    assert_eq!(first.name, "a");
    assert_eq!(first.last_opened, "2026-01-02T03:04:05.678Z");
    let second = registry
        .record_open("/v/b", 1_767_323_046_000)
        .expect("open b");
    assert!(
        !second.is_default,
        "only the first vault becomes the default"
    );
    assert_eq!(registry.current().as_deref(), Some("/v/b"));
    let again = registry
        .record_open("/v/a", 1_767_323_047_000)
        .expect("reopen a");
    assert!(again.is_default);
}

#[test]
fn an_update_keeps_unknown_fields_and_never_erases_the_uuid_or_binding() {
    let dir = tempfile::tempdir().expect("dir");
    let registry = registry_in(
        dir.path(),
        Some(
            r#"{"vaults":[{"path":"/v/a","name":"a","noteCount":7,"taskCount":2,
            "lastOpened":"x","isDefault":false,"vaultUuid":"u-1",
            "accountBinding":{"userId":"me","mode":"sync"},"newer":{"k":1}}],"other":true}"#,
        ),
    );
    registry.record_open("/v/a", 5).expect("open");
    let text = std::fs::read_to_string(registry.config().path()).expect("file");
    let value: Value = serde_json::from_str(&text).expect("json");
    let entry = &value["vaults"][0];
    assert_eq!(entry["vaultUuid"], "u-1");
    assert_eq!(entry["accountBinding"]["mode"], "sync");
    assert_eq!(entry["newer"]["k"], 1);
    assert_eq!(entry["noteCount"], 7);
    assert_eq!(value["other"], true);
}

#[test]
fn remove_forgets_the_entry_clears_current_and_leaves_the_folder() {
    let dir = tempfile::tempdir().expect("dir");
    let vault = dir.path().join("keep");
    std::fs::create_dir_all(vault.join(".memry")).expect("vault");
    let registry = registry_in(dir.path(), None);
    let path = vault.to_string_lossy().into_owned();
    registry.record_open(&path, 1).expect("open");
    registry.remove(&path).expect("remove");
    assert!(registry.get(&path).is_none());
    assert_eq!(registry.current(), None);
    assert!(vault.join(".memry").is_dir());
}

#[test]
fn set_default_leaves_exactly_one_default() {
    let dir = tempfile::tempdir().expect("dir");
    let registry = registry_in(dir.path(), None);
    registry.record_open("/v/a", 1).expect("a");
    registry.record_open("/v/b", 2).expect("b");
    registry.set_default("/v/b").expect("default");
    let defaults: Vec<_> = registry
        .list(no_sandbox())
        .vaults
        .into_iter()
        .filter(|v| v.is_default)
        .map(|v| v.path)
        .collect();
    assert_eq!(defaults, ["/v/b"]);
    assert!(matches!(
        registry.set_default("/v/none"),
        Err(RegistryError::NotRegistered(_))
    ));
}

#[test]
fn a_wrong_typed_vaults_key_is_refused_and_survives() {
    let dir = tempfile::tempdir().expect("dir");
    let seed = r#"{"vaults":"surprise"}"#;
    let registry = registry_in(dir.path(), Some(seed));
    assert!(matches!(
        registry.record_open("/v/a", 1),
        Err(RegistryError::Malformed)
    ));
    assert!(registry.list(no_sandbox()).vaults.is_empty());
    assert_eq!(
        std::fs::read_to_string(registry.config().path()).expect("file"),
        seed
    );
}

#[test]
fn list_reads_accent_icon_and_reachability_of_vaults_that_are_not_open() {
    let dir = tempfile::tempdir().expect("dir");
    let here = dir.path().join("here");
    std::fs::create_dir_all(here.join(".memry")).expect("vault");
    std::fs::write(
        here.join(".memry/config.json"),
        r##"{"preferences":{"accentColor":"#112233"},"vaultIcon":{"value":"icon:Book01Icon","updatedAt":3,"pendingSync":false}}"##,
    )
    .expect("config");
    let bare = dir.path().join("bare");
    std::fs::create_dir_all(&bare).expect("bare");
    let registry = registry_in(dir.path(), None);
    for (path, at) in [(&here, 1), (&bare, 2), (&dir.path().join("gone"), 3)] {
        registry
            .record_open(&path.to_string_lossy(), at)
            .expect("open");
    }
    let listed = registry.list(no_sandbox());
    assert_eq!(listed.vaults[0].accent_color.as_deref(), Some("#112233"));
    assert_eq!(listed.vaults[0].icon.as_deref(), Some("icon:Book01Icon"));
    assert_eq!(listed.vaults[0].is_missing, Some(false));
    assert_eq!(listed.vaults[1].accent_color.as_deref(), Some("#f97316"));
    assert_eq!(listed.vaults[1].icon, None);
    assert_eq!(listed.vaults[2].is_missing, Some(true));
    assert_eq!(listed.vaults[2].accent_color, None);
    let json = serde_json::to_value(&listed.vaults[2]).expect("json");
    assert_eq!(json["isMissing"], true);
    assert!(json.get("icon").is_none());
}

/// `list` reads each vault's `.memry/config.json` for its accent and icon. A read that blocks
/// (a dead share, a sleeping drive) must not hold the config mutex, or every registry write
/// in the app would wait behind it. A named pipe as `config.json` blocks `read` until a writer
/// opens it, which is a blocking filesystem call a test can release.
/// `O_NONBLOCK`, which differs between macOS (0x4) and Linux (0o4000).
#[cfg(unix)]
const fn libc_o_nonblock() -> i32 {
    if cfg!(target_os = "linux") {
        0o4000
    } else {
        0x4
    }
}

#[cfg(unix)]
#[test]
fn list_does_no_filesystem_io_while_holding_the_config_mutex() {
    use std::sync::mpsc::channel;
    use std::time::Duration;

    let dir = tempfile::tempdir().expect("dir");
    let vault = dir.path().join("v");
    std::fs::create_dir_all(vault.join(".memry")).expect("vault");
    let pipe = vault.join(".memry/config.json");
    let made = std::process::Command::new("mkfifo")
        .arg(&pipe)
        .status()
        .expect("mkfifo");
    assert!(made.success());
    let registry = registry_in(dir.path(), None);
    registry
        .record_open(&vault.to_string_lossy(), 1_767_323_045_678)
        .expect("register");

    let (listed_tx, listed_rx) = channel();
    let lister = registry.clone();
    let list_thread = std::thread::spawn(move || {
        let response = lister.list(no_sandbox());
        listed_tx.send(()).expect("report");
        response
    });
    assert!(
        listed_rx.recv_timeout(Duration::from_millis(300)).is_err(),
        "the list is stuck reading the pipe, which is the blocking I/O this test needs"
    );

    let (updated_tx, updated_rx) = channel();
    let writer = registry.clone();
    let update_thread = std::thread::spawn(move || {
        let outcome = writer.set_default("/v/none");
        updated_tx.send(outcome.is_err()).expect("report");
    });
    let update_finished = updated_rx.recv_timeout(Duration::from_secs(5));

    // Release the reader whatever happened, so a failure does not hang the suite.
    // However many times `list` reads the config, feed each read. A non-blocking open fails
    // while no reader waits, so a reader that never comes cannot hang the suite.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !list_thread.is_finished() && std::time::Instant::now() < deadline {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        if let Ok(mut writer) = std::fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc_o_nonblock())
            .open(&pipe)
        {
            let _ = writer.write_all(b"{}");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let response = list_thread.join().expect("list thread");
    update_thread.join().expect("update thread");

    assert_eq!(
        update_finished,
        Ok(true),
        "a registry write finished while the list was blocked in file I/O"
    );
    assert_eq!(response.vaults.len(), 1);
}
