//! The one updater (`apps/desktop/src/main/updater.ts`). It owns [`UpdaterCore`], calls the
//! backend off the async runtime, persists the preferences, reports failures, and hands a
//! downloaded update to the installer at quit. Nothing else calls a backend.

mod install;
#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tokio::runtime::Handle;
use tokio::task::JoinHandle;

use super::backend::{CheckOutcome, UpdateBackend};
use super::health;
use super::severity::{
    Severity, UpdateError, UpdateErrorKind, UpdaterErrorPhase, classify, describe_error, error_code,
};
use super::state::{AppUpdateState, AvailableUpdate, UpdaterCore, UpdaterStatus};
use super::version::format_app_version_for_display;
use crate::i18n::{self, Args};
use crate::locale::LocaleService;
use crate::registry::{AppConfig, ConfigError};
use crate::telemetry::diagnostics::Failure;
use crate::telemetry::service::Service as Telemetry;
use crate::telemetry::time::now_ms;

/// Background checks while auto check is on. The first runs one interval after init; init
/// runs its own check.
pub const AUTO_CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);

/// Everything the service reads from the app.
pub struct UpdaterDeps {
    /// The running build's `YYYY.MDD.N`.
    pub raw_version: String,
    /// `None` when this process is not an installed, updatable app.
    pub backend: Option<Arc<dyn UpdateBackend>>,
    pub config: Arc<AppConfig>,
    /// Where the install marker and the health file live.
    pub data_dir: PathBuf,
    pub telemetry: Option<Arc<Telemetry>>,
    pub locale: Arc<LocaleService>,
    /// macOS: the bundle is outside `/Applications` and `~/Applications`, so a read-only volume
    /// error means "move the app".
    pub outside_applications: bool,
    pub runtime: Handle,
}

/// Coalesces concurrent calls: a caller that arrives while a run is in flight waits for it and
/// gets its result instead of starting a second one.
struct Coalesced {
    lock: tokio::sync::Mutex<()>,
    runs: AtomicU64,
    last: Mutex<Option<Result<AppUpdateState, UpdateError>>>,
}

impl Coalesced {
    fn new() -> Self {
        Self {
            lock: tokio::sync::Mutex::new(()),
            runs: AtomicU64::new(0),
            last: Mutex::new(None),
        }
    }

    async fn run<F>(&self, work: F) -> Result<AppUpdateState, UpdateError>
    where
        F: Future<Output = Result<AppUpdateState, UpdateError>>,
    {
        let seen = self.runs.load(Ordering::SeqCst);
        let _guard = self.lock.lock().await;
        if self.runs.load(Ordering::SeqCst) != seen
            && let Some(result) = self
                .last
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        {
            return result;
        }
        let result = work.await;
        *self.last.lock().unwrap_or_else(PoisonError::into_inner) = Some(result.clone());
        self.runs.fetch_add(1, Ordering::SeqCst);
        result
    }
}

pub struct UpdaterService {
    core: UpdaterCore,
    backend: Option<Arc<dyn UpdateBackend>>,
    config: Arc<AppConfig>,
    data_dir: PathBuf,
    telemetry: Option<Arc<Telemetry>>,
    locale: Arc<LocaleService>,
    outside_applications: bool,
    runtime: Handle,
    initialized: AtomicBool,
    check: Coalesced,
    download: Coalesced,
    /// The release the last check found, for the download and the install marker.
    pending: Mutex<Option<AvailableUpdate>>,
    timer: Mutex<Option<JoinHandle<()>>>,
    install_requested: AtomicBool,
    /// The app is quitting: no new check or download, and none in flight may change the state.
    stopped: AtomicBool,
    install_on_quit_disabled: AtomicBool,
    handed_off: AtomicBool,
}

