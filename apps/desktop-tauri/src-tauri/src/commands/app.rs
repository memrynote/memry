use serde::Serialize;

use super::error::CommandError;
use crate::startup;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum BuildKind {
    Dev,
    Packaged,
}

impl BuildKind {
    pub fn current() -> Self {
        if tauri::is_dev() {
            Self::Dev
        } else {
            Self::Packaged
        }
    }
}

impl From<BuildKind> for memry_desktop::logging::BuildKind {
    fn from(kind: BuildKind) -> Self {
        match kind {
            BuildKind::Dev => Self::Dev,
            BuildKind::Packaged => Self::Packaged,
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub build_kind: BuildKind,
    pub e2e: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn app_info(app: tauri::AppHandle) -> Result<AppInfo, CommandError> {
    let platform = startup::node_platform().to_owned();
    // The launch smoke (`scripts/smoke-launch.mjs`) waits for this line.
    tracing::info!(platform = %platform, "renderer started");
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        platform,
        arch: std::env::consts::ARCH.to_owned(),
        build_kind: BuildKind::current(),
        e2e: cfg!(feature = "e2e"),
    })
}
