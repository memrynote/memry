//! The macOS relaunch guard at boot (`apps/desktop/src/main/index.ts`,
//! `showInstallingUpdateWindowAndExit`). The Dock icon vanishes while Velopack's updater swaps the
//! bundle, and a user who relaunches then starts the old build mid-swap. Booting it would open the
//! vault and offer the same update again while the updater replaces the files under it. So a
//! launch that finds its own install in flight shows the "Installing update" splash for two
//! seconds and exits. The decision is `memry_desktop::updater::guard::in_flight`.
//!
//! The guarded launch holds the single-instance lock from the plugin's setup until it exits, so a
//! launch in that time hands itself over and exits: after Restart to install that is the
//! updater's own start of the new build (#3773). The guarded launch then opens its bundle once,
//! after it released the lock (`hand_off_on_exit`), so the absorbed launch happens after all.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

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

/// Set when another launch handed itself to this process through the single-instance plugin
/// (`instance.rs`), whether or not the guard has decided yet.
static HANDED_OVER: AtomicBool = AtomicBool::new(false);

/// The bundle a guarded launch opens after it exits. Set only when the guard halts the boot.
static HAND_OFF_TO: OnceLock<PathBuf> = OnceLock::new();

/// How long the exit of a guarded launch waits, once its lock is released, for a hand-over that
/// was queued on the socket just before: that launch has already exited, and only the listener
/// that is still running here can record it. Reading the queued bytes takes milliseconds.
const HAND_OVER_DRAIN: Duration = Duration::from_millis(500);

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
    // `in_flight` holds a launch back only inside a Velopack install, so the bundle is known.
    if let Some(installed) = started {
        let _ = HAND_OFF_TO.set(installed.root.clone());
    }
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

/// Called for every launch that handed itself to this process (`instance.rs`).
pub fn note_handed_over() {
    HANDED_OVER.store(true, Ordering::SeqCst);
    if HAND_OFF_TO.get().is_some() {
        tracing::info!(
            scope = "UpdaterGuard",
            "a launch handed itself to the guarded launch; the app opens once this process exits"
        );
    }
}

/// `RunEvent::Exit` of a halted boot: a guarded launch that took over another launch opens its
/// bundle once. The run callback sees `Exit` after the plugins (tauri `app.rs`
/// `on_event_loop_event`, pinned by `tests/startup.rs`), so the single-instance plugin has
/// removed its socket by now and the new launch cannot hand itself to this exiting process
/// again. It binds the lock itself, or hands itself to whatever bound it since, so this never
/// starts a second instance. The bundle holds the new build once the updater has swapped it, or
/// the old one mid-swap, whose guard then decides again.
pub fn hand_off_on_exit() {
    let Some(bundle) = HAND_OFF_TO.get() else {
        return;
    };
    if !handed_over_within(&HANDED_OVER, HAND_OVER_DRAIN) {
        return;
    }
    match open_again(bundle).spawn() {
        Ok(_) => tracing::info!(
            scope = "UpdaterGuard",
            "opened {} for the launch the guarded launch took over",
            bundle.display()
        ),
        Err(error) => tracing::error!(
            scope = "UpdaterGuard",
            "could not open {} for the launch the guarded launch took over: {error}",
            bundle.display()
        ),
    }
}

/// Whether a hand-over was recorded by now or arrives within `drain`.
fn handed_over_within(handed_over: &AtomicBool, drain: Duration) -> bool {
    let deadline = Instant::now() + drain;
    loop {
        if handed_over.load(Ordering::SeqCst) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// `-n`: this process is still alive, and without it LaunchServices would only activate it. The
/// updater starts the app the same way (velopack `util_osx.rs` `start_package`).
fn open_again(bundle: &Path) -> Command {
    let mut command = Command::new("/usr/bin/open");
    command
        .arg("-n")
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

/// The splash never says the app reopens by itself (#3728): nothing does after an install at a
/// quit, and after Restart to install the new build may well have started on its own already.
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

    /// #3773: the updater's start of the new build can reach the guarded launch while it is
    /// still alive, in the last moment before its lock goes too.
    #[test]
    fn a_hand_over_recorded_before_or_during_the_drain_opens_the_app() {
        let early = AtomicBool::new(true);
        assert!(handed_over_within(&early, Duration::ZERO));

        let late = Arc::new(AtomicBool::new(false));
        let (done, finished) = mpsc::channel();
        {
            let late = late.clone();
            std::thread::spawn(move || {
                let _ = done.send(handed_over_within(&late, Duration::from_secs(3600)));
            });
        }
        std::thread::sleep(Duration::from_millis(100));
        late.store(true, Ordering::SeqCst);
        assert!(
            finished
                .recv_timeout(Duration::from_secs(60))
                .expect("the drain ignored the hand-over")
        );
    }

    #[test]
    fn no_hand_over_opens_nothing() {
        assert!(!handed_over_within(
            &AtomicBool::new(false),
            Duration::from_millis(50)
        ));
    }

    #[test]
    fn the_app_opens_as_a_new_instance_of_the_bundle() {
        let bundle = Path::new("/Applications/Memry Note (2).app");
        let command = open_again(bundle);
        assert_eq!(command.get_program(), "/usr/bin/open");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [std::ffi::OsStr::new("-n"), bundle.as_os_str()]
        );
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

        // A splash that failed to build dropped its sender: only the stay is left. The show limit
        // is far above the watchdog of `exit_time`, so waiting it out fails the test.
        let (dropped, on_screen) = mpsc::channel::<()>();
        drop(dropped);
        exit_time(on_screen, Duration::from_secs(3600), stay);
    }
}
