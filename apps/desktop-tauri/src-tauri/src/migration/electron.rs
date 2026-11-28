//! The app's [`Backend`]: Step 37e2's `run_first_launch` over the Electron profile of this
//! machine, and its `migrate_vault` as the session's open hook. Electron has no such import;
//! this app's first launch after it is the only place the previous app's data moves.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use memry_desktop::e2e::E2eGate;
use memry_desktop::electron_import::ProfileEnv;
use memry_desktop::electron_import::orchestrator::marker::Marker;
use memry_desktop::electron_import::orchestrator::{
    FirstLaunch, FirstLaunchInput, ImportContext, MigrationEvent, MigrationEventName,
    MigrationTelemetry, preflight, run_first_launch, vault_migrator, wall_clock_ms,
};
use memry_desktop::electron_import::profile::{LEGACY_APP_NAME, PROFILE_DIR_VAR, locate_profile};
use memry_desktop::electron_import::progress::ProgressSink;
use memry_desktop::electron_import::secrets::{Guarded, OsKeySource, OsKeytar};
use memry_desktop::electron_import::secrets_import::SecretsMode;
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::paths::{AppPaths, DEVICE_VAR, device_id};
use memry_desktop::registry::AppConfig;
use memry_desktop::seams::secure_store::{DeviceIdentityStore, KeyringStore};
use memry_desktop::session::Session;
use memry_desktop::telemetry::events::{Metrics, TelemetryEvent};
use memry_desktop::telemetry::service::Service;
use tauri::{AppHandle, Manager, Wry};

use super::{Backend, LazyTelemetry, MigrationFailure, TelemetrySink};

pub struct ElectronBackend {
    /// `None`: nothing is imported on this launch.
    env: Option<ProfileEnv>,
    data_dir: PathBuf,
    /// The managed config, whose cache the rest of the boot reads after the import merged it.
    config: Arc<AppConfig>,
    device: Option<String>,
    gate: E2eGate,
    crash_after: Option<String>,
    /// One per kind of source for the process, so a stuck prompt never stacks another on a
    /// Try again (`secrets::timeout`).
    key_source: Guarded<OsKeySource>,
    keytar: Guarded<OsKeytar>,
    /// One keychain worker for every run, so a write stuck at a prompt never overlaps the next
    /// Try again's writes.
    keyring: OnceLock<Arc<KeyringStore>>,
}

impl ElectronBackend {
    pub fn new(app: &AppHandle<Wry>) -> Self {
        let launch = app.state::<LaunchEnv>();
        Self {
            env: launch_profile(&launch),
            data_dir: app.state::<AppPaths>().data_dir.clone(),
            config: app.state::<Arc<AppConfig>>().inner().clone(),
            device: launch.get(DEVICE_VAR).map(str::to_owned),
            gate: E2eGate::from_env(&launch),
            crash_after: ImportContext::crash_after_from(&launch),
            key_source: Guarded::new(OsKeySource),
            keytar: Guarded::new(OsKeytar),
            keyring: OnceLock::new(),
        }
    }
}

fn launch_profile(launch: &LaunchEnv) -> Option<ProfileEnv> {
    // Electron's unpackaged `app.getAppPath()`, the `apps/desktop` beside this app.
    let electron_app_dir = Path::new(env!("MEMRY_CHECKOUT_DIR")).with_file_name("desktop");
    profile_env(
        launch,
        !tauri::is_dev(),
        &electron_app_dir.to_string_lossy(),
    )
}

/// The Electron profile this launch reads. A test run (an open e2e gate) reads only the profile
/// `MEMRY_ELECTRON_PROFILE_DIR` names, never the host user's. A device run reads only the
/// device's own profile, `<appData>/@memry/desktop-<device>`: Electron skips
/// `applyMemrynoteIdentity` for a device and suffixes its default userData with the device
/// (`apps/desktop/src/main/index.ts` `resolveDeviceId` and the `if (deviceId)` block), so a dev
/// or A/B/C run never imports the production `memrynote` profile.
fn profile_env(launch: &LaunchEnv, packaged: bool, electron_app_dir: &str) -> Option<ProfileEnv> {
    // An empty value is no override (`ProfileEnv::from_host`), so it must not pass either.
    let override_set = launch.get(PROFILE_DIR_VAR).is_some_and(|v| !v.is_empty());
    if E2eGate::from_env(launch).is_open() && !override_set {
        return None;
    }
    let mut env = ProfileEnv::from_host(launch)?;
    if !override_set && let Some(device) = device_id(launch, packaged, electron_app_dir) {
        if env.app_data.as_os_str().is_empty() {
            return None;
        }
        let (scope, name) = LEGACY_APP_NAME.split_once('/')?;
        env.override_dir = Some(env.app_data.join(scope).join(format!("{name}-{device}")));
    }
    Some(env)
}

