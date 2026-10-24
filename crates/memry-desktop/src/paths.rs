use std::path::{Component, PathBuf};

use sha2::{Digest, Sha256};

use crate::launch_env::LaunchEnv;

/// Replaces the data directory. New with the Tauri app.
pub const DATA_DIR_VAR: &str = "MEMRY_APP_DATA_DIR";
/// Replaces the log directory, as `apps/desktop/src/main/lib/logger.ts` honors it.
pub const LOG_DIR_VAR: &str = "MEMRY_TEST_LOG_DIR";
/// Device profile switch: `A`, `B`, `C`, `dev`.
pub const DEVICE_VAR: &str = "MEMRY_DEVICE";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
}

impl AppPaths {
    /// The two overrides replace the Tauri defaults and nothing else does. Device separation is
    /// not a suffix here: it lives in the context identifier ([`profile_identifier`]), which
    /// the defaults already follow.
    pub fn resolve(env: &LaunchEnv, default_data: PathBuf, default_log: PathBuf) -> Self {
        let pick = |var: &str, default: PathBuf| match env.get(var) {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => default,
        };
        Self {
            data_dir: pick(DATA_DIR_VAR, default_data),
            log_dir: pick(LOG_DIR_VAR, default_log),
        }
    }
}

/// The bundle identifier of this run: `base` without a device, `<base>.<device>` with one.
///
/// An unpackaged `dev` device becomes `dev-<first 8 hex of sha256(checkout_dir)>`, the rule of
/// `resolveDeviceId` in `apps/desktop/src/main/index.ts`, so plain `pnpm dev:tauri` keeps one
/// profile per checkout. `main.rs` sets the Tauri context identifier to this value, so
/// `app_data_dir()`, `app_log_dir()`, the webview profile and the single-instance identity all
/// follow one mechanism.
pub fn profile_identifier(
    base: &str,
    env: &LaunchEnv,
    packaged: bool,
    checkout_dir: &str,
) -> String {
    let device = match env.get(DEVICE_VAR) {
        Some(device) if !device.is_empty() => device,
        _ => return base.to_owned(),
    };
    if device == "dev" && !packaged {
        let digest = Sha256::digest(normalize(checkout_dir).as_bytes());
        return format!("{base}.dev-{}", &hex::encode(digest)[..8]);
    }
    format!("{base}.{device}")
}

/// Lexical path normalization, the equivalent of Node's `path.normalize` for the hash input.
fn normalize(path: &str) -> String {
    let mut out = PathBuf::new();
    for component in std::path::Path::new(path).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().into_owned()
}
