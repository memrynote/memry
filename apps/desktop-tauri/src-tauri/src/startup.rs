use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Runtime, Wry};

use crate::commands::error::CommandError;

/// The one startup type of the epic. Steps 08 (#3525) and 09 (#3526) extend this struct in
/// place; no second startup type exists. The renderer reads it from `window.__MEMRY_STARTUP__`
/// before first paint.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StartupState {
    pub theme: String,
    pub locale: String,
    pub zoom: f64,
    pub platform: String,
    pub color_theme: Option<serde_json::Value>,
    pub accent_color: Option<String>,
    /// `ltr` or `rtl`, from the locale.
    pub direction: String,
    pub startup_vault: Option<String>,
    /// Set in an e2e build whose control file names a test vault: the init script marks the
    /// onboarding tour, the star prompt and the iPhone beta launch prompt as seen, so no overlay
    /// covers the app (`apps/desktop/src/preload/lib/e2e-onboarding.ts`). Not part of the
    /// published state.
    #[serde(skip)]
    #[specta(skip)]
    pub suppress_onboarding: bool,
}

impl Default for StartupState {
    /// The fallbacks Electron uses when nothing is cached.
    fn default() -> Self {
        Self {
            theme: "system".to_owned(),
            locale: "en".to_owned(),
            zoom: 1.0,
            platform: node_platform().to_owned(),
            color_theme: None,
            accent_color: None,
            direction: "ltr".to_owned(),
            startup_vault: None,
            suppress_onboarding: false,
        }
    }
}

/// The OS name in the vocabulary of Node's `process.platform`, which the renderer compares.
pub fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// The init script that publishes `state` as a frozen `window.__MEMRY_STARTUP__`. `<` is
/// escaped, so the JSON can never contain a closing script tag.
pub fn script(state: &StartupState) -> String {
    let json = serde_json::to_string(state)
        .expect("StartupState is plain data")
        .replace('<', "\\u003c");
    let onboarding = if state.suppress_onboarding {
        // Wrapped: a webview without storage must not stop the state from being published.
        // The iPhone beta state is seeded only when absent, so a relaunch keeps a spec's join.
        "try{localStorage.setItem('memry:onboarding:tour:v1','1');localStorage.setItem('memry:onboarding:star:v1','done');if(localStorage.getItem('memry:ios-beta')===null)localStorage.setItem('memry:ios-beta','{\"joinedEmail\":null,\"promptSeen\":true}');}catch(e){}\n"
    } else {
        ""
    };
    format!("{onboarding}window.__MEMRY_STARTUP__ = Object.freeze({json});")
}

/// The boot order of `apps/desktop/src/main/index.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Stage {
    Paths,
    Logging,
    Guards,
    Plugins,
    Protocols,
    I18n,
    Migration,
    Menu,
    Telemetry,
    Handlers,
    Shortcuts,
    Security,
    VaultOpen,
    Window,
    Schedulers,
}

pub type StageFn<R> = fn(&AppHandle<R>) -> Result<(), CommandError>;

/// A stage that failed. `run()` shows it in the startup-error window
/// (`windows::startup_error`).
#[derive(Debug)]
pub struct StageFailure {
    pub stage: Stage,
    pub name: &'static str,
    pub error: CommandError,
}

pub struct Stages<R: Runtime> {
    entries: Vec<(Stage, &'static str, StageFn<R>)>,
}

impl<R: Runtime> Default for Stages<R> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
        }
    }
}

impl<R: Runtime> Stages<R> {
    pub fn register(&mut self, stage: Stage, name: &'static str, f: StageFn<R>) {
        self.entries.push((stage, name, f));
    }

    /// The registrations in the order [`Self::run`] runs them.
    fn ordered(&self) -> Vec<&(Stage, &'static str, StageFn<R>)> {
        let mut ordered: Vec<_> = self.entries.iter().collect();
        // Stable: equal stages keep their registration order.
        ordered.sort_by_key(|(stage, _, _)| *stage);
        ordered
    }

    /// Runs the registrations stage by stage in enum order and in registration order inside a
    /// stage. `Schedulers` registrations are skipped once `shutting_down` reports true, and
    /// nothing runs after a registration that leaves `halted` true.
    pub fn run(
        &self,
        app: &AppHandle<R>,
        shutting_down: impl Fn() -> bool,
        halted: impl Fn() -> bool,
    ) -> Result<(), StageFailure> {
        self.run_from(app, 0, shutting_down, halted).map(|_| ())
    }

    /// [`Self::run`] from position `from` of that order. Answers the position after the
    /// registration that left `stop` true, where a resumed boot starts, or the end.
    pub fn run_from(
        &self,
        app: &AppHandle<R>,
        from: usize,
        shutting_down: impl Fn() -> bool,
        stop: impl Fn() -> bool,
    ) -> Result<usize, StageFailure> {
        let ordered = self.ordered();
        for (position, (stage, name, f)) in ordered.iter().enumerate().skip(from) {
            if *stage == Stage::Schedulers && shutting_down() {
                tracing::info!(stage = ?stage, name, "skipped: shutdown has started");
                continue;
            }
            f(app).map_err(|error| StageFailure {
                stage: *stage,
                name,
                error,
            })?;
            if stop() {
                tracing::info!(stage = ?stage, name, "boot stopped");
                return Ok(position + 1);
            }
        }
        Ok(ordered.len())
    }
}

