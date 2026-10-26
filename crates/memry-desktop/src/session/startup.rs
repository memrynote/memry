//! Which vault the app opens at launch (`autoOpenLastVault`, `vault/index.ts:1394`).

use std::path::PathBuf;

use crate::launch_env::LaunchEnv;
use crate::registry::AppConfig;

/// `1` shows the picker whatever `currentVault` says.
pub const FORCE_VAULT_PICKER_VAR: &str = "MEMRY_FORCE_VAULT_PICKER";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupVault {
    Open(PathBuf),
    Picker,
}

/// `Picker` when the env forces it; else `currentVault` when that folder exists and holds
/// `.memry/` (`isVaultInitialized`); else `Picker`. The e2e harness replaces Electron's
/// `TEST_VAULT_PATH` by preparing `currentVault` in its app data dir.
pub fn resolve_startup_vault(config: &AppConfig, env: &LaunchEnv) -> StartupVault {
    if env.get(FORCE_VAULT_PICKER_VAR) == Some("1") {
        return StartupVault::Picker;
    }
    let current = config.read(|map| {
        map.get("currentVault")
            .and_then(serde_json::Value::as_str)
            .map(PathBuf::from)
    });
    match current {
        Some(path) if path.join(".memry").exists() => StartupVault::Open(path),
        _ => StartupVault::Picker,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_with(current: &str, dir: &std::path::Path) -> AppConfig {
        let file = dir.join("memry-config.json");
        std::fs::write(
            &file,
            serde_json::json!({ "currentVault": current }).to_string(),
        )
        .expect("seed");
        AppConfig::load(file)
    }

    #[test]
    fn the_current_vault_opens_only_when_it_is_there_and_initialized() {
        let dir = tempfile::tempdir().expect("dir");
        let vault = dir.path().join("v");
        std::fs::create_dir_all(vault.join(".memry")).expect("vault");
        let env = LaunchEnv::default();
        let config = config_with(&vault.to_string_lossy(), dir.path());
        assert_eq!(
            resolve_startup_vault(&config, &env),
            StartupVault::Open(vault.clone())
        );

        let bare = dir.path().join("bare");
        std::fs::create_dir(&bare).expect("bare");
        let config = config_with(&bare.to_string_lossy(), dir.path());
        assert_eq!(resolve_startup_vault(&config, &env), StartupVault::Picker);

        let config = config_with(&dir.path().join("gone").to_string_lossy(), dir.path());
        assert_eq!(resolve_startup_vault(&config, &env), StartupVault::Picker);
    }

    #[test]
    fn force_vault_picker_wins() {
        let dir = tempfile::tempdir().expect("dir");
        let vault = dir.path().join("v");
        std::fs::create_dir_all(vault.join(".memry")).expect("vault");
        let config = config_with(&vault.to_string_lossy(), dir.path());
        let mut env = LaunchEnv::default();
        env.set(FORCE_VAULT_PICKER_VAR, "1");
        assert_eq!(resolve_startup_vault(&config, &env), StartupVault::Picker);
        env.set(FORCE_VAULT_PICKER_VAR, "0");
        assert_eq!(
            resolve_startup_vault(&config, &env),
            StartupVault::Open(vault)
        );
    }

    #[test]
    fn no_current_vault_is_the_picker() {
        let dir = tempfile::tempdir().expect("dir");
        let config = AppConfig::load(dir.path().join("memry-config.json"));
        assert_eq!(
            resolve_startup_vault(&config, &LaunchEnv::default()),
            StartupVault::Picker
        );
    }
}
