//! The command line resolves the app data folder without Tauri (`memrynote_cli::app_data_dir`).
//! It must be the folder Tauri gives the app, or the two read different `memry-config.json`.

use tauri::Manager;

#[test]
fn default_data_dir_is_the_app_data_dir_tauri_resolves() {
    let app = tauri::test::mock_app();
    let identifier = app.config().identifier.clone();
    assert_eq!(
        memry_desktop::paths::default_data_dir(&identifier),
        Some(app.path().app_data_dir().expect("tauri app data dir")),
    );
}
