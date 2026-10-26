use std::fs;
use std::path::Path;

use super::*;

fn env(app_data: &Path, host: HostOs) -> ProfileEnv {
    ProfileEnv {
        app_data: app_data.to_owned(),
        override_dir: None,
        host,
    }
}

fn make_profile(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join("memry-config.json"), "{}").unwrap();
}

fn write_store(dir: &Path) {
    fs::write(
        dir.join(SECRET_STORE_FILENAME),
        r#"{"version":1,"entries":{"com.memry.sync":{"master-key":"AAAA"}}}"#,
    )
    .unwrap();
}

fn legacy(app_data: &Path) -> std::path::PathBuf {
    app_data.join("@memry").join("desktop")
}

fn link_dir(target: &Path, link: &Path) {
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(target, link).unwrap();
}

fn names(profile: &ElectronProfile) -> Vec<&'static str> {
    profile.app_names.0.clone()
}

#[test]
fn nothing_installed_is_none() {
    let root = tempfile::tempdir().unwrap();
    assert!(
        locate_profile(&env(root.path(), HostOs::MacOs))
            .unwrap()
            .is_none()
    );
}

#[test]
fn new_only_without_store_prefers_memrynote() {
    let root = tempfile::tempdir().unwrap();
    make_profile(&root.path().join("memrynote"));
    let profile = locate_profile(&env(root.path(), HostOs::MacOs))
        .unwrap()
        .unwrap();
    assert_eq!(profile.dir, root.path().join("memrynote"));
    assert_eq!(names(&profile), [MEMRYNOTE_APP_NAME, LEGACY_APP_NAME]);
}

#[test]
fn new_born_with_store_keeps_memrynote_name() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("memrynote");
    make_profile(&dir);
    write_store(&dir);
    let profile = locate_profile(&env(root.path(), HostOs::MacOs))
        .unwrap()
        .unwrap();
    assert_eq!(names(&profile), [MEMRYNOTE_APP_NAME, LEGACY_APP_NAME]);
}

#[test]
fn legacy_only_real_directory_with_store_uses_legacy_name() {
    let root = tempfile::tempdir().unwrap();
    let dir = legacy(root.path());
    make_profile(&dir);
    write_store(&dir);
    let profile = locate_profile(&env(root.path(), HostOs::MacOs))
        .unwrap()
        .unwrap();
    assert_eq!(profile.dir, dir);
    assert_eq!(names(&profile), [LEGACY_APP_NAME, MEMRYNOTE_APP_NAME]);
}

#[test]
fn migrated_profile_with_legacy_symlink_uses_legacy_name() {
    let root = tempfile::tempdir().unwrap();
    let new_dir = root.path().join("memrynote");
    make_profile(&new_dir);
    write_store(&new_dir);
    link_dir(&new_dir, &legacy(root.path()));
    let profile = locate_profile(&env(root.path(), HostOs::MacOs))
        .unwrap()
        .unwrap();
    assert_eq!(profile.dir, new_dir);
    assert_eq!(names(&profile), [LEGACY_APP_NAME, MEMRYNOTE_APP_NAME]);
}

#[test]
fn dangling_legacy_symlink_is_no_profile() {
    let root = tempfile::tempdir().unwrap();
    link_dir(&root.path().join("memrynote"), &legacy(root.path()));
    assert!(
        locate_profile(&env(root.path(), HostOs::MacOs))
            .unwrap()
            .is_none()
    );
}

#[test]
fn both_real_prefers_memrynote() {
    let root = tempfile::tempdir().unwrap();
    make_profile(&root.path().join("memrynote"));
    make_profile(&legacy(root.path()));
    let profile = locate_profile(&env(root.path(), HostOs::MacOs))
        .unwrap()
        .unwrap();
    assert_eq!(profile.dir, root.path().join("memrynote"));
}

#[test]
fn log_only_new_directory_is_not_a_profile() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join("memrynote/logs")).unwrap();
    fs::write(root.path().join("memrynote/.DS_Store"), "").unwrap();
    fs::write(
        root.path().join("memrynote").join(IDENTITY_PIN_FILENAME),
        "{}",
    )
    .unwrap();
    let old = legacy(root.path());
    make_profile(&old);
    let profile = locate_profile(&env(root.path(), HostOs::MacOs))
        .unwrap()
        .unwrap();
    assert_eq!(profile.dir, old);
}

#[test]
fn pin_decides_the_first_name() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("memrynote");
    make_profile(&dir);
    write_store(&dir);
    fs::write(
        dir.join(IDENTITY_PIN_FILENAME),
        r#"{"version":1,"appName":"@memry/desktop","flipped":true}"#,
    )
    .unwrap();
    let profile = locate_profile(&env(root.path(), HostOs::MacOs))
        .unwrap()
        .unwrap();
    assert_eq!(
        profile.pin,
        Some(IdentityPin {
            app_name: LEGACY_APP_NAME,
            flipped: true
        })
    );
    assert_eq!(names(&profile), [LEGACY_APP_NAME, MEMRYNOTE_APP_NAME]);
}

#[test]
fn invalid_pin_is_ignored() {
    for bad in ["not json", r#"{"appName":"other"}"#, r#"{"appName":3}"#, ""] {
        let root = tempfile::tempdir().unwrap();
        let dir = legacy(root.path());
        make_profile(&dir);
        write_store(&dir);
        fs::write(dir.join(IDENTITY_PIN_FILENAME), bad).unwrap();
        let profile = locate_profile(&env(root.path(), HostOs::MacOs))
            .unwrap()
            .unwrap();
        assert_eq!(profile.pin, None, "{bad}");
        assert_eq!(names(&profile)[0], LEGACY_APP_NAME);
    }
}

