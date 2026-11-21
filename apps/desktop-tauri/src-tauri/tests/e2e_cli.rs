#![cfg(feature = "e2e")]
//! An e2e build's `--cli` runs under its control file, as its window does: the app data
//! folder the harness gave it, never the real registry (#3552 review).

use std::process::Command;

use memry_desktop::e2e::control::control_path;
use memry_desktop::paths::{DATA_DIR_VAR, DEVICE_VAR};
use serde_json::json;

#[test]
fn cli_reads_the_registry_in_the_control_files_app_data_dir() {
    let temp = tempfile::tempdir().expect("tempdir");
    let appdata = temp.path().join("appdata");
    let vault = temp.path().join("vault");
    std::fs::create_dir_all(&appdata).expect("appdata");
    std::fs::create_dir_all(&vault).expect("vault");
    let registry =
        json!({ "vaults": [{ "path": vault, "name": "e2e-cli-vault", "isDefault": true }] });
    std::fs::write(appdata.join("memry-config.json"), registry.to_string()).expect("registry");

    let port: u16 = 47_917;
    let control = control_path(temp.path(), port);
    std::fs::create_dir_all(control.parent().expect("control dir")).expect("control dir");
    let file = json!({
        "appDataDir": appdata,
        "logDir": temp.path().join("logs"),
        "device": "e2e-cli",
        "testVaultPath": null,
        "syncServerUrl": null,
    });
    std::fs::write(&control, file.to_string()).expect("control file");

    // `std::env::temp_dir()` of the child is `temp`, where the control file lives.
    let output = Command::new(env!("CARGO_BIN_EXE_memry-tauri"))
        .args(["--cli", "--json", "vault", "list"])
        .env("MEMRY_E2E", "1")
        .env("TAURI_WEBDRIVER_PORT", port.to_string())
        .env("TMPDIR", temp.path())
        .env("TMP", temp.path())
        .env("TEMP", temp.path())
        .env_remove(DATA_DIR_VAR)
        .env_remove(DEVICE_VAR)
        .output()
        .expect("run the app binary");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "exit {:?}, stderr {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    let vaults: serde_json::Value = serde_json::from_str(&stdout).expect("JSON list");
    assert_eq!(vaults[0]["name"], "e2e-cli-vault", "{stdout}");
}
