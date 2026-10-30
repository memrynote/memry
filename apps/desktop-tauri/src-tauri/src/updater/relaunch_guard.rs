//! The macOS relaunch guard at boot (`apps/desktop/src/main/index.ts`,
//! `showInstallingUpdateWindowAndExit`). The Dock icon vanishes while Velopack's updater swaps the
//! bundle, and a user who relaunches then starts the old build mid-swap. Booting it would open the
//! vault and offer the same update again while the updater replaces the files under it. So a
//! launch that finds its own install in flight shows the "Installing update" splash for two
//! seconds and exits. The decision is `memry_desktop::updater::guard::in_flight`.

use std::path::Path;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use memry_desktop::i18n::{self, Args};
use memry_desktop::paths::AppPaths;
use memry_desktop::telemetry::time::now_ms;
use memry_desktop::updater::guard::{self, InFlight};
use tauri::{AppHandle, Manager, Wry};

use super::velopack_backend::{self, Installed};
use crate::commands::error::CommandError;
use crate::startup;
use crate::windows::preboot::{self, PrebootCopy, show_preboot};

/// How long the splash stays on screen before the old build exits.
const SPLASH_EXIT: Duration = Duration::from_millis(2000);

/// How long the splash may take to appear. A slow first paint still shows the user what is
/// happening; a page that never loads does not keep the old build alive. So the old build lives
/// at most `SPLASH_SHOW_LIMIT + SPLASH_EXIT` past its decision.
const SPLASH_SHOW_LIMIT: Duration = Duration::from_secs(6);

/// Set by `main` when Velopack's updater started this process (`VelopackApp::on_restarted`): the
/// launch after Restart to install, or the old build again after a failed swap.
static LAUNCHED_BY_UPDATER: AtomicBool = AtomicBool::new(false);

/// The install as this process found it at the top of `main`.
static STARTED_AS: OnceLock<Option<Installed>> = OnceLock::new();

pub fn note_launched_by_updater() {
    LAUNCHED_BY_UPDATER.store(true, Ordering::SeqCst);
}

/// Reads `sq.version` before anything else of the launch runs. The guard decides much later, and
/// a swap that finishes in between would otherwise make the old build read the new version and
/// boot (#3729). Only macOS has the guard.
pub fn note_installed_at_start() {
    if cfg!(target_os = "macos") {
        STARTED_AS.get_or_init(velopack_backend::installed);
    }
}

/// The first registration of the `Guards` stage, before the crash monitor starts a child process
/// of this bundle. A normal boot drops the marker; the hand-off of this run writes a new one.
pub fn apply(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let data_dir = app.state::<AppPaths>().data_dir.clone();
    // One file read on a normal boot; the version lookups and the process probe only run when a
    // marker is there.
    let Some(marker) = guard::read(&data_dir) else {
        return Ok(());
    };
    let started = STARTED_AS.get_or_init(velopack_backend::installed);
    let started_as = started.as_ref().map_or_else(
        || app.package_info().version.to_string(),
        |installed| installed.version.clone(),
    );
    let now = i64::try_from(now_ms()).unwrap_or(i64::MAX);
    let in_flight = guard::in_flight(
        Some(&marker),
        &started_as,
        now,
        LAUNCHED_BY_UPDATER.load(Ordering::SeqCst),
        || velopack_backend::installed().map(|installed| installed.version),
        // Outside a Velopack install no updater of this bundle can run.
        || {
            started
                .as_ref()
                .is_some_and(|installed| updater_alive(&installed.root))
        },
    );
    let Some(in_flight) = in_flight else {
        guard::clear(&data_dir);
        return Ok(());
    };
    tracing::info!(
        scope = "UpdaterGuard",
        "pending update install in flight on launch ({}, started as {started_as}); showing the {} splash and exiting",
        match in_flight {
            InFlight::Updating => "updater running",
            InFlight::Replaced => "bundle replaced since launch",
        },
        if marker.restart {
            "restart"
        } else {
            "quit-install"
        },
    );
    // Scheduled before the copy is looked up: these bounds are how long the old build stays
    // alive, and localizing the splash must not extend them.
    let (shown, on_screen) = mpsc::channel::<()>();
    let exiting = app.clone();
    std::thread::spawn(move || {
        // The splash stays two seconds once it is on screen, not from the decision: on a slow
        // machine the first paint takes most of that (#3728). A splash that failed sends nothing
        // and drops the sender, which ends the wait at once.
        let _ = on_screen.recv_timeout(SPLASH_SHOW_LIMIT);
        std::thread::sleep(SPLASH_EXIT);
        exiting.exit(0);
    });
    // The config is not loaded yet, so the copy follows the OS language. After an install at a
    // normal quit nothing reopens the app, so the splash does not promise it.
    let locale = preboot::locale(app);
    let subtitle = if marker.restart {
        i18n::t(
            locale,
            "system:startup.installingUpdate.subtitle",
            &Args::new(),
        )
    } else {
        i18n::t(
            locale,
            "system:startup.installingUpdate.subtitleAfterQuit",
            &Args::new(),
        )
    };
    let copy = PrebootCopy {
        title: i18n::t(
            locale,
            "system:startup.installingUpdate.title",
            &Args::new(),
        ),
        subtitle,
    };
    let on_shown = move || {
        tracing::info!(scope = "UpdaterGuard", "installing splash shown");
        let _ = shown.send(());
    };
    if let Err(error) = show_preboot(app, copy, on_shown) {
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
