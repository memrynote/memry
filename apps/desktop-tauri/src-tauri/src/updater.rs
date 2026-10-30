//! The Tauri side of the in-app updater (`memry_desktop::updater::service`): picks the backend,
//! manages the one `UpdaterService`, forwards its state to every window, starts it after the main
//! window shows, and plugs it into the quit through the shutdown update hook.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use memry_desktop::electron_import::profile::{ProfileEnv, locate_profile};
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::locale::LocaleService;
use memry_desktop::paths::{AppPaths, DEVICE_VAR};
use memry_desktop::registry::AppConfig;
use memry_desktop::shell::shutdown::UpdateApplyHook;
use memry_desktop::updater::backend::UpdateBackend;
use memry_desktop::updater::service::{UpdaterDeps, UpdaterService};
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::CommandError;
use crate::events::{UpdaterStateChangedEvent, broadcast};
use crate::shell::services::telemetry;
use crate::shutdown::ShutdownService;
use crate::startup::{self, Stage};

/// The wait between the main window showing and the updater's first file read and feed check,
/// so none of it competes with the launch (Electron ran it at reveal).
const INIT_DELAY: Duration = Duration::from_secs(10);

pub fn register_stages() {
    startup::register(Stage::Handlers, "manage updater", manage);
}

mod channel;
#[cfg(windows)]
mod nsis_host;
pub mod relaunch_guard;
mod velopack_backend;
#[cfg(windows)]
pub mod webview2;

/// The backend of this process, the build it reports and how init runs.
struct Chosen {
    backend: Option<Arc<dyn UpdateBackend>>,
    /// The installed Velopack version, which replaces the bundle's: the packs carry the release
    /// version only in `sq.version`.
    version: Option<String>,
    channel: Option<String>,
    plan: InitPlan,
}

impl Chosen {
    fn none(delay: Duration) -> Self {
        Self {
            backend: None,
            version: None,
            channel: None,
            plan: InitPlan {
                delay,
                electron_profile: false,
            },
        }
    }
}

fn backend(app: &AppHandle<Wry>) -> Chosen {
    #[cfg(feature = "e2e")]
    if let Some(scripted) = scripted(app) {
        return Chosen {
            backend: Some(scripted),
            ..Chosen::none(Duration::ZERO)
        };
    }
    choose(&app.state::<LaunchEnv>(), || {
        velopack_backend::VelopackBackend::new().map(|velopack| Chosen {
            version: Some(velopack.current_version()),
            channel: Some(velopack.channel()),
            backend: Some(Arc::new(velopack)),
            plan: InitPlan {
                delay: INIT_DELAY,
                electron_profile: true,
            },
        })
    })
}

/// Every `MEMRY_DEVICE` profile has its own single-instance lock but shares the one install and
/// its `packages` directory, so a second profile's quit could install while the default profile
/// has its vault open, and the installer stops every process of the install (#3712). Only the
/// default profile updates, and the Velopack install is not even opened for another one;
/// `MEMRY_DEVICE` is a developer and test switch.
fn choose(env: &LaunchEnv, velopack: impl FnOnce() -> Result<Chosen, String>) -> Chosen {
    if let Some(device) = env.get(DEVICE_VAR).filter(|device| !device.is_empty()) {
        tracing::info!(
            scope = "Updater",
            "updates are off for the {DEVICE_VAR} profile {device}; the default profile installs them"
        );
        return Chosen::none(INIT_DELAY);
    }
    velopack().unwrap_or_else(|reason| {
        tracing::info!(
            scope = "Updater",
            "not a Velopack install, updates are off: {reason}"
        );
        Chosen::none(INIT_DELAY)
    })
}

/// `MEMRY_TEST_UPDATER=scripted` under an open e2e gate: the scripted backend, managed for the
/// `e2e_updater_*` commands. A spec scripts it after launch, so init runs at once.
#[cfg(feature = "e2e")]
fn scripted(app: &AppHandle<Wry>) -> Option<Arc<dyn UpdateBackend>> {
    use memry_desktop::e2e::E2eGate;
    use memry_desktop::launch_env::LaunchEnv;
    use memry_desktop::updater::scripted::ScriptedBackend;

    let env = app.state::<LaunchEnv>();
    if !E2eGate::from_env(&env).is_open() || env.get("MEMRY_TEST_UPDATER") != Some("scripted") {
        return None;
    }
    let backend = Arc::new(ScriptedBackend::new(
        app.state::<AppPaths>().data_dir.clone(),
        Duration::from_millis(150),
    ));
    app.manage(backend.clone());
    Some(backend)
}

/// macOS: the bundle runs outside `/Applications` and `~/Applications`, where a read-only volume
/// error means the app has to be moved first.
fn outside_applications() -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let roots = [
        Some(std::path::PathBuf::from("/Applications")),
        home.map(|h| h.join("Applications")),
    ];
    !roots.iter().flatten().any(|root| exe.starts_with(root))
}

