use std::fs;

use memry_desktop::e2e::control::{self, ControlError};
use memry_desktop::e2e::{E2E_VAR, E2eGate};
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::paths::AppPaths;

fn env(pairs: &[(&str, &str)]) -> LaunchEnv {
    let mut env = LaunchEnv::default();
    for (key, value) in pairs {
        env.set(key, value);
    }
    env
}

fn write_control(temp: &std::path::Path, port: u16, json: &str) {
    let path = control::control_path(temp, port);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, json).unwrap();
}

#[test]
fn gate_is_open_only_for_the_value_one() {
    assert!(E2eGate::from_env(&env(&[(E2E_VAR, "1")])).is_open());
    for closed in ["", "0", "true", "yes", " 1", "11"] {
        assert!(!E2eGate::from_env(&env(&[(E2E_VAR, closed)])).is_open());
    }
    assert!(!E2eGate::from_env(&env(&[])).is_open());
}

#[test]
fn port_comes_from_the_service_variable_with_a_default() {
    assert_eq!(control::webdriver_port(&env(&[])), 4445);
    assert_eq!(
        control::webdriver_port(&env(&[("TAURI_WEBDRIVER_PORT", "4446")])),
        4446
    );
    assert_eq!(
        control::webdriver_port(&env(&[("TAURI_WEBDRIVER_PORT", "junk")])),
        4445
    );
}

#[test]
fn control_file_overlays_the_launch_env_that_paths_read() {
    let temp = tempfile::tempdir().unwrap();
    write_control(
        temp.path(),
        4446,
        r#"{"appDataDir":"/t/data","logDir":"/t/logs","device":"e2e-abc-B",
            "testVaultPath":"/t/vault","syncServerUrl":"http://127.0.0.1:9",
            "extraEnv":{"MEMRY_TEST_DIALOG_RESULT":"confirm"}}"#,
    );
    let mut launch = env(&[("MEMRY_DEVICE", "A"), ("MEMRY_E2E", "1")]);

    control::load_in(temp.path(), 4446, &mut launch).unwrap();

    assert_eq!(launch.get("MEMRY_DEVICE"), Some("e2e-abc-B"));
    assert_eq!(launch.get("TEST_VAULT_PATH"), Some("/t/vault"));
    assert_eq!(launch.get("SYNC_SERVER_URL"), Some("http://127.0.0.1:9"));
    assert_eq!(launch.get("MEMRY_TEST_DIALOG_RESULT"), Some("confirm"));
    assert_eq!(launch.get("MEMRY_E2E"), Some("1"));
    let paths = AppPaths::resolve(&launch, "/d".into(), "/l".into());
    assert_eq!(paths.data_dir, std::path::PathBuf::from("/t/data"));
    assert_eq!(paths.log_dir, std::path::PathBuf::from("/t/logs"));
}

#[test]
fn null_vault_and_sync_url_leave_the_env_alone() {
    let temp = tempfile::tempdir().unwrap();
    write_control(
        temp.path(),
        4445,
        r#"{"appDataDir":"/t/d","logDir":"/t/l","device":"e2e-x","testVaultPath":null,"syncServerUrl":null}"#,
    );
    let mut launch = env(&[]);

    control::load_in(temp.path(), 4445, &mut launch).unwrap();

    assert_eq!(launch.get("TEST_VAULT_PATH"), None);
    assert_eq!(launch.get("SYNC_SERVER_URL"), None);
}

#[test]
fn a_missing_file_gets_the_isolated_default_profile_of_its_port() {
    let temp = tempfile::tempdir().unwrap();
    let mut a = env(&[]);
    let mut b = env(&[]);

    control::load_in(temp.path(), 4445, &mut a).unwrap();
    control::load_in(temp.path(), 4446, &mut b).unwrap();

    assert_eq!(a.get("MEMRY_DEVICE"), Some("e2e-default-4445"));
    assert_eq!(b.get("MEMRY_DEVICE"), Some("e2e-default-4446"));
    let root = temp.path().join("memry-e2e").join("default-4445");
    assert_eq!(a.get("MEMRY_APP_DATA_DIR"), root.to_str());
    assert_eq!(a.get("MEMRY_TEST_LOG_DIR"), root.join("logs").to_str());
    assert_ne!(a.get("MEMRY_APP_DATA_DIR"), b.get("MEMRY_APP_DATA_DIR"));
}

#[test]
fn a_malformed_file_is_an_error_naming_the_path() {
    let temp = tempfile::tempdir().unwrap();
    write_control(temp.path(), 4445, "{ not json");
    let mut launch = env(&[]);

    let error = control::load_in(temp.path(), 4445, &mut launch).unwrap_err();

    assert!(matches!(error, ControlError::Malformed { .. }));
    assert!(error.to_string().contains("control-4445.json"));
    assert_eq!(launch.get("MEMRY_DEVICE"), None);
}

#[test]
fn a_file_missing_a_required_field_is_malformed() {
    let temp = tempfile::tempdir().unwrap();
    write_control(temp.path(), 4445, r#"{"appDataDir":"/x"}"#);

    let error = control::load_in(temp.path(), 4445, &mut env(&[])).unwrap_err();

    assert!(matches!(error, ControlError::Malformed { .. }));
}
