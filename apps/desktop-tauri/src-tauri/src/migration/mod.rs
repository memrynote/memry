//! The first launch after the Electron app (Step 37, #3554): the `Migration` startup stage runs
//! the import of `memry_desktop::electron_import` before telemetry starts and before any vault
//! opens, while the preboot window shows its progress and, on a failure, the failing check with
//! Try again and Show details. The boot waits in the meantime (`startup::suspend_boot`) and
//! resumes once the import succeeds.
//!
//! [`Backend`] is the seam to the import. Until Step 37e2 lands `run_first_launch`, the app
//! uses [`NotWired`], which never migrates; an e2e build can script one with
//! `MEMRY_E2E_MIGRATION` (`crate::e2e::migration`).

pub mod local_storage;
pub mod status;

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use memry_desktop::electron_import::progress::{ProgressSink, ProgressUpdate};
use memry_desktop::electron_import::report::REPORT_FILE;
use memry_desktop::i18n::{self, Arg, Args};
use memry_desktop::paths::AppPaths;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::commands::error::{CommandError, ErrorKind};
use crate::startup::{self, Stage};
use crate::windows::preboot;
use crate::windows::registry::WindowKind;
use status::{MigrationState, MigrationStatus};

/// A run that did not finish: the failing check and the message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationFailure {
    pub check: String,
    pub details: String,
}

/// The import of the Electron install.
pub trait Backend: Send + Sync {
    /// Whether this launch migrates: no import marker yet, and an Electron profile with a config
    /// or a secret store.
    fn needed(&self) -> bool;
    /// Runs the import. Called again by Try again after a failure, so it repeats cleanly.
    fn run(&self, progress: &dyn ProgressSink) -> Result<(), MigrationFailure>;
    /// The Electron profile directory, which the import leaves untouched as the backup.
    fn backup(&self) -> PathBuf;
    /// True once for each change the Electron app made to an imported vault after the import
    /// (the downgrade fingerprint of the import marker), so the user hears of it once.
    fn take_change_notice(&self) -> bool;
}

/// The app's backend until Step 37e2 wires `run_first_launch`: no launch migrates.
struct NotWired;

impl Backend for NotWired {
    fn needed(&self) -> bool {
        false
    }

    fn run(&self, _progress: &dyn ProgressSink) -> Result<(), MigrationFailure> {
        Err(MigrationFailure {
            check: "not-wired".to_owned(),
            details: "the first-launch import is not wired yet".to_owned(),
        })
    }

    fn backup(&self) -> PathBuf {
        PathBuf::new()
    }

    fn take_change_notice(&self) -> bool {
        false
    }
}

fn backend(app: &AppHandle<Wry>) -> Arc<dyn Backend> {
    #[cfg(feature = "e2e")]
    if let Some(scripted) = crate::e2e::migration::scripted(app) {
        return scripted;
    }
    let _ = app;
    Arc::new(NotWired)
}

/// Shows a status on the migration page.
pub type ShowStatus = Box<dyn Fn(&MigrationStatus) + Send + Sync>;

/// The migration of this launch, managed while it runs and after.
pub struct Migration {
    backend: Arc<dyn Backend>,
    locale: &'static str,
    report: PathBuf,
    status: Mutex<MigrationStatus>,
    /// Shows a status on the page. `None` in tests, which read [`Self::status`].
    show: Option<ShowStatus>,
    /// Runs after a run succeeded: resumes the boot.
    finished: Box<dyn Fn() + Send + Sync>,
}

impl Migration {
    pub fn new(
        backend: Arc<dyn Backend>,
        locale: &'static str,
        data_dir: &Path,
        show: Option<ShowStatus>,
        finished: Box<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self {
            backend,
            locale,
            report: data_dir.join(REPORT_FILE),
            status: Mutex::new(status::idle()),
            show,
            finished,
        }
    }

    pub fn status(&self) -> MigrationStatus {
        self.status
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn report(&self) -> &Path {
        &self.report
    }

    /// Moves to `next` when the state is one of `from`, under one lock with the page update,
    /// so updates reach the page in order and two Try again clicks start one run.
    fn transition(&self, from: &[MigrationState], next: MigrationStatus) -> bool {
        let mut current = self.status.lock().unwrap_or_else(PoisonError::into_inner);
        if !from.contains(&current.state) {
            return false;
        }
        let seq = current.seq + 1;
        *current = MigrationStatus { seq, ..next };
        if let Some(show) = &self.show {
            show(&current);
        }
        true
    }

    /// Starts a run from the idle state (the stage) or after a failure (Try again). False when
    /// a run is going or done.
    pub fn start(self: &Arc<Self>) -> bool {
        let first = status::running(self.locale, &first_update());
        if !self.transition(&[MigrationState::Idle, MigrationState::Failed], first) {
            return false;
        }
        let this = self.clone();
        std::thread::spawn(move || {
            if this.run_once() {
                (this.finished)();
            }
        });
        true
    }

    /// One run of the backend; true when it succeeded.
    fn run_once(&self) -> bool {
        let progress = Progress(self);
        let outcome = catch_unwind(AssertUnwindSafe(|| self.backend.run(&progress)))
            .unwrap_or_else(|_| {
                Err(MigrationFailure {
                    check: "panic".to_owned(),
                    details: "the import stopped unexpectedly".to_owned(),
                })
            });
        match outcome {
            Ok(()) => {
                tracing::info!(scope = "Migration", "first-launch migration done");
                self.transition(&[MigrationState::Running], status::done(self.locale))
            }
            Err(failure) => {
                // The check only: the message can name a vault path.
                tracing::warn!(
                    scope = "Migration",
                    check = failure.check,
                    "first-launch migration failed"
                );
                self.transition(
                    &[MigrationState::Running],
                    status::failed(self.locale, &failure),
                );
                false
            }
        }
    }
}

/// The phase a run starts in, shown before the backend's first update.
fn first_update() -> ProgressUpdate {
    ProgressUpdate {
        phase: memry_desktop::electron_import::progress::Phase::AppState,
        current: 0,
        total: 1,
        label: String::new(),
    }
}

struct Progress<'a>(&'a Migration);