impl Backend for ElectronBackend {
    /// An unreadable marker or profile counts as needed: the run then fails on it and shows the
    /// check, where skipping would open vaults over data that never moved.
    fn needed(&self) -> bool {
        let Some(env) = &self.env else {
            return false;
        };
        if matches!(Marker::read(&self.data_dir), Ok(Some(_))) {
            return false;
        }
        locate_profile(env).map_or(true, |profile| {
            profile.is_some_and(|p| p.has_config || p.has_secure_store)
        })
    }

    fn run(
        &self,
        progress: &dyn ProgressSink,
        telemetry: &dyn TelemetrySink,
    ) -> Result<(), MigrationFailure> {
        let Some(env) = self.env.clone() else {
            return Ok(());
        };
        // The keychain `manage_settings` opens later, under the same names: its caches start
        // empty, so it reads what this run wrote.
        let keyring = self
            .keyring
            .get_or_init(|| {
                Arc::new(KeyringStore::new(
                    self.device.clone(),
                    self.gate,
                    &self.data_dir,
                ))
            })
            .clone();
        let identity = DeviceIdentityStore::new(keyring.clone(), &self.data_dir);
        let events = Events(telemetry);
        let ctx = ImportContext {
            env,
            tauri_data_dir: self.data_dir.clone(),
            progress,
            telemetry: &events,
            crash_after: self.crash_after.clone(),
            now_ms: wall_clock_ms,
            free_space: preflight::free_space,
        };
        let input = FirstLaunchInput {
            app_config: &self.config,
            keyring: &keyring,
            identity: &identity,
            key_source: &self.key_source,
            keytar: &self.keytar,
            secrets_mode: SecretsMode::Full,
        };
        match run_first_launch(&ctx, &input) {
            Ok(outcome) => {
                let outcome = match outcome {
                    FirstLaunch::NoProfile => "no profile",
                    FirstLaunch::AlreadyDone => "already done",
                    FirstLaunch::Migrated(_) => "migrated",
                };
                tracing::info!(scope = "Migration", outcome, "first-launch run finished");
                Ok(())
            }
            Err(error) => Err(MigrationFailure {
                check: error.check(),
                details: error.to_string(),
            }),
        }
    }

    fn backup(&self) -> PathBuf {
        self.env
            .as_ref()
            .and_then(|env| locate_profile(env).ok().flatten())
            .map(|profile| profile.dir)
            .unwrap_or_default()
    }

    /// The downgrade notice is not computed yet (#3554 follow-up): the marker keeps each
    /// vault's fingerprint for it.
    fn take_change_notice(&self) -> bool {
        false
    }
}

/// Installs `migrate_vault` as the session's open hook, so every open imports a vault the
/// first-launch run deferred before `.memry/core` exists, and refuses one whose data has not
/// moved. Nothing is installed when this launch reads no Electron profile, or when an e2e build
/// scripts the migration.
pub fn install_vault_migrator(app: &AppHandle<Wry>, session: &Session) {
    #[cfg(feature = "e2e")]
    if crate::e2e::migration::scripted(app).is_some() {
        return;
    }
    let launch = app.state::<LaunchEnv>();
    let Some(env) = launch_profile(&launch) else {
        return;
    };
    let started = app.clone();
    let enabled = app.clone();
    let telemetry: Arc<dyn TelemetrySink> = Arc::new(LazyTelemetry::new(
        Box::new(move || crate::shell::services::telemetry_started(&started)),
        Box::new(move || crate::shell::services::telemetry_enabled(&enabled)),
    ));
    session.set_vault_migrator(vault_migrator(
        env,
        app.state::<AppPaths>().data_dir.clone(),
        Arc::new(Owned(telemetry)),
        ImportContext::crash_after_from(&launch),
    ));
}

/// A run's event as the app's telemetry sends it: counts, a duration and a check, never a path.
pub fn telemetry_event(event: &MigrationEvent) -> TelemetryEvent {
    let (action, result) = match event.name {
        MigrationEventName::Started => ("started", None),
        MigrationEventName::Completed => ("completed", Some("success")),
        MigrationEventName::Failed => ("failed", Some("failed")),
    };
    let mut out = Service::event(event.name.as_str(), "app", action);
    out.result = result.map(str::to_owned);
    out.error_code.clone_from(&event.error_code);
    #[allow(clippy::cast_precision_loss)] // Counts and milliseconds far below 2^53.
    let metrics = Metrics {
        duration_ms: Some(event.duration_ms as f64),
        item_count: Some(f64::from(event.item_count)),
        queue_count: Some(f64::from(event.queue_count)),
        ..Metrics::default()
    };
    out.metrics = Some(metrics);
    out
}

struct Events<'a>(&'a dyn TelemetrySink);

impl MigrationTelemetry for Events<'_> {
    fn record(&self, event: MigrationEvent) {
        self.0.record(telemetry_event(&event));
    }
}

struct Owned(Arc<dyn TelemetrySink>);

