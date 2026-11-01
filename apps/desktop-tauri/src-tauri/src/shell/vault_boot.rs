//! The vault session's place in the app: built at the `VaultOpen` stage before the window,
//! its events forwarded to the renderer, and the repair prompt for a damaged `data.db`.

use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::launch_timeline::LaunchPhase;
use memry_desktop::locale::LocaleService;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::service::NotesService;
use memry_desktop::paths::AppPaths;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::session::OpenStage;
use memry_desktop::session::prompt::{self, Asker, RecoveryPrompt};
use memry_desktop::session::response::{VaultStatus, index_recovery_reason};
use memry_desktop::session::{OpenSource, Session, SessionEvent, StartupOutcome};
use memry_desktop::settings::SettingsService;
use memry_desktop::telemetry::service::Service;
use memry_desktop::vault::consumer::VaultTier;
use memry_desktop::vault::writeback::{Failure, WriteBackFailed};
use tauri::{AppHandle, Manager, Wry};
use tokio::sync::broadcast::error::RecvError;

use crate::commands::error::{CommandError, ErrorKind};
use crate::events::{
    CrdtWriteBackFailedEvent, NoteLinksChangedEvent, VaultActivityChangedEvent, VaultErrorEvent,
    VaultIndexProgressEvent, VaultIndexRecoveredEvent, VaultListChangedEvent,
    VaultStatusChangedEvent, WriteBackFailureReason, broadcast,
};
use crate::shell::{dialogs, services};
use crate::shutdown::ShutdownService;
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
        let locale = self.0.state::<Arc<LocaleService>>().get();
        let text = prompt::text(locale);
        dialogs::confirm(
            &self.0,
            &text.title,
            &text.message,
            &prompt::detail(locale, data_db),
            &text.repair,
            &text.later,
        )
    }
}

pub fn asker(app: &AppHandle<Wry>) -> impl Asker + use<> {
    DialogAsker(app.clone())
}

/// Seeds a vault's settings from its `config.json` preferences when it opens. A failure is
/// logged and never blocks the open: the settings read as defaults.
fn register_settings_hook(app: &AppHandle<Wry>, session: &Session) {
    let settings = app.state::<SettingsService>().inner().clone();
    session.on_open(
        "settings",
        OpenStage::Settings,
        Arc::new(move |vault| {
            if let Err(error) = settings.on_open(vault) {
                tracing::warn!(
                    scope = "Settings",
                    "vault settings were not seeded: {error}"
                );
            }
            Ok(())
        }),
    );
}

/// Starts the vault watcher and its consumer with every open and stops them with every close,
/// with the notes identity (Step 13d) naming the note of each file. The tier is managed so the
/// app's own file operations reach its own-write record and its row lane, and the notes service
/// (Step 13f) over it, whose row facts become the note events. The note index follows the
/// tier's facts in the background of every open, broadcasts the progress of each open's pass
/// and the links each pass committed, and is managed for `vault_reindex`. The pre-sync template
/// files import as the vault opens (Step 13l), into its activity log.
fn register_vault_watcher(app: &AppHandle<Wry>, session: &Session) {
    // Managed by the `Handlers` stage, which runs before this one.
    let Some(store) = app.try_state::<Arc<DeviceIdentityStore>>() else {
        tracing::error!(
            scope = "vault_consumer",
            "no device identity store: vaults open without file watching"
        );
        return;
    };
    let tier = VaultTier::new(store.inner().clone());
    tier.set_identity(NotesIdentity::new(store.inner().clone()));
    tier.register(session);
    let reporter = app.clone();
    let announcer = app.clone();
    let index = NoteIndex::new(
        tier.clone(),
        move |step| broadcast(&reporter, VaultIndexProgressEvent::from(step)),
        move |links| broadcast(&announcer, NoteLinksChangedEvent::from(links)),
    );
    index.register(session);
    app.manage(index);
    register_flushes(app, &tier);
    forward_writeback_failures(app.clone(), tier.subscribe_failures());
    forward_activity_changes(app.clone(), tier.activity().subscribe());
    memry_desktop::templates::legacy::register(session, store.inner().clone(), tier.activity());
    app.manage(tier.activity());
    let notes = NotesService::new(tier.clone(), store.inner().clone());
    crate::shell::note_events::forward(app.clone(), tier.subscribe());
    app.manage(notes);
    app.manage(tier);
}

