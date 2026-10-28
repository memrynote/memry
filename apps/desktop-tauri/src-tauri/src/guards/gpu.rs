//! The GPU crash guard around the Tauri webview. The decision and the marker file are
//! `memry_desktop::shell::gpu_guard`; this module applies the decision before the webview exists
//! and records a GPU fault so the next launch renders in software. macOS has no switch, so it
//! never disables acceleration. The Electron `enable-unsafe-swiftshader` switch has no
//! equivalent and is dropped.

use std::path::PathBuf;

use memry_desktop::paths::AppPaths;
use memry_desktop::shell::gpu_guard::{self, GpuExit};
use memry_desktop::telemetry::main_warning::Level;
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::CommandError;
use crate::shell::services::telemetry;

/// What this launch decided, managed so the window builder and the recorders can read it.
pub struct GpuGuard {
    pub disabled: bool,
    data_dir: PathBuf,
    version: String,
}

/// A development run (`tauri dev`) never reads or writes the marker, as an unpackaged Electron
/// run did not.
fn packaged() -> bool {
    !tauri::is_dev()
}

/// Runs before any window: reads the marker and, when this version crashed the GPU, switches the
/// rendering to software where the platform has a switch.
pub fn apply(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let data_dir = app.state::<AppPaths>().data_dir.clone();
    let version = app.package_info().version.to_string();
    let disabled = packaged()
        && gpu_guard::decide(&data_dir, &version).unwrap_or_else(|error| {
            tracing::warn!(
                scope = "GpuCrashGuard",
                "could not read the gpu-crash marker: {error}"
            );
            false
        });
    if disabled {
        tracing::warn!(
            scope = "GpuCrashGuard",
            "hardware acceleration disabled after a prior GPU crash on this version"
        );
        #[cfg(target_os = "linux")]
        disable_webkit_acceleration();
    }
    app.manage(GpuGuard {
        disabled,
        data_dir,
        version,
    });
    Ok(())
}

/// WebKitGTK reads these when it starts its web process, which happens at the first webview.
#[cfg(target_os = "linux")]
fn disable_webkit_acceleration() {
    // SAFETY: runs in the startup stage, before the first webview starts its web process, which
    // is the only reader of these two variables.
    unsafe {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

/// The telemetry half of [`apply`]: runs once the telemetry service exists.
pub fn report(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    if app.state::<GpuGuard>().disabled
        && let Some(service) = telemetry(app)
    {
        service.track_main_log(
            Level::Warn,
            "GpuCrashGuard",
            "hw_accel_disabled",
            None,
            None,
            None,
        );
    }
    Ok(())
}

/// The arguments of the Windows webview for this launch. Before the guard stage ran (a startup
/// failure), acceleration counts as on.
#[cfg(windows)]
pub fn browser_args(app: &AppHandle<Wry>) -> Option<String> {
    gpu_guard::windows_browser_args(
        app.try_state::<GpuGuard>()
            .is_some_and(|guard| guard.disabled),
    )
}

/// Records that the GPU process died, so the next launch falls back to software rendering.
pub fn record(app: &AppHandle<Wry>, exit: GpuExit) {
    if !packaged() || !gpu_guard::should_record_gpu_crash(exit) {
        return;
    }
    let Some(guard) = app.try_state::<GpuGuard>() else {
        return;
    };
    match gpu_guard::record(&guard.data_dir, &guard.version) {
        Ok(()) => tracing::warn!(
            scope = "GpuCrashGuard",
            "recorded GPU crash; hardware acceleration will be disabled on next launch"
        ),
        Err(error) => tracing::warn!(
            scope = "GpuCrashGuard",
            "failed to write gpu-crash marker: {error}"
        ),
    }
}

/// The window was revealed by the 10 s fallback, not by a first paint: the page never painted,
/// which on Windows and Linux is what a dead GPU process looks like.
pub fn record_reveal_fallback(app: &AppHandle<Wry>) {
    if cfg!(any(windows, target_os = "linux")) {
        record(app, GpuExit::Unexpected);
    }
}
