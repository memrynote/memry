//! The per-instance control file. The WDIO service starts every app with the same environment,
//! so two instances tell themselves apart by the WebDriver port the service gave each one and
//! read their launch overrides from `<temp dir>/memry-e2e/control-<port>.json`.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::launch_env::LaunchEnv;
use crate::paths::{DATA_DIR_VAR, DEVICE_VAR, LOG_DIR_VAR};

/// The port the service sets for the app. Absent means the plugin default.
pub const PORT_VAR: &str = "TAURI_WEBDRIVER_PORT";
/// The embedded WebDriver plugin's default port.
pub const DEFAULT_PORT: u16 = 4445;
pub const VAULT_VAR: &str = "TEST_VAULT_PATH";
pub const SYNC_URL_VAR: &str = "SYNC_SERVER_URL";

const DIR: &str = "memry-e2e";

/// The JSON the harness writes. Field names are the harness contract.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlFile {
    pub app_data_dir: String,
    pub log_dir: String,
    pub device: String,
    pub test_vault_path: Option<String>,
    pub sync_server_url: Option<String>,
    #[serde(default)]
    pub extra_env: BTreeMap<String, String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ControlError {
    #[error("cannot read control file {}: {source}", path.display())]
    Read { path: PathBuf, source: io::Error },
    #[error("malformed control file {}: {source}", path.display())]
    Malformed {
        path: PathBuf,
        source: serde_json::Error,
    },
}

/// The port of this instance: `TAURI_WEBDRIVER_PORT`, else the plugin default.
pub fn webdriver_port(env: &LaunchEnv) -> u16 {
    env.get(PORT_VAR)
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

pub fn control_path(temp_dir: &Path, port: u16) -> PathBuf {
    temp_dir.join(DIR).join(format!("control-{port}.json"))
}

/// The profile of an instance whose harness has not written a control file yet: private dirs
/// keyed by port, so an e2e build never touches the real app data or the real keychain accounts.
fn default_profile(temp_dir: &Path, port: u16) -> ControlFile {
    let root = temp_dir.join(DIR).join(format!("default-{port}"));
    ControlFile {
        app_data_dir: root.to_string_lossy().into_owned(),
        log_dir: root.join("logs").to_string_lossy().into_owned(),
        device: format!("e2e-default-{port}"),
        test_vault_path: None,
        sync_server_url: None,
        extra_env: BTreeMap::new(),
    }
}

/// Overlays the control file of this instance onto `env`. Call it only with an open gate,
/// right after `LaunchEnv::from_process()` and before the profile identifier is computed.
pub fn load(env: &mut LaunchEnv) -> Result<ControlFile, ControlError> {
    let port = webdriver_port(env);
    load_in(&std::env::temp_dir(), port, env)
}

/// [`load`] with the temp dir and port given.
pub fn load_in(
    temp_dir: &Path,
    port: u16,
    env: &mut LaunchEnv,
) -> Result<ControlFile, ControlError> {
    let path = control_path(temp_dir, port);
    let file = match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|source| ControlError::Malformed {
            path: path.clone(),
            source,
        })?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => default_profile(temp_dir, port),
        Err(source) => return Err(ControlError::Read { path, source }),
    };
    overlay(&file, env);
    Ok(file)
}

fn overlay(file: &ControlFile, env: &mut LaunchEnv) {
    env.set(DATA_DIR_VAR, &file.app_data_dir);
    env.set(LOG_DIR_VAR, &file.log_dir);
    env.set(DEVICE_VAR, &file.device);
    if let Some(vault) = &file.test_vault_path {
        env.set(VAULT_VAR, vault);
    }
    if let Some(url) = &file.sync_server_url {
        env.set(SYNC_URL_VAR, url);
    }
    for (key, value) in &file.extra_env {
        env.set(key, value);
    }
}