fn manage(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let Chosen {
        backend,
        version,
        channel,
        plan,
    } = backend(app);
    let service = UpdaterService::new(UpdaterDeps {
        raw_version: version.unwrap_or_else(|| app.package_info().version.to_string()),
        channel,
        backend,
        config: app.state::<Arc<AppConfig>>().inner().clone(),
        data_dir: app.state::<AppPaths>().data_dir.clone(),
        telemetry: telemetry(app),
        locale: app.state::<Arc<LocaleService>>().inner().clone(),
        outside_applications: outside_applications(),
        runtime: tauri::async_runtime::handle().inner().clone(),
    });
    app.manage(service.clone());
    app.manage(plan);
    app.state::<ShutdownService>()
        .set_update_hook(Arc::new(Hook(service.clone())));
    forward_state(app, &service);
    Ok(())
}

/// When the service starts, and whether it reads the Electron profile's install marker and
/// removes the NSIS install an Electron build left (Windows): only an installed app does, so a
/// dev or e2e run never consumes the real profile's file or touches a real install.
struct InitPlan {
    delay: Duration,
    electron_profile: bool,
}

/// The profile the last Electron build used, which holds the marker it wrote before it handed
/// over to this app.
fn electron_profile(env: &LaunchEnv) -> Option<PathBuf> {
    match locate_profile(&ProfileEnv::from_host(env)?) {
        Ok(profile) => profile.map(|profile| profile.dir),
        Err(error) => {
            tracing::warn!(
                scope = "Updater",
                "could not locate the Electron profile for its install marker: {error}"
            );
            None
        }
    }
}

/// Every state change reaches every window. The `watch` receiver keeps only the latest value, so
/// a burst of progress ticks costs one event per wake.
fn forward_state(app: &AppHandle<Wry>, service: &UpdaterService) {
    let mut states = service.subscribe();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while states.changed().await.is_ok() {
            let state = states.borrow_and_update().clone();
            broadcast(&app, UpdaterStateChangedEvent(state));
        }
    });
}

/// Called once the main window shows: starts the service after its delay.
pub fn on_window_shown(app: &AppHandle<Wry>) {
    let Some(service) = app.try_state::<Arc<UpdaterService>>() else {
        return;
    };
    let service = service.inner().clone();
    let (delay, reads_profile) = app
        .try_state::<InitPlan>()
        .map_or((INIT_DELAY, false), |plan| {
            (plan.delay, plan.electron_profile)
        });
    let env = app.state::<LaunchEnv>().inner().clone();
    #[cfg(windows)]
    let leftover = reads_profile.then(|| nsis_host::Inputs::read(app));
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        // File reads: the markers, the health file and the Electron profile lookup.
        let started = tauri::async_runtime::spawn_blocking(move || {
            let profile = reads_profile.then(|| electron_profile(&env)).flatten();
            service.init(profile.as_deref());
            #[cfg(windows)]
            if let Some(inputs) = leftover {
                nsis_host::retire(&service, inputs, profile.as_deref());
            }
        })
        .await;
        if let Err(error) = started {
            tracing::error!(scope = "Updater", "updater init stopped: {error}");
        }
    });
}

/// The quit began: no check or download starts or lands after this.
pub fn stop(app: &AppHandle<Wry>) {
    if let Some(service) = app.try_state::<Arc<UpdaterService>>() {
        service.stop();
    }
}

/// The shutdown sequence's view of the updater.
struct Hook(Arc<UpdaterService>);

impl UpdateApplyHook for Hook {
    fn disable_install_on_quit(&self) {
        self.0.disable_install_on_quit();
    }

    fn enable_install_on_quit(&self) {
        self.0.enable_install_on_quit();
    }

    fn install_requested(&self) -> bool {
        self.0.install_requested()
    }

    /// A failed hand-off is in the state and the install streak; the sequence exits either way,
    /// since the user's data is already flushed and the window is gone.
    fn apply_and_restart(&self) {
        self.0.apply_and_restart();
    }

    fn apply_on_quit(&self) {
        self.0.apply_on_quit();
    }
}

#[cfg(test)]
mod tests {
    use super::{Chosen, DEVICE_VAR, INIT_DELAY, InitPlan, LaunchEnv, choose};

    fn launch(device: Option<&str>) -> LaunchEnv {
        let mut env = LaunchEnv::default();
        if let Some(device) = device {
            env.set(DEVICE_VAR, device);
        }
        env
    }

    fn velopack_install() -> Result<Chosen, String> {
        Ok(Chosen {
            version: Some("2099.101.9".to_owned()),
            plan: InitPlan {
                delay: INIT_DELAY,
                electron_profile: true,
            },
            ..Chosen::none(INIT_DELAY)
        })
    }

    #[test]
    fn only_the_default_profile_updates_the_shared_install() {
        for device in [None, Some("")] {
            let chosen = choose(&launch(device), velopack_install);
            assert_eq!(chosen.version.as_deref(), Some("2099.101.9"), "{device:?}");
            assert!(chosen.plan.electron_profile, "{device:?}");
        }
        for device in ["b", "dev"] {
            let chosen = choose(&launch(Some(device)), || {
                panic!("{device}: the install is not opened")
            });
            assert!(
                chosen.backend.is_none() && chosen.version.is_none(),
                "{device}"
            );
            assert!(!chosen.plan.electron_profile, "{device}");
        }
    }

    #[test]
    fn outside_a_velopack_install_updates_are_off() {
        let chosen = choose(&launch(None), || Err("no sq.version".to_owned()));
        assert!(chosen.backend.is_none() && chosen.version.is_none());
        assert!(!chosen.plan.electron_profile);
    }
}