impl UpdaterService {
    /// Reads the preferences, so the first state the renderer sees carries them. Nothing else
    /// runs until [`Self::init`].
    pub fn new(deps: UpdaterDeps) -> Arc<Self> {
        let core = UpdaterCore::new(&deps.raw_version, deps.backend.is_some(), now_ms());
        let prefs = deps.config.updater();
        core.set_auto_download_enabled(prefs.auto_download);
        core.set_auto_check_enabled(prefs.auto_check);
        Arc::new(Self {
            core,
            backend: deps.backend,
            config: deps.config,
            data_dir: deps.data_dir,
            telemetry: deps.telemetry,
            locale: deps.locale,
            outside_applications: deps.outside_applications,
            runtime: deps.runtime,
            initialized: AtomicBool::new(false),
            check: Coalesced::new(),
            download: Coalesced::new(),
            pending: Mutex::new(None),
            timer: Mutex::new(None),
            install_requested: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            install_on_quit_disabled: AtomicBool::new(false),
            handed_off: AtomicBool::new(false),
        })
    }

    /// The quit began: the timer goes, and no check or download starts or lands after this. One
    /// way: a quit never un-begins (a cancelled session end only turns install on quit back on),
    /// and a download that was still running when it began is not installed on quit.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.stop_timer();
    }

    /// Restart to install was asked for, or the app is quitting. The Installing screen must not
    /// flip back to a check or a download.
    fn halted(&self) -> bool {
        self.stopped.load(Ordering::SeqCst) || self.install_requested.load(Ordering::SeqCst)
    }

    pub fn state(&self) -> AppUpdateState {
        self.core.state()
    }

    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<AppUpdateState> {
        self.core.subscribe()
    }

    /// Once, after the main window is shown: the failed-install streak, the timer and the
    /// startup check. Without a backend the state stays `unavailable`.
    pub fn init(self: &Arc<Self>) {
        if self.initialized.swap(true, Ordering::SeqCst) {
            return;
        }
        if self.backend.is_none() {
            return;
        }
        self.core.reset_check_health(now_ms());
        // An escalated streak comes back on every launch it is still live: the user stays on
        // the old build until they install by hand.
        if let Some(stranded) = health::reconcile(&self.data_dir, &self.core.display_version()) {
            self.core.note_install_failed(Some(stranded));
        }
        if self.state().auto_check_enabled {
            self.start_timer();
            self.spawn_check(UpdaterErrorPhase::StartupCheck);
        }
    }

    fn spawn_check(self: &Arc<Self>, phase: UpdaterErrorPhase) {
        let this = self.clone();
        self.runtime.spawn(async move {
            if let Err(error) = this.check(false).await {
                tracing::warn!(
                    scope = "Updater",
                    fields = %describe_error(&error, phase),
                    "{} update check failed",
                    phase.as_str()
                );
            }
        });
    }

    fn start_timer(self: &Arc<Self>) {
        let mut timer = self.timer.lock().unwrap_or_else(PoisonError::into_inner);
        if timer.is_some() || self.backend.is_none() || self.halted() {
            return;
        }
        let weak = Arc::downgrade(self);
        *timer = Some(self.runtime.spawn(async move {
            let start = tokio::time::Instant::now() + AUTO_CHECK_INTERVAL;
            let mut tick = tokio::time::interval_at(start, AUTO_CHECK_INTERVAL);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                let Some(this) = weak.upgrade() else { return };
                if let Err(error) = this.check(false).await {
                    tracing::warn!(
                        scope = "Updater",
                        fields = %describe_error(&error, UpdaterErrorPhase::ScheduledCheck),
                        "scheduled update check failed"
                    );
                }
            }
        }));
    }

    fn stop_timer(&self) {
        if let Some(timer) = self
            .timer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            timer.abort();
        }
    }

    /// One feed check, joined by any caller that arrives while it runs. `clear_skip` (a manual
    /// check) lets a skipped version surface again. A failure is in the state and is returned.
    ///
    /// A downloaded update stays downloaded through a check that finds it again or fails:
    /// install on quit acts only on `downloaded`, so a routine check would otherwise drop it.
    pub async fn check(self: &Arc<Self>, clear_skip: bool) -> Result<AppUpdateState, UpdateError> {
        let Some(backend) = self.backend.clone() else {
            return Ok(self.state());
        };
        if self.halted() {
            return Ok(self.state());
        }
        if clear_skip {
            let config = self.config.clone();
            let cleared = self
                .runtime
                .spawn_blocking(move || config.set_updater_skipped_version(None))
                .await;
            if !matches!(cleared, Ok(Ok(()))) {
                tracing::warn!(
                    scope = "Updater",
                    "could not clear the skipped version: {cleared:?}"
                );
            }
        }
        let this = self.clone();
        self.check
            .run(async move {
                if this.halted() {
                    return Ok(this.state());
                }
                let held = this.downloaded_version();
                if held.is_none() {
                    this.core.on_checking(now_ms());
                }
                let outcome = this.blocking(move || backend.check()).await;
                if this.halted() {
                    return Ok(this.state());
                }
                match (outcome, held) {
                    (Ok(CheckOutcome::Available(update)), Some(held))
                        if format_app_version_for_display(&update.version) == held =>
                    {
                        this.core.note_check_success(now_ms());
                    }
                    (Ok(CheckOutcome::UpToDate), Some(_)) => this.core.note_check_success(now_ms()),
                    (Ok(CheckOutcome::UpToDate), None) => this.core.on_up_to_date(now_ms()),
                    (Ok(CheckOutcome::Available(update)), _) => this.offer(update),
                    (Err(error), Some(_)) => {
                        this.log_and_report(&error, UpdaterErrorPhase::Check);
                        return Err(error);
                    }
                    (Err(error), None) => return Err(this.fail(error)),
                }
                Ok(this.state())
            })
            .await
    }

    /// The display version of the update on disk, while the state is `downloaded`.
    fn downloaded_version(&self) -> Option<String> {
        let state = self.state();
        (state.status == UpdaterStatus::Downloaded)
            .then_some(state.available_version)
            .flatten()
    }

    fn offer(self: &Arc<Self>, update: AvailableUpdate) {
        let skipped = self.config.updater().skipped_version;
        if !self
            .core
            .on_update_available(&update, skipped.as_deref(), now_ms())
        {
            return;
        }
        *self.pending.lock().unwrap_or_else(PoisonError::into_inner) = Some(update);
        if self.state().auto_download_enabled {
            // The check settles now; the download reports its own failure.
            let this = self.clone();
            self.runtime.spawn(async move {
                let _ = this.download().await;
            });
        }
    }

    /// Downloads the release the last check found, joined by any caller that arrives while it
    /// runs. A downloaded update returns at once.
    pub async fn download(self: &Arc<Self>) -> Result<AppUpdateState, UpdateError> {
        let Some(backend) = self.backend.clone() else {
            return Ok(self.state());
        };
        if self.halted() || self.state().status == UpdaterStatus::Downloaded {
            return Ok(self.state());
        }
        let Some(update) = self
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
        else {
            return Ok(self.state());
        };
        let this = self.clone();
        self.download
            .run(async move {
                if this.halted() || this.state().status == UpdaterStatus::Downloaded {
                    return Ok(this.state());
                }
                this.core.on_download_started();
                let progress = this.clone();
                let result = this
                    .blocking(move || {
                        backend.download(&|percent| {
                            if !progress.halted() {
                                progress.core.on_download_progress(percent);
                            }
                        })
                    })
                    .await;
                if this.halted() {
                    return Ok(this.state());
                }
                match result {
                    Ok(()) => {
                        this.core.on_downloaded(&update);
                        Ok(this.state())
                    }
                    Err(error) => Err(this.fail(error)),
                }
            })
            .await
    }

    /// Runs blocking backend work on the blocking pool; a panic becomes an error.
    async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> Result<T, UpdateError> + Send + 'static,
    ) -> Result<T, UpdateError> {
        match self.runtime.spawn_blocking(work).await {
            Ok(result) => result,
            Err(join) => Err(UpdateError::new(
                UpdateErrorKind::Other,
                format!("the update backend stopped: {join}"),
            )),
        }
    }

    /// Persists a skip of `version` (display form) and clears the offer.
    pub fn skip_version(&self, version: &str) -> Result<AppUpdateState, ConfigError> {
        tracing::info!(scope = "Updater", "skipping update version {version}");
        self.config.set_updater_skipped_version(Some(version))?;
        self.track_setting("skip_version");
        self.core.on_version_skipped();
        Ok(self.state())
    }

    /// Persists auto download; turning it on while an update waits starts its download.
    pub fn set_auto_download(
        self: &Arc<Self>,
        enabled: bool,
    ) -> Result<AppUpdateState, ConfigError> {
        tracing::info!(
            scope = "Updater",
            "setting auto-download preference to {enabled}"
        );
        self.config.set_updater_auto_download(enabled)?;
        self.track_setting("auto_download");
        self.core.set_auto_download_enabled(enabled);
        if enabled && self.state().status == UpdaterStatus::Available {
            let this = self.clone();
            self.runtime.spawn(async move {
                if let Err(error) = this.download().await {
                    tracing::warn!(
                        scope = "Updater",
                        fields = %describe_error(&error, UpdaterErrorPhase::AutoDownloadEnable),
                        "auto-download on-enable download failed"
                    );
                }
            });
        }
        Ok(self.state())
    }

    /// Persists auto check; turning it on starts the timer and checks at once.
    pub fn set_auto_check(self: &Arc<Self>, enabled: bool) -> Result<AppUpdateState, ConfigError> {
        tracing::info!(
            scope = "Updater",
            "setting auto-check preference to {enabled}"
        );
        self.config.set_updater_auto_check(enabled)?;
        self.track_setting("auto_check");
        if enabled {
            self.start_timer();
            self.spawn_check(UpdaterErrorPhase::AutoCheckEnable);
        } else {
            self.stop_timer();
        }
        self.core.set_auto_check_enabled(enabled);
        Ok(self.state())
    }

    fn track_setting(&self, setting: &str) {
        if let Some(telemetry) = &self.telemetry {
            let mut event = Telemetry::event("setting_changed", "updater", "changed");
            event.dimensions = Some([("setting".to_owned(), setting.to_owned())].into());
            telemetry.track_main_event(event);
        }
    }

    /// Logs, reports and shows a failure, and counts it toward the install streak when it
    /// belongs to an install. Returns the error for the caller to reject with.
    fn fail(&self, error: UpdateError) -> UpdateError {
        let phase = self.core.current_phase();
        self.log_and_report(&error, phase);
        let locale = self.locale.get();
        let text = if error.kind == UpdateErrorKind::ReadOnlyVolume && self.outside_applications {
            i18n::t(locale, "system:error.updateReadOnlyVolume", &Args::new())
        } else if error.message.is_empty() {
            i18n::t(locale, "system:error.updateFailed", &Args::new())
        } else {
            error.message.clone()
        };
        self.core.on_error(text);
        self.note_install_attempt_failure(phase);
        error
    }

    /// The log line stays at error severity; only telemetry is classified.
    fn log_and_report(&self, error: &UpdateError, phase: UpdaterErrorPhase) {
        tracing::error!(
            scope = "Updater",
            fields = %describe_error(error, phase),
            "updater error: {}",
            error.message
        );
        self.report(error, phase);
    }

    /// A check that cannot reach the network is a warning, unless the install has been stuck
    /// for a day; every check failure advances that streak.
    fn report(&self, error: &UpdateError, phase: UpdaterErrorPhase) {
        let severity = classify(error, phase);
        let streak = phase
            .is_check()
            .then(|| self.core.record_check_failure(now_ms()));
        let Some(telemetry) = &self.telemetry else {
            return;
        };
        let failure = Failure::new(error_code(error.kind).as_deref(), error.message.clone());
        let action = phase.as_str();
        match streak {
            Some((_, stuck)) if stuck || severity == Severity::Error => {
                telemetry.track_main_error("updater", action, &failure);
            }
            Some((count, _)) => {
                telemetry.track_main_warning("updater", action, &failure, Some(count));
            }
            None if severity == Severity::Warn => {
                telemetry.track_main_warning("updater", action, &failure, None);
            }
            None => telemetry.track_main_error("updater", action, &failure),
        }
    }

    /// A failure while an update sat downloaded or installing is a failed install of it; the
    /// third in a row offers the manual installer.
    fn note_install_attempt_failure(&self, phase: UpdaterErrorPhase) {
        if !matches!(
            phase,
            UpdaterErrorPhase::Downloaded | UpdaterErrorPhase::Install
        ) {
            return;
        }
        let Some(target) = self.state().available_version else {
            return;
        };
        let (count, stuck) =
            health::record_failure(&self.data_dir, &self.core.display_version(), &target);
        tracing::warn!(
            scope = "Updater",
            "update install attempt failed: {target}, {count} in a row"
        );
        if stuck {
            self.core.note_install_failed(Some(target));
        }
    }
}
