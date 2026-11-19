//! The first-run wizard's detection (`onboarding:*`, `onboarding-handlers.ts`). These run
//! before any vault is open.

use std::path::{Path, PathBuf};

use memry_desktop::onboarding::{self, OnboardingSources};
use memry_desktop::vault::init::is_vault_initialized;
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};

/// `onboarding:detect-sources`: note apps installed on this computer, and Obsidian's vaults.
#[tauri::command]
#[specta::specta]
pub async fn onboarding_detect_sources(
    app: AppHandle<Wry>,
) -> Result<OnboardingSources, CommandError> {
    let app_data = os_app_data(&app)?;
    let home = app.path().home_dir().map_err(path_error)?;
    blocking("onboarding_detect_sources", move || {
        Ok(onboarding::detect_sources(&app_data, &home))
    })
    .await
}

/// `onboarding:is-memry-vault`: whether a folder the user picked already has `.memry`.
#[tauri::command]
#[specta::specta]
pub async fn onboarding_is_memry_vault(path: String) -> Result<bool, CommandError> {
    blocking("onboarding_is_memry_vault", move || {
        Ok(is_vault_initialized(Path::new(&path)))
    })
    .await
}

/// Electron's `app.getPath('appData')`, where Obsidian keeps `obsidian.json`. Under an open e2e
/// gate, `MEMRY_TEST_OS_APP_DATA_DIR` replaces it, so a test run never lists the host's vaults.
fn os_app_data(app: &AppHandle<Wry>) -> Result<PathBuf, CommandError> {
    #[cfg(feature = "e2e")]
    {
        use memry_desktop::e2e::E2eGate;
        use memry_desktop::launch_env::LaunchEnv;

        let env = app.state::<LaunchEnv>();
        if E2eGate::from_env(&env).is_open()
            && let Some(dir) = env.get("MEMRY_TEST_OS_APP_DATA_DIR")
        {
            return Ok(PathBuf::from(dir));
        }
    }
    app.path().config_dir().map_err(path_error)
}

fn path_error(error: tauri::Error) -> CommandError {
    let error = CommandError::new(ErrorKind::Internal, "path_unavailable", error.to_string());
    super::error::log_failure("onboarding_detect_sources", &error);
    error
}
