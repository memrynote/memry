use std::sync::atomic::{AtomicBool, Ordering};
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
    pub startup_vault: Option<String>,
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
            startup_vault: None,
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
    format!("window.__MEMRY_STARTUP__ = Object.freeze({json});")
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

/// A stage that failed. `run()` logs it and exits with code 2.
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

    /// Runs the registrations stage by stage in enum order and in registration order inside a
    /// stage. `Schedulers` registrations are skipped once `shutting_down` reports true.
    pub fn run(
        &self,
        app: &AppHandle<R>,
        shutting_down: impl Fn() -> bool,
    ) -> Result<(), StageFailure> {
        let mut ordered: Vec<_> = self.entries.iter().collect();
        // Stable: equal stages keep their registration order.
        ordered.sort_by_key(|(stage, _, _)| *stage);
        for (stage, name, f) in ordered {
            if *stage == Stage::Schedulers && shutting_down() {
                tracing::info!(stage = ?stage, name, "skipped: shutdown has started");
                continue;
            }
            f(app).map_err(|error| StageFailure {
                stage: *stage,
                name,
                error,
            })?;
        }
        Ok(())
    }
}

static STAGES: OnceLock<Mutex<Stages<Wry>>> = OnceLock::new();
static SHUTDOWN_STARTED: AtomicBool = AtomicBool::new(false);

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
    stages()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .run(app, shutdown_started)
}

/// True once the shutdown sequence of Step 11 (#3528) has started.
pub fn shutdown_started() -> bool {
    SHUTDOWN_STARTED.load(Ordering::SeqCst)
}

/// Step 11 (#3528) calls this when shutdown begins.
pub fn mark_shutdown_started() {
    SHUTDOWN_STARTED.store(true, Ordering::SeqCst);
}
