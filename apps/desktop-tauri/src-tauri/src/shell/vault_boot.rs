//! The vault session's place in the app: built at the `VaultOpen` stage before the window,
//! its events forwarded to the renderer, and the repair prompt for a damaged `data.db`.

use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::paths::AppPaths;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::prompt::{self, Asker, RecoveryPrompt};
use memry_desktop::session::response::{VaultStatus, index_recovery_reason};
use memry_desktop::session::{OpenSource, Session, SessionEvent, StartupOutcome};
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::{CommandError, ErrorKind};
use crate::events::{
    VaultErrorEvent, VaultIndexRecoveredEvent, VaultListChangedEvent, VaultStatusChangedEvent,
    broadcast,
};
use crate::shell::dialogs;
use crate::startup::{self, Stage};

/// The registry file, beside the rest of the app data (`memry-config.json` of Electron).
pub const CONFIG_FILE: &str = "memry-config.json";

/// The vault the window is created for, read by `create_main_window`.
#[derive(Default)]
pub struct StartupVault(Mutex<Option<String>>);

impl StartupVault {
    pub fn get(&self) -> Option<String> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

/// A vault whose `data.db` is damaged at launch: the user is asked once the window exists,
/// because a dialog cannot block the main thread that `setup` runs on.
#[derive(Default)]
struct PendingRepair(Mutex<Option<PathBuf>>);

/// The one prompt of this app session, shared by the launch, the picker commands and the
/// runtime signal.
pub struct RepairPrompt(pub RecoveryPrompt);

struct DialogAsker(AppHandle<Wry>);

impl Asker for DialogAsker {
    fn confirm_repair(&self, data_db: &Path) -> bool {
        dialogs::confirm(
            &self.0,
            prompt::TITLE,
            prompt::MESSAGE,
            &prompt::detail(data_db),
            prompt::BUTTON_REPAIR,
            prompt::BUTTON_LATER,
        )
    }
}

pub fn asker(app: &AppHandle<Wry>) -> impl Asker + use<> {
    DialogAsker(app.clone())
}

pub fn register_stages() {
    startup::register(Stage::VaultOpen, "open the last vault", open_last_vault);
    startup::register(
        Stage::Schedulers,
        "offer vault repair",
        offer_startup_repair,
    );
}

fn open_last_vault(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let _ = APP.set(app.clone());
    let paths = app.state::<AppPaths>();
    std::fs::create_dir_all(&paths.data_dir).map_err(|error| {
        CommandError::new(ErrorKind::Storage, "app_data_dir", error.to_string())
    })?;
    let config = AppConfig::load(paths.data_dir.join(CONFIG_FILE));
    let session = Session::new(VaultRegistry::new(Arc::new(config)));
    // Subscribed before the first open, so the launch's own events reach the renderer's
    // listeners; the renderer reads `status()` once after it subscribes.
    forward_events(app.clone(), session.subscribe());
    app.manage(session.clone());
    app.manage(RepairPrompt(RecoveryPrompt::default()));
    app.manage(PendingRepair::default());

    let env = app.state::<LaunchEnv>();
    let startup = StartupVault::default();
    match session.open_startup(&env) {
        StartupOutcome::Opened(opened) => {
            *startup.0.lock().unwrap_or_else(PoisonError::into_inner) =
                Some(opened.vault.path.to_string_lossy().into_owned());
        }
        StartupOutcome::Picker => {}
        StartupOutcome::Failed { path, error } => {
            // The picker shows either way; a damaged database is offered repair below.
            if matches!(error, memry_desktop::session::SessionError::Corrupt { .. }) {
                let pending = app.state::<PendingRepair>();
                *pending.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(path);
            }
        }
    }
    app.manage(startup);
    Ok(())
}

fn offer_startup_repair(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let pending = app.state::<PendingRepair>();
    let Some(path) = pending
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
    else {
        return Ok(());
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let session = app.state::<Session>().inner().clone();
        let prompt = &app.state::<RepairPrompt>().0;
        let outcome = prompt.open_with_offer(&session, &asker(&app), &path, || {
            session.open(&path, OpenSource::Startup)
        });
        if let Err(error) = outcome {
            tracing::warn!(path = %path.display(), %error, "the vault stays closed; the picker shows");
        }
    });
    Ok(())
}

static APP: OnceLock<AppHandle<Wry>> = OnceLock::new();

/// A query hit `SQLITE_CORRUPT` with the vault open (`log_failure` sees a `storage_corrupt`
/// failure). Offers the same repair once per app session, off the calling thread. Does
/// nothing before the session exists.
pub fn offer_runtime_repair_if_ready() {
    let Some(app) = APP.get() else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(session) = app.try_state::<Session>() else {
            return;
        };
        let Some(prompt) = app.try_state::<RepairPrompt>() else {
            return;
        };
        match prompt.0.offer_for_open_vault(&session, &asker(&app)) {
            Some(Err(error)) => tracing::error!(%error, "the mid-session repair failed"),
            Some(Ok(_)) => tracing::info!("the vault was repaired and reopened"),
            None => {}
        }
    });
}

fn forward_events(app: AppHandle<Wry>, events: Receiver<SessionEvent>) {
    std::thread::spawn(move || {
        for event in events {
            match event {
                SessionEvent::StatusChanged(status) => {
                    broadcast(&app, VaultStatusChangedEvent(VaultStatus::from(status)));
                }
                SessionEvent::Error { message } => broadcast(&app, VaultErrorEvent { message }),
                SessionEvent::IndexRecovered { reason } => broadcast(
                    &app,
                    VaultIndexRecoveredEvent {
                        reason: index_recovery_reason(&reason).to_owned(),
                        detail: reason,
                    },
                ),
                SessionEvent::ListChanged => broadcast(&app, VaultListChangedEvent),
                // Telemetry and warnings are Step 09 (#3526)'s subscribers.
                SessionEvent::Opened { .. }
                | SessionEvent::Created { .. }
                | SessionEvent::ProjectionReconcileFailed { .. } => {}
            }
        }
    });
}