impl MigrationTelemetry for Owned {
    fn record(&self, event: MigrationEvent) {
        self.0.record(telemetry_event(&event));
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use memry_desktop::e2e::E2E_VAR;
    use memry_desktop::electron_import::profile::{PROFILE_DIR_VAR, locate_profile};
    use memry_desktop::launch_env::LaunchEnv;
    use memry_desktop::paths::DEVICE_VAR;

    use super::profile_env;

    const APP_DIR: &str = "/checkout/apps/desktop";

    /// A launch whose app-data root, on every OS, sits in `home`.
    fn launch(home: &Path, vars: &[(&str, &str)]) -> LaunchEnv {
        let mut env = LaunchEnv::default();
        env.set("HOME", &home.to_string_lossy());
        env.set("APPDATA", &home.join("AppData").to_string_lossy());
        env.set("XDG_CONFIG_HOME", &home.join(".config").to_string_lossy());
        for (key, value) in vars {
            env.set(key, value);
        }
        env
    }

    fn write_profile(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("memry-config.json"), "{}").unwrap();
    }

    fn located(launch: &LaunchEnv, packaged: bool) -> Option<PathBuf> {
        let env = profile_env(launch, packaged, APP_DIR)?;
        locate_profile(&env).unwrap().map(|profile| profile.dir)
    }

    #[test]
    fn a_device_run_never_reads_the_production_profile() {
        let home = tempfile::tempdir().unwrap();
        let app_data = profile_env(&launch(home.path(), &[]), true, APP_DIR)
            .unwrap()
            .app_data;
        let production = app_data.join("memrynote");
        write_profile(&production);
        // The fixture is a profile the default run finds.
        let found = located(&launch(home.path(), &[]), true).unwrap();
        assert_eq!(
            fs::canonicalize(found).unwrap(),
            fs::canonicalize(&production).unwrap()
        );

        for (device, packaged) in [("dev", false), ("dev", true), ("A", true), ("B", false)] {
            let launch = launch(home.path(), &[(DEVICE_VAR, device)]);
            assert_eq!(
                located(&launch, packaged),
                None,
                "{device} packaged={packaged}"
            );
        }
    }

    #[test]
    fn a_device_run_reads_its_own_electron_profile() {
        let home = tempfile::tempdir().unwrap();
        let app_data = profile_env(&launch(home.path(), &[]), true, APP_DIR)
            .unwrap()
            .app_data;
        write_profile(&app_data.join("memrynote"));
        let device_a = app_data.join("@memry").join("desktop-A");
        write_profile(&device_a);
        let found = located(&launch(home.path(), &[(DEVICE_VAR, "A")]), true).unwrap();
        assert_eq!(
            fs::canonicalize(found).unwrap(),
            fs::canonicalize(&device_a).unwrap()
        );

        // An unpackaged dev run uses Electron's per-checkout `dev-<hash>` profile.
        let dev = launch(home.path(), &[(DEVICE_VAR, "dev")]);
        let hashed = memry_desktop::paths::device_id(&dev, false, APP_DIR).unwrap();
        assert!(hashed.starts_with("dev-") && hashed.len() == 12, "{hashed}");
        let dev_dir = app_data.join("@memry").join(format!("desktop-{hashed}"));
        write_profile(&dev_dir);
        let found = located(&dev, false).unwrap();
        assert_eq!(
            fs::canonicalize(found).unwrap(),
            fs::canonicalize(&dev_dir).unwrap()
        );
    }

    #[test]
    fn an_explicit_profile_dir_wins_over_the_device_profile() {
        let home = tempfile::tempdir().unwrap();
        let chosen = home.path().join("chosen");
        let launch = launch(
            home.path(),
            &[
                (DEVICE_VAR, "A"),
                (PROFILE_DIR_VAR, &chosen.to_string_lossy()),
            ],
        );
        let env = profile_env(&launch, true, APP_DIR).unwrap();
        assert_eq!(env.override_dir, Some(chosen));
    }

    #[test]
    fn an_e2e_run_reads_only_the_profile_dir_it_names() {
        let home = tempfile::tempdir().unwrap();
        write_profile(
            &profile_env(&launch(home.path(), &[]), true, APP_DIR)
                .unwrap()
                .app_data
                .join("memrynote"),
        );
        for vars in [
            vec![(E2E_VAR, "1")],
            vec![(E2E_VAR, "1"), (PROFILE_DIR_VAR, "")],
        ] {
            assert!(
                profile_env(&launch(home.path(), &vars), true, APP_DIR).is_none(),
                "{vars:?}"
            );
        }
        let chosen = home.path().join("chosen");
        let launch = launch(
            home.path(),
            &[(E2E_VAR, "1"), (PROFILE_DIR_VAR, &chosen.to_string_lossy())],
        );
        let env = profile_env(&launch, true, APP_DIR).unwrap();
        assert_eq!(env.override_dir, Some(chosen));
    }
}
