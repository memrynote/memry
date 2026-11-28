//! The first launch after the Electron app (Step 37, #3554): the `Migration` startup stage runs
//! the import of `memry_desktop::electron_import` before telemetry starts and before any vault
//! opens, while the preboot window shows its progress and, on a failure, the failing check with
//! Try again and Show details. The boot waits in the meantime (`startup::suspend_boot`) and
//! resumes once the import succeeds.
//!
//! [`Backend`] is the seam to the import. The app's is [`electron::ElectronBackend`], which runs
//! `run_first_launch`; an e2e build can script one with `MEMRY_E2E_MIGRATION`
//! (`crate::e2e::migration`).

pub mod electron;
pub mod local_storage;
pub mod status;

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use memry_desktop::electron_import::progress::{ProgressSink, ProgressUpdate};
use memry_desktop::electron_import::report::REPORT_FILE;
use memry_desktop::i18n::{self, Arg, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::paths::AppPaths;
use memry_desktop::registry::AppConfig;
use memry_desktop::telemetry::events::TelemetryEvent;
use memry_desktop::telemetry::logship;
use memry_desktop::telemetry::service::{FlushReason, Service};
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
    fn run(
        &self,
        progress: &dyn ProgressSink,
        telemetry: &dyn TelemetrySink,
    ) -> Result<(), MigrationFailure>;
    /// The Electron profile directory, which the import leaves untouched as the backup.
    fn backup(&self) -> PathBuf;
    /// True once for each change the Electron app made to an imported vault after the import
    /// (the downgrade fingerprint of the import marker), so the user hears of it once.
    fn take_change_notice(&self) -> bool;
}

/// Where a run sends Step 37e2's `migration_started`, `migration_completed` and
/// `migration_failed`. The run sends the first only after its app-state phase carried Electron's
/// telemetry choice and install id over; each holds counts, a duration and a check name, never a
/// path.
pub trait TelemetrySink: Send + Sync {
    fn record(&self, event: TelemetryEvent);
}

/// Starts the app's telemetry at the first event and not before: started earlier, it would read
/// the telemetry choice before the import carried Electron's opt-out. `Stage::Telemetry` then
/// finds it running. Each event is flushed at once, since a failed run never resumes the boot.
/// `enabled` is read again at every event: Try again can carry an opt-out the service, started
/// by the failed run, has not seen.
pub struct LazyTelemetry {
    start: Box<dyn Fn() -> Option<Arc<Service>> + Send + Sync>,
    enabled: Box<dyn Fn() -> bool + Send + Sync>,
    service: OnceLock<Option<Arc<Service>>>,
}

impl LazyTelemetry {
    pub fn new(
        start: Box<dyn Fn() -> Option<Arc<Service>> + Send + Sync>,
        enabled: Box<dyn Fn() -> bool + Send + Sync>,
    ) -> Self {
        Self {
            start,
            enabled,
            service: OnceLock::new(),
        }
    }
}

impl TelemetrySink for LazyTelemetry {
    fn record(&self, event: TelemetryEvent) {
        let Some(service) = self.service.get_or_init(|| (self.start)()).clone() else {
            return;
        };
        if !(self.enabled)() {
            if service.enabled() {
                service.set_enabled(false);
                if let Some(ship) = logship::global() {
                    ship.set_enabled(false);
                }
            }
            return;
        }
        service.track_main_event(event);
        tauri::async_runtime::spawn(async move {
            let result = service.flush(FlushReason::Manual).await;
            if !result.success {
                tracing::warn!(
                    scope = "Migration",
                    "migration telemetry not sent: {:?}",
                    result.error
                );
            }
        });
    }
}

fn backend(app: &AppHandle<Wry>) -> Arc<dyn Backend> {
    #[cfg(feature = "e2e")]
    if let Some(scripted) = crate::e2e::migration::scripted(app) {
        return scripted;
    }
    Arc::new(electron::ElectronBackend::new(app))
}

/// Shows a status on the migration page.
pub type ShowStatus = Box<dyn Fn(&MigrationStatus) + Send + Sync>;

/// The migration of this launch, managed while it runs and after.
pub struct Migration {
    backend: Arc<dyn Backend>,
    locale: &'static str,
    report: PathBuf,
    status: Mutex<MigrationStatus>,
    telemetry: Arc<dyn TelemetrySink>,
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
        telemetry: Arc<dyn TelemetrySink>,
        show: Option<ShowStatus>,
        finished: Box<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self {
            backend,
            locale,
            report: data_dir.join(REPORT_FILE),
            status: Mutex::new(status::idle()),
            telemetry,
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
        let telemetry = &*self.telemetry;
        let outcome = catch_unwind(AssertUnwindSafe(|| self.backend.run(&progress, telemetry)))
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
    let finished = resume_on_main_thread(app.clone(), backend.backup());
    let telemetry_app = app.clone();
    let enabled_app = app.clone();
    let telemetry = LazyTelemetry::new(
        Box::new(move || crate::shell::services::telemetry_started(&telemetry_app)),
        Box::new(move || crate::shell::services::telemetry_enabled(&enabled_app)),
    );
    let migration = Arc::new(Migration::new(
        backend,
        locale,
        &data_dir,
        Arc::new(telemetry),
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

fn resume_on_main_thread(app: AppHandle<Wry>, backup: PathBuf) -> impl Fn() + Send + Sync {
    move || {
        let main = app.clone();
        let backup = backup.clone();
        if let Err(error) = app.run_on_main_thread(move || resume(&main, &backup)) {
            tracing::error!(scope = "Migration", "boot not resumed: {error}");
        }
    }
}

/// Runs the rest of the boot in the language of the merged config, then closes the migration
/// window once the main window shows and tells the user where the untouched Electron data is.
fn resume(app: &AppHandle<Wry>, backup: &Path) {
    let locale = relocalize(app);
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

/// The `I18n` stage resolved the locale from an empty config (the OS language); the import
/// merged Electron's `locale` in since. Resolves it again, as that stage does, so the menu, the
/// tray, the main window and telemetry use the user's language from this session on.
fn relocalize(app: &AppHandle<Wry>) -> &'static str {
    let locale = locale_after_import(
        app.state::<Arc<AppConfig>>().inner(),
        &app.state::<Arc<LocaleService>>(),
        sys_locale::get_locale,
    );
    if let Some(service) = app.try_state::<Arc<Service>>() {
        service.set_locale(locale);
    }
    tracing::info!(scope = "Migration", "locale after the migration: {locale}");
    locale
}

/// Switches `live` to the locale `config` now resolves to. The import must merge into this
/// `config` (the managed one), whose cache [`AppConfig::read`] answers from.
fn locale_after_import(
    config: &Arc<AppConfig>,
    live: &LocaleService,
    os_locale: impl FnOnce() -> Option<String>,
) -> &'static str {
    let locale = crate::shell::services::boot_locale(config, os_locale);
    live.switch(locale);
    locale
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
