use memry_desktop_tauri_lib::vault::registry::{VaultInfo, VaultRegistry};

fn registry_path(dir: &tempfile::TempDir) -> std::path::PathBuf {
    dir.path().join("vaults.json")
}

fn make_info(path: &std::path::Path, name: &str, is_default: bool) -> VaultInfo {
    VaultInfo {
        path: path.to_string_lossy().into_owned(),
        name: name.into(),
        note_count: 0,
        task_count: 0,
        last_opened: "2026-04-26T00:00:00Z".into(),
        is_default,
    }
}

#[test]
fn empty_registry_when_file_missing() {
    let dir = tempfile::tempdir().unwrap();
    let reg = VaultRegistry::load(&registry_path(&dir)).unwrap();
    assert!(reg.vaults.is_empty());
    assert!(reg.current.is_none());
}

#[test]
fn upsert_then_persist_then_reload() {
    let dir = tempfile::tempdir().unwrap();
    let path = registry_path(&dir);
    let mut reg = VaultRegistry::load(&path).unwrap();

    let v_dir = tempfile::tempdir().unwrap();
    reg.upsert(make_info(v_dir.path(), "Primary", true));
    reg.set_current(Some(v_dir.path().to_string_lossy().into_owned()));
    reg.save(&path).unwrap();

    let reloaded = VaultRegistry::load(&path).unwrap();
    assert_eq!(reloaded.vaults.len(), 1);
    assert_eq!(reloaded.vaults[0].name, "Primary");
    assert_eq!(
        reloaded.current.as_deref(),
        Some(v_dir.path().to_string_lossy().as_ref())
    );
}

#[test]
fn upsert_replaces_by_path_not_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let v_dir = tempfile::tempdir().unwrap();
    let mut reg = VaultRegistry::load(&registry_path(&dir)).unwrap();
    reg.upsert(make_info(v_dir.path(), "First", true));
    reg.upsert(make_info(v_dir.path(), "Renamed", false));
    assert_eq!(reg.vaults.len(), 1);
    assert_eq!(reg.vaults[0].name, "Renamed");
    assert!(!reg.vaults[0].is_default);
}

#[test]
fn remove_drops_vault_and_clears_current_if_match() {
    let dir = tempfile::tempdir().unwrap();
    let v1 = tempfile::tempdir().unwrap();
    let v2 = tempfile::tempdir().unwrap();
    let mut reg = VaultRegistry::load(&registry_path(&dir)).unwrap();
    reg.upsert(make_info(v1.path(), "v1", true));
    reg.upsert(make_info(v2.path(), "v2", false));
    reg.set_current(Some(v1.path().to_string_lossy().into_owned()));

    reg.remove(&v1.path().to_string_lossy());
    assert_eq!(reg.vaults.len(), 1);
    assert_eq!(reg.vaults[0].name, "v2");
    assert!(reg.current.is_none());
}

#[test]
fn touch_updates_last_opened() {
    let dir = tempfile::tempdir().unwrap();
    let v = tempfile::tempdir().unwrap();
    let mut reg = VaultRegistry::load(&registry_path(&dir)).unwrap();
    reg.upsert(make_info(v.path(), "v", true));
    let before = reg.vaults[0].last_opened.clone();
    std::thread::sleep(std::time::Duration::from_millis(10));
    reg.touch(&v.path().to_string_lossy());
    let after = reg.vaults[0].last_opened.clone();
    assert_ne!(before, after, "touch should bump last_opened");
}

#[test]
fn corrupt_file_falls_back_to_empty_registry() {
    let dir = tempfile::tempdir().unwrap();
    let path = registry_path(&dir);
    std::fs::write(&path, "{not valid json}").unwrap();
    let reg = VaultRegistry::load(&path).unwrap();
    assert!(reg.vaults.is_empty());
    assert!(reg.current.is_none());
}
