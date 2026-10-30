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

/// The install as this process found it at the top of `main`. `None` outside a Velopack install
/// or when `sq.version` cannot be read: the guard then compares the app's own version and probes
/// no updater, so it fails open and the launch boots.
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
    // A normal boot reads only the marker here (`main` read the install). The second read of the
    // bundle and the process probe run only when a marker is there.
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
        "pending update install in flight on launch ({}, started as {started_as}); showing the open-again splash and exiting",
        match in_flight {
            InFlight::Updating => "updater running",
            InFlight::Replaced => "bundle replaced since launch",
        },
    );
    // Scheduled before the copy is looked up: these bounds are how long the old build stays
    // alive, and localizing the splash must not extend them.
    let (shown, on_screen) = mpsc::channel::<()>();
    let exiting = app.clone();
    std::thread::spawn(move || {
        exit_after_splash(&on_screen, SPLASH_SHOW_LIMIT, SPLASH_EXIT, || {
            exiting.exit(0);
        });
    });
    // The config is not loaded yet, so the copy follows the OS language.
    let copy = splash_copy(preboot::locale(app));
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

/// The splash never says the app reopens by itself (#3728): nothing does after an install at a
/// quit, and after Restart to install this process holds the single-instance lock while it lives,
/// so it absorbs the updater's own start of the new build when that start comes first (#3773).
fn splash_copy(locale: &str) -> PrebootCopy {
    PrebootCopy {
        title: i18n::t(
            locale,
            "system:startup.installingUpdate.title",
            &Args::new(),
        ),
        subtitle: i18n::t(
            locale,
            "system:startup.installingUpdate.subtitleOpenAgain",
            &Args::new(),
        ),
    }
}

/// Ends the old build `stay` after its splash is on screen, not after the decision: on a slow
/// machine the first paint takes most of two seconds (#3728). A splash that never appears ends it
/// `show_limit + stay` after the decision, and one that failed to build drops the sender, which
/// ends the wait at once.
fn exit_after_splash(
    on_screen: &mpsc::Receiver<()>,
    show_limit: Duration,
    stay: Duration,
    exit: impl FnOnce(),
) {
    let _ = on_screen.recv_timeout(show_limit);
    std::thread::sleep(stay);
    exit();
}

#[cfg(unix)]
fn updater_alive(root: &Path) -> bool {
    guard::updater_alive(root)
}

#[cfg(not(unix))]
fn updater_alive(_root: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use super::*;

    /// #3729: `main` reads the install right after Velopack's hook, before the crash monitor,
    /// the Tauri builder and the guard; a read anywhere later sees a swap that finished meanwhile.
    #[test]
    fn main_reads_the_install_as_its_next_statement_after_the_velopack_hook() {
        let main = include_str!("../main.rs");
        let hook = main.find(".run();").expect("the Velopack hook in main");
        let next = main[hook + ".run();".len()..]
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty() && !line.starts_with("//"))
            .expect("a statement after the hook");
        assert_eq!(
            next,
            "memry_tauri::updater::relaunch_guard::note_installed_at_start();"
        );
    }

    #[test]
    fn the_splash_stays_its_time_once_on_screen_however_late_it_appears() {
        let stay = Duration::from_millis(200);
        let log = Arc::new(Mutex::new(Vec::new()));
        let (shown, on_screen) = mpsc::channel();
        let started = Instant::now();
        let exiting = {
            let log = log.clone();
            std::thread::spawn(move || {
                exit_after_splash(&on_screen, Duration::from_secs(30), stay, || {
                    log.lock().unwrap().push(("exit", started.elapsed()));
                });
            })
        };
        // A first paint later than the stay itself: counting from the decision would exit first.
        std::thread::sleep(Duration::from_millis(300));
        log.lock().unwrap().push(("shown", started.elapsed()));
        shown.send(()).unwrap();
        exiting.join().unwrap();
        let log = log.lock().unwrap();
        assert_eq!(
            log.iter().map(|(event, _)| *event).collect::<Vec<_>>(),
            ["shown", "exit"]
        );
        assert!(log[1].1 >= log[0].1 + stay, "{log:?}");
    }

    #[test]
    fn the_splash_asks_to_open_the_app_again_and_never_promises_a_reopen() {
        let copy = splash_copy("en");
        assert_eq!(copy.subtitle, "Open MemryNote again in a moment.");
        assert_eq!(
            copy.title,
            i18n::t("en", "system:startup.installingUpdate.title", &Args::new())
        );
    }

    /// Runs `exit_after_splash` on its own thread and returns when it exited, measured from the
    /// start. The bound only turns a wait without a limit into a failure instead of a hung run.
    fn exit_time(on_screen: mpsc::Receiver<()>, show_limit: Duration, stay: Duration) -> Duration {
        let started = Instant::now();
        let (done, exited) = mpsc::channel();
        std::thread::spawn(move || {
            exit_after_splash(&on_screen, show_limit, stay, || {
                let _ = done.send(started.elapsed());
            });
        });
        exited
            .recv_timeout(Duration::from_secs(60))
            .expect("the old build never exited")
    }

    #[test]
    fn a_splash_that_never_appears_still_ends_the_old_build() {
        let (show_limit, stay) = (Duration::from_millis(150), Duration::from_millis(100));
        let (kept, on_screen) = mpsc::channel::<()>();
        assert!(exit_time(on_screen, show_limit, stay) >= show_limit + stay);
        drop(kept);

        // A splash that failed to build dropped its sender: only the stay is left.
        let (dropped, on_screen) = mpsc::channel::<()>();
        drop(dropped);
        exit_time(on_screen, Duration::from_secs(30), stay);
    }
}
