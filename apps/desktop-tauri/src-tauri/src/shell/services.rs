//! The app-wide services this step owns and their boot stages: the app config and the language
//! (`I18n`), telemetry with its crash marker and log shipping (`Telemetry`), and the settings
//! service (`Handlers`). Each is managed state that commands read; none is rebuilt per call.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use memry_desktop::config::{Compiled, MemryEnv, RuntimeConfig};
use memry_desktop::e2e::E2eGate;
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::launch_timeline::{self, LaunchPhase};
use memry_desktop::locale::{self, LocaleService};
use memry_desktop::logging::localtime;
use memry_desktop::paths::{AppPaths, DEVICE_VAR};
use memry_desktop::registry::AppConfig;
use memry_desktop::seams::secure_store::{DeviceIdentityStore, KeyringStore};
use memry_desktop::seams::tls::{PinFailure, PinFailureReason, PinFailureSink};
use memry_desktop::seams::transport::{SyncTransport, app_transport};
use memry_desktop::session::Session;
use memry_desktop::settings::SettingsService;
use memry_desktop::startup_values;
use memry_desktop::telemetry::crash::{ALIVE_INTERVAL_MS, CrashMarker};
use memry_desktop::telemetry::lifecycle::{self, HEARTBEAT_SECONDS};
use memry_desktop::telemetry::logship::{self, LOG_QUEUE_FILE};
use memry_desktop::telemetry::service::{Context, FLUSH_INTERVAL, FlushReason, Sender, Service};
use memry_desktop::telemetry::sink::TelemetryFailureSink;
use memry_desktop::vault::config as vault_config;
use serde_json::Value;
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::{CommandError, ErrorKind, register_sink};
use crate::shell::vault_boot::CONFIG_FILE;
use crate::startup::{self, Stage, StartupState, node_platform};

/// `option_env!` of the `MEMRY_BUILD_<NAME>` value `build.rs` compiled in.
macro_rules! built {
    ($name:ident) => {
        option_env!(concat!("MEMRY_BUILD_", stringify!($name)))
    };
}

/// The `RuntimeConfig` values compiled into this binary by `build.rs`.
fn compiled() -> Compiled {
    Compiled {
        env: built!(ENV),
        sync_server_url: built!(SYNC_SERVER_URL),
        google_calendar_client_id: built!(GOOGLE_CALENDAR_CLIENT_ID),
        google_calendar_client_secret: built!(GOOGLE_CALENDAR_CLIENT_SECRET),
        onenote_client_id: built!(ONENOTE_CLIENT_ID),
        unsplash_access_key: built!(UNSPLASH_ACCESS_KEY),
    }
}

/// Whether the main window has focus, for the heartbeat.
#[derive(Default)]
pub struct WindowFocus(pub AtomicBool);

pub fn register_stages() {
    // `AppReady` is the first mark of the launch timeline.
    startup::register(Stage::Guards, "mark app ready", mark_app_ready);
    startup::register(
        Stage::I18n,
        "load app config and locale",
        load_config_and_locale,
    );
    startup::register(Stage::Telemetry, "start telemetry", start_telemetry);
    startup::register(Stage::Handlers, "manage settings", manage_settings);
}

fn failed(code: &str, error: impl std::fmt::Display) -> CommandError {
    CommandError::new(ErrorKind::Internal, code, error.to_string())
}

fn mark_app_ready(_app: &AppHandle<Wry>) -> Result<(), CommandError> {
    launch_timeline::global().mark(LaunchPhase::AppReady);
    Ok(())
}

fn load_config_and_locale(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let data_dir = app.state::<AppPaths>().data_dir.clone();
    std::fs::create_dir_all(&data_dir).map_err(|e| failed("app_data_dir", e))?;
    let config = Arc::new(AppConfig::load(data_dir.join(CONFIG_FILE)));
    app.manage(config.clone());

    let current = memry_desktop::registry::VaultRegistry::new(config.clone()).current();
    let has_vaults = config.read(|map| {
        map.get("vaults")
            .and_then(Value::as_array)
            .is_some_and(|vaults| !vaults.is_empty())
    });
    let vault_language = current
        .as_deref()
        .and_then(|path| vault_config::preferences_language(Path::new(path)));
    let initial = locale::resolve_startup(
        &config,
        has_vaults,
        current.is_some(),
        vault_language.as_deref(),
        sys_locale::get_locale,
    );
    app.manage(Arc::new(LocaleService::new(initial)));
    Ok(())
}

