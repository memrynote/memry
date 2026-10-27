//! The GPU crash guard. When a launch saw the GPU process die (old or blocklisted Windows GPUs
//! create the window and never composite: process alive, nothing visible), the marker
//! `gpu-crash-guard.json` makes the next launch render in software, instead of stranding the user
//! on an invisible window. The marker is scoped to the app version, so an update retries hardware
//! acceleration and the guard never disables it for good
//! (`apps/desktop/src/main/gpu-crash-guard.ts`).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "gpu-crash-guard.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuGuardMarker {
    pub disabled_for_gpu: bool,
    pub version: String,
}

/// Only a marker that records a GPU crash for the version that is running disables hardware
/// acceleration. A marker of another version means a new build is in play.
pub fn should_disable_hw_accel(marker: Option<&GpuGuardMarker>, current_version: &str) -> bool {
    marker.is_some_and(|m| m.disabled_for_gpu && m.version == current_version)
}

/// How a GPU process ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuExit {
    Crashed,
    Unexpected,
    LaunchFailed,
    /// Killed on purpose, for example by the OS at shutdown.
    Terminated,
    /// Evicted under memory pressure.
    OutOfMemory,
}

/// Whether a GPU exit counts as a GPU fault. A terminate or an eviction is not one, and recording
/// it would disable hardware acceleration on the next launch for nothing.
pub fn should_record_gpu_crash(exit: GpuExit) -> bool {
    matches!(
        exit,
        GpuExit::Crashed | GpuExit::Unexpected | GpuExit::LaunchFailed
    )
}

/// WebView2's default browser arguments, which passing any arguments replaces
/// (`wry` `webview2/mod.rs`).
const WEBVIEW2_DEFAULT_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// The browser arguments of a Windows webview: `None` keeps WebView2's defaults, and a launch
/// that must render in software adds `--disable-gpu` to them.
pub fn windows_browser_args(disable_hw_accel: bool) -> Option<String> {
    disable_hw_accel.then(|| format!("{WEBVIEW2_DEFAULT_ARGS} --disable-gpu"))
}

fn marker_path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// A missing or corrupt marker reads as no prior GPU crash.
pub fn read(dir: &Path) -> Option<GpuGuardMarker> {
    let text = fs::read_to_string(marker_path(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn record(dir: &Path, version: &str) -> io::Result<()> {
    let marker = GpuGuardMarker {
        disabled_for_gpu: true,
        version: version.to_owned(),
    };
    let text = serde_json::to_string(&marker).map_err(io::Error::other)?;
    fs::write(marker_path(dir), text)
}

/// Decides this launch: true when hardware acceleration must be off. A marker of another version
/// is deleted, so the new build tries hardware acceleration again.
pub fn decide(dir: &Path, current_version: &str) -> io::Result<bool> {
    let Some(marker) = read(dir) else {
        return Ok(false);
    };
    if should_disable_hw_accel(Some(&marker), current_version) {
        return Ok(true);
    }
    match fs::remove_file(marker_path(dir)) {
        Ok(()) => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker(disabled: bool, version: &str) -> GpuGuardMarker {
        GpuGuardMarker {
            disabled_for_gpu: disabled,
            version: version.to_owned(),
        }
    }

    #[test]
    fn only_a_crash_recorded_for_this_version_disables_acceleration() {
        assert!(!should_disable_hw_accel(None, "1.0.0"));
        assert!(!should_disable_hw_accel(
            Some(&marker(false, "1.0.0")),
            "1.0.0"
        ));
        assert!(!should_disable_hw_accel(
            Some(&marker(true, "0.9.0")),
            "1.0.0"
        ));
        assert!(should_disable_hw_accel(
            Some(&marker(true, "1.0.0")),
            "1.0.0"
        ));
    }

    #[test]
    fn a_terminate_or_an_eviction_is_not_a_gpu_fault() {
        assert!(should_record_gpu_crash(GpuExit::Crashed));
        assert!(should_record_gpu_crash(GpuExit::Unexpected));
        assert!(should_record_gpu_crash(GpuExit::LaunchFailed));
        assert!(!should_record_gpu_crash(GpuExit::Terminated));
        assert!(!should_record_gpu_crash(GpuExit::OutOfMemory));
    }

    #[test]
    fn a_recorded_crash_disables_acceleration_on_the_same_version_only() {
        let dir = tempfile::tempdir().expect("tmp");
        assert!(!decide(dir.path(), "1.0.0").expect("decide"));
        record(dir.path(), "1.0.0").expect("record");
        assert!(decide(dir.path(), "1.0.0").expect("decide"));
        // Still there for the next launch of the same version.
        assert!(read(dir.path()).is_some());
        // An update retries hardware acceleration and drops the stale marker.
        assert!(!decide(dir.path(), "1.0.1").expect("decide"));
        assert!(read(dir.path()).is_none());
    }

    #[test]
    fn the_marker_keeps_the_electron_file_shape() {
        let dir = tempfile::tempdir().expect("tmp");
        record(dir.path(), "1.2.3").expect("record");
        let text = fs::read_to_string(dir.path().join(FILE_NAME)).expect("read");
        assert_eq!(text, r#"{"disabledForGpu":true,"version":"1.2.3"}"#);
        fs::write(
            dir.path().join(FILE_NAME),
            r#"{"disabledForGpu":true,"version":"1.2.3","future":1}"#,
        )
        .expect("write");
        assert_eq!(read(dir.path()), Some(marker(true, "1.2.3")));
    }

    #[test]
    fn software_rendering_adds_one_flag_to_the_default_arguments() {
        assert_eq!(windows_browser_args(false), None);
        assert_eq!(
            windows_browser_args(true).as_deref(),
            Some("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu")
        );
    }

    #[test]
    fn a_corrupt_marker_reads_as_no_crash() {
        let dir = tempfile::tempdir().expect("tmp");
        fs::write(dir.path().join(FILE_NAME), "not json").expect("write");
        assert!(!decide(dir.path(), "1.0.0").expect("decide"));
    }
}
