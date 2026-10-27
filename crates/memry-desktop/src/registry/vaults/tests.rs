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
        .record_open("/v/a", 1_767_323_045_678, 0)
        .expect("open a");
    assert!(first.is_default);
    assert_eq!(first.name, "a");
    assert_eq!(first.last_opened, "2026-01-02T03:04:05.678Z");
    let second = registry
        .record_open("/v/b", 1_767_323_046_000, 0)
        .expect("open b");
    assert!(
        !second.is_default,
        "only the first vault becomes the default"
    );
    assert_eq!(registry.current().as_deref(), Some("/v/b"));
    let again = registry
        .record_open("/v/a", 1_767_323_047_000, 0)
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
    registry.record_open("/v/a", 5, 9).expect("open");
    let text = std::fs::read_to_string(registry.config().path()).expect("file");
    let value: Value = serde_json::from_str(&text).expect("json");
    let entry = &value["vaults"][0];
    assert_eq!(entry["vaultUuid"], "u-1");
    assert_eq!(entry["accountBinding"]["mode"], "sync");
    assert_eq!(entry["newer"]["k"], 1);
    assert_eq!(
        entry["noteCount"], 9,
        "the count is the one the open counted"
    );
    assert_eq!(entry["taskCount"], 2);
    assert_eq!(value["other"], true);
}

#[test]
fn remove_forgets_the_entry_clears_current_and_leaves_the_folder() {
    let dir = tempfile::tempdir().expect("dir");
    let vault = dir.path().join("keep");
    std::fs::create_dir_all(vault.join(".memry")).expect("vault");
    let registry = registry_in(dir.path(), None);
    let path = vault.to_string_lossy().into_owned();
    registry.record_open(&path, 1, 0).expect("open");
    registry.remove(&path).expect("remove");
    assert!(registry.get(&path).is_none());
    assert_eq!(registry.current(), None);
    assert!(vault.join(".memry").is_dir());
}

#[test]
fn set_default_leaves_exactly_one_default() {
    let dir = tempfile::tempdir().expect("dir");
    let registry = registry_in(dir.path(), None);
    registry.record_open("/v/a", 1, 0).expect("a");
    registry.record_open("/v/b", 2, 0).expect("b");
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
        registry.record_open("/v/a", 1, 0),
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
            .record_open(&path.to_string_lossy(), at, 0)
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

/// `list` reads each vault's `.memry/config.json` for its accent and icon. A named pipe in
/// its place would block a plain `read` until a writer opens it. The config owner opens it
/// without blocking and refuses a file that is not regular, so the list neither stalls nor
/// holds the config mutex behind it, and a registry write meanwhile still goes through.
#[cfg(unix)]
#[test]
fn a_pipe_as_config_json_cannot_stall_the_list_or_the_registry() {
    use std::sync::mpsc::channel;
    use std::time::Duration;

    let dir = tempfile::tempdir().expect("dir");
    let vault = dir.path().join("v");
    std::fs::create_dir_all(vault.join(".memry")).expect("vault");
    let made = std::process::Command::new("mkfifo")
        .arg(vault.join(".memry/config.json"))
        .status()
        .expect("mkfifo");
    assert!(made.success());
    let registry = registry_in(dir.path(), None);
    registry
        .record_open(&vault.to_string_lossy(), 1_767_323_045_678, 0)
        .expect("register");

    let (tx, rx) = channel();
    let lister = registry.clone();
    std::thread::spawn(move || tx.send(lister.list(no_sandbox())).expect("report"));
    let response = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("the list stalled on a pipe");
    assert_eq!(response.vaults.len(), 1);
    assert_eq!(response.vaults[0].accent_color.as_deref(), Some("#f97316"));
    assert!(registry.set_default("/v/none").is_err());
}