/// Node's `process.arch` vocabulary, which the server's `arch` field has always held.
fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

/// Logs a pin mismatch. Step 17 (#3534) turns it into the `certificate_pin_failed` event.
struct LogPinFailures;

impl PinFailureSink for LogPinFailures {
    fn pin_failed(&self, failure: PinFailure) {
        match failure.reason {
            PinFailureReason::Mismatch => tracing::error!(
                scope = "Pinning",
                host = failure.hostname,
                actual = failure.actual_hash,
                "the sync host presented a certificate none of its pins match"
            ),
            PinFailureReason::Unverified { what } => tracing::error!(
                scope = "Pinning",
                host = failure.hostname,
                "the pin check found no path to an OS root for the sync host's chain: {what}"
            ),
        }
    }
}

fn start_telemetry(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let paths = app.state::<AppPaths>();
    let env = app.state::<LaunchEnv>();
    let runtime = RuntimeConfig::resolve(&compiled(), &env);
    tracing::info!(
        scope = "Config",
        "runtime config: env {}, sync server {}",
        runtime.build_channel(),
        runtime.sync_server_url
    );
    let stored = memry_desktop::telemetry::TelemetryConfig::new(&paths.data_dir);
    let enabled = runtime.telemetry_enabled(stored.enabled(), &env);
    let version = app.package_info().version.to_string();
    let session_id = uuid::Uuid::new_v4().to_string();
    let context = Context {
        install_id: stored.install_id(),
        session_id: session_id.clone(),
        app_version: version.clone(),
        build_channel: runtime.build_channel().to_owned(),
        platform: node_platform().to_owned(),
        arch: node_arch().to_owned(),
        locale: app.state::<Arc<LocaleService>>().get().to_owned(),
        timezone_offset_minutes: -localtime::timezone_offset_minutes(),
    };

    let transport: SyncTransport =
        app_transport(&runtime.loopback_hosts(), Arc::new(LogPinFailures));
    let service = Arc::new(Service::start(
        &paths.data_dir,
        context.clone(),
        Sender::new(runtime.telemetry_batch_endpoint(), transport.clone()),
        enabled,
    ));
    if enabled {
        lifecycle::app_started(&service);
    }
    lifecycle::version_check(&service, &version);

    let mut marker = CrashMarker::new(&paths.data_dir, &session_id, &version);
    if let Some(report) = marker.detect() {
        lifecycle::crashed(&service, &report);
    }
    marker.install();

    let ship = logship::install(logship::Deps {
        context,
        sender: Sender::new(runtime.server_url("/telemetry/logs"), transport.clone()),
        salt: service.config().diagnostics_salt(),
        level: env.get("MEMRY_DIAG_LOG_LEVEL").map(str::to_owned),
        ships: runtime.env != MemryEnv::Development,
        enabled,
        queue_path: paths.data_dir.join(LOG_QUEUE_FILE),
    });

    register_sink(Arc::new(TelemetryFailureSink(service.clone())));
    // The phases already marked before the service existed.
    for (phase, elapsed) in launch_timeline::global().marks() {
        lifecycle::launch_phase(&service, phase.name(), elapsed);
    }

    app.manage(runtime);
    app.manage(transport);
    app.manage(service.clone());
    app.manage(ship.clone());
    app.manage(Mutex::new(marker));
    app.manage(WindowFocus::default());
    spawn_timers(app.clone(), service, ship);
    Ok(())
}

/// Flush every 30 seconds, refresh the crash marker every minute, heartbeat every five minutes
/// while the window is focused.
fn spawn_timers(app: AppHandle<Wry>, service: Arc<Service>, ship: Arc<logship::LogShip>) {
    let flush_service = service.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio_interval(FLUSH_INTERVAL);
        loop {
            tick.tick().await;
            let result = flush_service.flush(FlushReason::Interval).await;
            if !result.success {
                tracing::warn!(
                    scope = "Telemetry",
                    "scheduled flush failed: {:?}",
                    result.error
                );
            }
            ship.flush().await;
        }
    });
    let marker_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio_interval(Duration::from_millis(ALIVE_INTERVAL_MS));
        loop {
            tick.tick().await;
            if let Some(marker) = marker_app.try_state::<Mutex<CrashMarker>>() {
                marker
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .refresh();
            }
        }
    });
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio_interval(Duration::from_secs(HEARTBEAT_SECONDS));
        loop {
            tick.tick().await;
            if app.state::<WindowFocus>().0.load(Ordering::Relaxed) {
                lifecycle::heartbeat(&service);
            }
        }
    });
}