static STAGES: OnceLock<Mutex<Stages<Wry>>> = OnceLock::new();
static SHUTDOWN_STARTED: AtomicBool = AtomicBool::new(false);
static BOOT_HALTED: AtomicBool = AtomicBool::new(false);
static BOOT_SUSPENDED: AtomicBool = AtomicBool::new(false);
static RESUME_AT: AtomicUsize = AtomicUsize::new(0);

fn stages() -> &'static Mutex<Stages<Wry>> {
    STAGES.get_or_init(|| Mutex::new(Stages::default()))
}

/// Register startup work for `stage`. Later steps call this instead of editing `run()`.
pub fn register(stage: Stage, name: &'static str, f: StageFn<Wry>) {
    stages()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .register(stage, name, f);
}

/// Runs every registered stage of the app.
pub fn run_registered(app: &AppHandle<Wry>) -> Result<(), StageFailure> {
    run_registered_from(app, 0)
}

fn run_registered_from(app: &AppHandle<Wry>, from: usize) -> Result<(), StageFailure> {
    let next = stages()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .run_from(app, from, shutdown_started, || {
            boot_halted() || boot_suspended()
        })?;
    RESUME_AT.store(next, Ordering::SeqCst);
    Ok(())
}

/// Pauses the boot after the calling registration until [`resume_boot`]. The event loop runs
/// meanwhile, so the window that registration opened paints and answers (the first-launch
/// migration, `crate::migration`). The managed state of later stages does not exist yet, so the
/// run loop handles a suspended boot apart (`shutdown::on_run_event`).
pub fn suspend_boot() {
    BOOT_SUSPENDED.store(true, Ordering::SeqCst);
}

pub fn boot_suspended() -> bool {
    BOOT_SUSPENDED.load(Ordering::SeqCst)
}

/// Runs the rest of a suspended boot. Call it on the main thread, where `run_registered` ran.
pub fn resume_boot(app: &AppHandle<Wry>) -> Result<(), StageFailure> {
    if !BOOT_SUSPENDED.swap(false, Ordering::SeqCst) {
        return Ok(());
    }
    run_registered_from(app, RESUME_AT.load(Ordering::SeqCst))
}

/// Ends the boot after the calling registration, with no startup-error window: the app runs
/// only for what that registration started, and quits on its own (the macOS relaunch guard's
/// splash, `updater::relaunch_guard`). The managed state of later stages never exists, so the
/// run loop handles a halted boot apart (`shutdown::on_run_event`).
pub fn halt_boot() {
    BOOT_HALTED.store(true, Ordering::SeqCst);
}

pub fn boot_halted() -> bool {
    BOOT_HALTED.load(Ordering::SeqCst)
}

/// True once the shutdown sequence of Step 11 (#3528) has started.
pub fn shutdown_started() -> bool {
    SHUTDOWN_STARTED.load(Ordering::SeqCst)
}

/// Marks the shutdown sequence as started and returns whether it already was. A quit, a
/// termination signal, logind and the session manager can each start it from their own thread,
/// so only the caller that gets `false` starts it.
pub fn mark_shutdown_started() -> bool {
    mark_started(&SHUTDOWN_STARTED)
}

fn mark_started(flag: &AtomicBool) -> bool {
    flag.swap(true, Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Barrier};

    use super::{PoisonError, Stage, mark_started, stages};

    /// #3554: no sign-in, token refresh, vault open, sync or telemetry runs before the first-launch
    /// migration has carried the Electron install over (and its telemetry opt-out with it).
    #[test]
    fn the_first_launch_migration_runs_before_telemetry_account_vault_and_sync() {
        crate::register_stages();
        let names: Vec<_> = stages()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .ordered()
            .into_iter()
            .map(|(_, name, _)| *name)
            .collect();
        let at = |name: &str| {
            names
                .iter()
                .position(|registered| *registered == name)
                .unwrap_or_else(|| panic!("{name} is not registered: {names:?}"))
        };
        let migration = at("first-launch migration");
        for later in [
            "start telemetry",
            "manage account",
            "open the last vault",
            "start account sync",
        ] {
            assert!(migration < at(later), "{later} runs before the migration");
        }
        for later in [
            Stage::Menu,
            Stage::Telemetry,
            Stage::Handlers,
            Stage::VaultOpen,
            Stage::Window,
            Stage::Schedulers,
        ] {
            assert!(
                Stage::Migration < later,
                "{later:?} runs before the migration"
            );
        }
    }

    #[test]
    fn of_two_threads_starting_the_shutdown_at_once_exactly_one_starts_it() {
        for _ in 0..1000 {
            let flag = Arc::new(AtomicBool::new(false));
            let barrier = Arc::new(Barrier::new(2));
            let starters: Vec<_> = (0..2)
                .map(|_| {
                    let (flag, barrier) = (flag.clone(), barrier.clone());
                    std::thread::spawn(move || {
                        barrier.wait();
                        !mark_started(&flag)
                    })
                })
                .collect();
            let started = starters
                .into_iter()
                .map(|starter| starter.join().expect("the starter thread panicked"))
                .filter(|&first| first)
                .count();
            assert_eq!(started, 1);
        }
    }
}