impl ProgressSink for Progress<'_> {
    fn update(&self, update: ProgressUpdate) {
        let next = status::running(self.0.locale, &update);
        self.0.transition(&[MigrationState::Running], next);
    }
}

pub fn register_stages() {
    startup::register(
        Stage::Migration,
        "first-launch migration",
        first_launch_migration,
    );
}

fn first_launch_migration(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let backend = backend(app);
    let locale = preboot::locale(app);
    if backend.take_change_notice() {
        // After the main window shows: a message asked for while the boot runs, before the
        // event loop does, never appears.
        let shown = app.clone();
        let backup = backend.backup();
        crate::post_reveal::once_window_shown("tell of changes in the previous app", move || {
            tell(
                &shown,
                locale,
                "system:migration.notice.title",
                "system:migration.notice.body",
                &backup,
            );
        });
    }
    if !backend.needed() {
        return Ok(());
    }
    let data_dir = app.state::<AppPaths>().data_dir.clone();
    let page = app.clone();
    let show = move |status: &MigrationStatus| show_on_page(&page, status);
    let finished = resume_on_main_thread(app.clone(), locale, backend.backup());
    let migration = Arc::new(Migration::new(
        backend,
        locale,
        &data_dir,
        Some(Box::new(show)),
        Box::new(finished),
    ));
    app.manage(migration.clone());
    preboot::show_migration(app, status::page_slots(locale)).map_err(|error| {
        CommandError::new(ErrorKind::Internal, "migration_window", error.to_string())
    })?;
    startup::suspend_boot();
    migration.start();
    Ok(())
}

fn resume_on_main_thread(
    app: AppHandle<Wry>,
    locale: &'static str,
    backup: PathBuf,
) -> impl Fn() + Send + Sync {
    move || {
        let main = app.clone();
        let backup = backup.clone();
        if let Err(error) = app.run_on_main_thread(move || resume(&main, locale, &backup)) {
            tracing::error!(scope = "Migration", "boot not resumed: {error}");
        }
    }
}

/// Runs the rest of the boot, then closes the migration window once the main window shows and
/// tells the user where the untouched Electron data is.
fn resume(app: &AppHandle<Wry>, locale: &'static str, backup: &Path) {
    let result = startup::resume_boot(app);
    let preboot = app.get_webview_window(&WindowKind::Preboot.label(0));
    if let Err(failure) = result {
        crate::windows::startup_error::on_startup_failure(app, &failure);
        if let Some(window) = preboot {
            let _ = window.close();
        }
        return;
    }
    let shown = app.clone();
    let backup = backup.to_path_buf();
    crate::post_reveal::once_window_shown("close the migration window", move || {
        if let Some(window) = preboot {
            let _ = window.close();
        }
        tell(
            &shown,
            locale,
            "system:migration.completed.title",
            "system:migration.completed.body",
            &backup,
        );
    });
}

/// A native message naming the Electron data, which never waits for an answer.
/// On macOS it is a sheet of the main window: without a parent, rfd picks the app's first
/// window, which can be a hidden one, and nobody sees the message.
fn tell(app: &AppHandle<Wry>, locale: &str, title: &str, body: &str, backup: &Path) {
    let path = backup.display().to_string();
    let args = Args::from([("path".to_owned(), Arg::from(path.as_str()))]);
    let mut dialog = app
        .dialog()
        .message(i18n::t(locale, body, &args))
        .title(i18n::t(locale, title, &Args::new()))
        .kind(MessageDialogKind::Info);
    if let Some(main) = app.get_webview_window(&WindowKind::Main.label(0)) {
        dialog = dialog.parent(&main);
    }
    dialog.show(|_| tracing::info!(scope = "Migration", "message closed"));
    tracing::info!(scope = "Migration", title, "message shown");
}

/// `memryMigration.update(status)` on the migration page. `<` is escaped, so no string closes
/// a script; the page writes every string into `textContent`.
pub fn update_script(status: &MigrationStatus) -> String {
    let json = serde_json::to_string(status)
        .unwrap_or_else(|_| "null".to_owned())
        .replace('<', "\\u003c");
    format!("window.memryMigration&&window.memryMigration.update({json})")
}

fn show_on_page(app: &AppHandle<Wry>, status: &MigrationStatus) {
    // Before the page has loaded the script finds no `memryMigration`; the page asks for the
    // status itself once it is filled.
    if let Some(window) = app.get_webview_window(&WindowKind::Preboot.label(0))
        && let Err(error) = window.eval(update_script(status))
    {
        tracing::warn!(scope = "Migration", "migration page not updated: {error}");
    }
}

#[cfg(test)]
mod tests;