fn tokio_interval(period: Duration) -> tokio::time::Interval {
    let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    interval
}

/// The app's one keychain worker, and the core's `SecureStore` over it: the device identity
/// store, which also moves a device key the builds before Step 15 kept in `<profile>/device-key`.
/// Later steps take both from managed state instead of opening a second keychain. The raw
/// `KeyringStore` refuses the device key, so every device-key operation goes through the identity
/// store and its cache.
fn manage_settings(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let data_dir = app.state::<AppPaths>().data_dir.clone();
    let config = app.state::<Arc<AppConfig>>().inner().clone();
    let (device, gate) = {
        let env = app.state::<LaunchEnv>();
        (
            env.get(DEVICE_VAR).map(str::to_owned),
            E2eGate::from_env(&env),
        )
    };
    let keychain = Arc::new(KeyringStore::new(device, gate, &data_dir));
    let identity = Arc::new(DeviceIdentityStore::new(keychain.clone(), &data_dir));
    app.manage(keychain);
    app.manage(identity.clone());
    app.manage(SettingsService::new(identity, config));
    Ok(())
}

/// The telemetry service, once its stage has run.
pub fn telemetry(app: &AppHandle<Wry>) -> Option<Arc<Service>> {
    app.try_state::<Arc<Service>>()
        .map(|state| state.inner().clone())
}

/// Stamps a launch phase and reports it to telemetry.
pub fn mark_phase(app: &AppHandle<Wry>, phase: LaunchPhase) {
    let first = !launch_timeline::global()
        .marks()
        .iter()
        .any(|(seen, _)| *seen == phase);
    let elapsed = launch_timeline::global().mark(phase);
    if first && let Some(service) = telemetry(app) {
        lifecycle::launch_phase(&service, phase.name(), elapsed);
    }
}

/// The open vault's root, collapsed to `<vault>` in reported text.
pub fn set_vault_root(app: &AppHandle<Wry>, root: Option<String>) {
    if let Some(service) = telemetry(app) {
        service.set_vault_root(root.clone());
    }
    if let Some(ship) = app.try_state::<Arc<logship::LogShip>>() {
        ship.set_vault_root(root);
    }
}

/// What the renderer needs before first paint, computed from the open vault's settings (or the
/// config cache when none is open) and the live locale.
pub fn startup_state(app: &AppHandle<Wry>) -> StartupState {
    let config = app.state::<Arc<AppConfig>>().inner().clone();
    let general = app.try_state::<SettingsService>().and_then(|settings| {
        let vault = app.state::<Session>().current()?;
        match settings.read_group(Some(&vault), "general") {
            Ok(read) => Some(read.value),
            // The first paint uses the cached startup values; the error reaches the renderer on
            // its own settings read, with its code (`device_identity_missing` and the others).
            Err(error) => {
                tracing::warn!(
                    scope = "Settings",
                    "the vault's settings could not be read for the first paint: {error}"
                );
                None
            }
        }
    });
    let values = startup_values::read(&config, general.as_ref());
    let locale = app.state::<Arc<LocaleService>>().get();
    StartupState {
        theme: values.theme,
        locale: locale.to_owned(),
        zoom: values.zoom,
        color_theme: values.color_theme,
        accent_color: general
            .as_ref()
            .and_then(|g| g.get("accentColor"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        direction: locale::direction(locale).to_owned(),
        startup_vault: app.state::<crate::shell::vault_boot::StartupVault>().get(),
        suppress_onboarding: cfg!(feature = "e2e")
            && app
                .state::<LaunchEnv>()
                .get("TEST_VAULT_PATH")
                .is_some_and(|v| !v.is_empty()),
        ..StartupState::default()
    }
}

/// Tracks focus for the heartbeat and reports `app_backgrounded` when focus leaves. Called by
/// the window event dispatcher for the main window.
pub fn on_focus(app: &AppHandle<Wry>, focused: bool) {
    app.state::<WindowFocus>()
        .0
        .store(focused, Ordering::Relaxed);
    if !focused && let Some(service) = telemetry(app) {
        lifecycle::backgrounded(&service);
    }
}