#[test]
fn windows_tries_one_name() {
    let root = tempfile::tempdir().unwrap();
    let dir = legacy(root.path());
    make_profile(&dir);
    write_store(&dir);
    let profile = locate_profile(&env(root.path(), HostOs::Windows))
        .unwrap()
        .unwrap();
    assert_eq!(names(&profile), [MEMRYNOTE_APP_NAME]);
}

#[test]
fn linux_with_store_stays_legacy_even_when_migrated_or_pinned() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("memrynote");
    make_profile(&dir);
    write_store(&dir);
    fs::write(
        dir.join(IDENTITY_PIN_FILENAME),
        r#"{"appName":"memrynote"}"#,
    )
    .unwrap();
    let profile = locate_profile(&env(root.path(), HostOs::Linux))
        .unwrap()
        .unwrap();
    assert_eq!(names(&profile), [LEGACY_APP_NAME, MEMRYNOTE_APP_NAME]);
}

#[test]
fn linux_without_store_prefers_memrynote() {
    let root = tempfile::tempdir().unwrap();
    make_profile(&root.path().join("memrynote"));
    let profile = locate_profile(&env(root.path(), HostOs::Linux))
        .unwrap()
        .unwrap();
    assert_eq!(names(&profile)[0], MEMRYNOTE_APP_NAME);
}

#[test]
fn unparseable_store_counts_as_loaded() {
    let root = tempfile::tempdir().unwrap();
    let dir = legacy(root.path());
    make_profile(&dir);
    fs::write(dir.join(SECRET_STORE_FILENAME), "garbage").unwrap();
    let profile = locate_profile(&env(root.path(), HostOs::MacOs))
        .unwrap()
        .unwrap();
    assert_eq!(names(&profile)[0], LEGACY_APP_NAME);
}

#[test]
fn override_dir_replaces_the_search() {
    let root = tempfile::tempdir().unwrap();
    make_profile(&root.path().join("memrynote"));
    let custom = root.path().join("custom");
    make_profile(&custom);
    let mut e = env(root.path(), HostOs::MacOs);
    e.override_dir = Some(custom.clone());
    assert_eq!(locate_profile(&e).unwrap().unwrap().dir, custom);
    e.override_dir = Some(root.path().join("absent"));
    assert!(locate_profile(&e).unwrap().is_none());
}

#[test]
fn reports_which_parts_exist() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("memrynote");
    make_profile(&dir);
    fs::create_dir_all(dir.join("Local Storage/leveldb")).unwrap();
    fs::create_dir_all(dir.join("crdt-stores/b")).unwrap();
    fs::create_dir_all(dir.join("crdt-stores/a")).unwrap();
    fs::write(dir.join("Custom Dictionary.txt"), "").unwrap();
    let profile = locate_profile(&env(root.path(), HostOs::MacOs))
        .unwrap()
        .unwrap();
    assert!(profile.has_config && profile.has_local_storage && profile.has_custom_dictionary);
    assert!(
        !profile.has_secure_store && !profile.has_local_state && !profile.has_legacy_crdt_store
    );
    assert_eq!(
        profile.crdt_store_dirs,
        [dir.join("crdt-stores/a"), dir.join("crdt-stores/b")]
    );
}

#[test]
fn env_derives_app_data_per_host() {
    let mut launch = LaunchEnv::default();
    launch.set("HOME", "/home/u");
    assert_eq!(
        ProfileEnv::from_env(&launch, HostOs::MacOs)
            .unwrap()
            .app_data,
        Path::new("/home/u/Library/Application Support")
    );
    assert_eq!(
        ProfileEnv::from_env(&launch, HostOs::Linux)
            .unwrap()
            .app_data,
        Path::new("/home/u/.config")
    );
    launch.set("XDG_CONFIG_HOME", "/xdg");
    assert_eq!(
        ProfileEnv::from_env(&launch, HostOs::Linux)
            .unwrap()
            .app_data,
        Path::new("/xdg")
    );
    assert!(ProfileEnv::from_env(&LaunchEnv::default(), HostOs::Windows).is_none());
    launch.set(PROFILE_DIR_VAR, "/tmp/p");
    let overridden = ProfileEnv::from_env(
        &LaunchEnv {
            vars: [(PROFILE_DIR_VAR.into(), "/tmp/p".into())].into(),
        },
        HostOs::Windows,
    )
    .unwrap();
    assert_eq!(
        overridden.override_dir.as_deref(),
        Some(Path::new("/tmp/p"))
    );
}

#[test]
fn vault_dir_name_matches_electron() {
    assert_eq!(
        vault_dir_name(" 0B6F6F08-3F0A-4D7D-9D0E-1D2C3B4A5F60 "),
        "0b6f6f08-3f0a-4d7d-9d0e-1d2c3b4a5f60"
    );
    // First 32 hex of sha256("../evil"), from node's createHash.
    assert_eq!(
        vault_dir_name("../evil"),
        "2d6afc710923ce47ddbfb2dc8b851f63"
    );
    assert_ne!(vault_dir_name("A"), vault_dir_name("a"));
}
