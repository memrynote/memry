//! The macOS relaunch guard at boot (`apps/desktop/src/main/index.ts`,
//! `showInstallingUpdateWindowAndExit`). The Dock icon vanishes while Velopack's updater swaps the
//! bundle, and a user who relaunches then starts the old build mid-swap. Booting it would open the
//! vault and offer the same update again while the updater replaces the files under it. So a
//! launch that finds its own install in flight shows the "Installing update" splash for two
//! seconds and exits. The decision is `memry_desktop::updater::guard`.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use memry_desktop::i18n::{self, Args};
use memry_desktop::paths::AppPaths;
use memry_desktop::telemetry::time::now_ms;
use memry_desktop::updater::guard;
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::CommandError;
use crate::startup;
use crate::windows::preboot::{self, PrebootCopy, show_preboot};

/// How long the old build may stay alive. Velopack's updater gives up after 60 s, and this
/// process stays out of the way well before that.
const SPLASH_EXIT: Duration = Duration::from_millis(2000);

/// Set by `main` when Velopack's updater started this process (`VelopackApp::on_restarted`): the
/// launch after Restart to install, or the old build again after a failed swap.
static LAUNCHED_BY_UPDATER: AtomicBool = AtomicBool::new(false);

pub fn note_launched_by_updater() {
    LAUNCHED_BY_UPDATER.store(true, Ordering::SeqCst);
}

/// The first registration of the `Guards` stage, before the crash monitor starts a child process
/// of this bundle. A normal boot drops the marker; the hand-off of this run writes a new one.
pub fn apply(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let data_dir = app.state::<AppPaths>().data_dir.clone();
    // One file read on a normal boot; the version lookup and the process probe only run when a
    // marker is there.
    let Some(marker) = guard::read(&data_dir) else {
        return Ok(());
    };
    let installed = super::velopack_backend::installed();
    let current = installed.as_ref().map_or_else(
        || app.package_info().version.to_string(),
        |installed| installed.version.clone(),
    );
    let now = i64::try_from(now_ms()).unwrap_or(i64::MAX);
    let guarded = guard::should_guard(
        Some(&marker),
        &current,
        now,
        LAUNCHED_BY_UPDATER.load(Ordering::SeqCst),
        // Outside a Velopack install no updater of this bundle can run.
        || installed.is_some_and(|installed| updater_alive(&installed.root)),
    );
    if !guarded {
        guard::clear(&data_dir);
        return Ok(());
    }
    tracing::info!(
        scope = "UpdaterGuard",
        "pending update install in flight on launch; showing splash and exiting"
    );
    // Scheduled before the copy is looked up: this bound is how long the old build stays alive,
    // and localizing the splash must not extend it.
    let exiting = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SPLASH_EXIT);
        exiting.exit(0);
    });
    // The config is not loaded yet, so the copy follows the OS language.
    let locale = preboot::locale(app);
    let copy = PrebootCopy {
        title: i18n::t(
            locale,
            "system:startup.installingUpdate.title",
            &Args::new(),
        ),
        subtitle: i18n::t(
            locale,
            "system:startup.installingUpdate.subtitle",
            &Args::new(),
        ),
    };
    if let Err(error) = show_preboot(app, copy) {
        tracing::warn!(
            scope = "UpdaterGuard",
            "installing splash not shown: {error}"
        );
    }
    startup::halt_boot();
    Ok(())
}

#[cfg(unix)]
fn updater_alive(root: &Path) -> bool {
    guard::updater_alive(root)
}

#[cfg(not(unix))]
fn updater_alive(_root: &Path) -> bool {
    false
}