/// `flush-writebacks`: no edit scheduled for a note's file waits out the quit.
/// `flush-activity-log`: the buffered activity entries reach the file.
fn register_flushes(app: &AppHandle<Wry>, tier: &Arc<VaultTier>) {
    // Managed by the `Handlers` stage, which runs before this one.
    let Some(shutdown) = app.try_state::<ShutdownService>() else {
        tracing::error!(
            scope = "vault_writeback",
            "no shutdown service: a quit does not wait for the write-back"
        );
        return;
    };
    for (step, run) in [
        ("flush-writebacks", tier.flush_step()),
        ("flush-activity-log", tier.activity().flush_step()),
    ] {
        if let Err(error) = shutdown.register(step, run) {
            tracing::error!(scope = "vault_writeback", "{error}");
        }
    }
}

/// A missed notice is one refetch fewer: the next one refetches everything.
fn forward_activity_changes(
    app: AppHandle<Wry>,
    mut changes: tokio::sync::broadcast::Receiver<()>,
) {
    std::thread::spawn(move || {
        while let Ok(()) | Err(RecvError::Lagged(_)) = changes.blocking_recv() {
            broadcast(&app, VaultActivityChangedEvent);
        }
    });
}

fn forward_writeback_failures(
    app: AppHandle<Wry>,
    mut failures: tokio::sync::broadcast::Receiver<WriteBackFailed>,
) {
    std::thread::spawn(move || {
        loop {
            match failures.blocking_recv() {
                Ok(WriteBackFailed {
                    note_id,
                    title,
                    reason,
                }) => {
                    let reason = match reason {
                        Failure::Write => WriteBackFailureReason::Write,
                        Failure::Frontmatter => WriteBackFailureReason::Frontmatter,
                    };
                    broadcast(
                        &app,
                        CrdtWriteBackFailedEvent {
                            note_id,
                            title,
                            reason,
                        },
                    );
                }
                Err(RecvError::Lagged(missed)) => tracing::warn!(
                    scope = "vault_writeback",
                    missed,
                    "write-back failure notices were dropped"
                ),
                Err(RecvError::Closed) => break,
            }
        }
    });
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
    // Loaded by the `I18n` stage, which needs it for the language.
    let config = app.state::<Arc<AppConfig>>().inner().clone();
    let session = Session::new(VaultRegistry::new(config));
    register_settings_hook(app, &session);
    register_vault_watcher(app, &session);
    // Subscribed before the first open, so the launch's own events reach the renderer's
    // listeners; the renderer reads `status()` once after it subscribes.
    forward_events(app.clone(), session.subscribe());
    app.manage(session.clone());
    app.manage(RepairPrompt(RecoveryPrompt::default()));
    app.manage(PendingRepair::default());

    let env = app.state::<LaunchEnv>();
    let startup = StartupVault::default();
    services::mark_phase(app, LaunchPhase::VaultOpenStart);
    let outcome = session.open_startup(&env);
    services::mark_phase(app, LaunchPhase::VaultOpenReady);
    match outcome {
        StartupOutcome::Opened(opened) => {
            let root = opened.vault.path.to_string_lossy().into_owned();
            services::set_vault_root(app, Some(root.clone()));
            *startup.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(root);
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
                    let is_open = status.is_open;
                    broadcast(&app, VaultStatusChangedEvent(VaultStatus::from(status)));
                    crate::windows::main_window::on_vault_status(&app, is_open);
                    // The keyboard rebinds belong to the vault, so the menu follows it.
                    crate::menu::apply(&app, false);
                    if let Err(error) = crate::tray::apply_from_settings(&app) {
                        tracing::warn!(scope = "Tray", "could not apply the tray setting: {error}");
                    }
                    // After the tray: registering a shortcut and the login item are slower, and
                    // the tray must follow the vault as soon as the status changes.
                    crate::shortcuts::apply_from_settings(&app);
                    if is_open {
                        crate::autostart::on_vault_opened(&app);
                    }
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
                SessionEvent::Opened { source, path } => {
                    services::set_vault_root(&app, Some(path));
                    // The launch's own open is not a user action.
                    if let Some(source) = source_name(source) {
                        track_vault(&app, "vault_opened", "opened", source);
                    }
                }
                SessionEvent::Created { .. } => {
                    track_vault(&app, "vault_created", "created", "create")
                }
                // The projection owners report these (Step 13).
                SessionEvent::ProjectionReconcileFailed { .. } => {}
            }
        }
    });
}

fn source_name(source: OpenSource) -> Option<&'static str> {
    match source {
        OpenSource::Startup => None,
        OpenSource::Select => Some("select"),
        OpenSource::Switch => Some("switch"),
        OpenSource::Create => Some("create"),
    }
}

fn track_vault(app: &AppHandle<Wry>, name: &str, action: &str, source: &str) {
    let Some(telemetry) = services::telemetry(app) else {
        return;
    };
    let mut event = Service::event(name, "vault", action);
    event.source = Some(source.to_owned());
    event.result = Some("success".to_owned());
    telemetry.track(event);
}
