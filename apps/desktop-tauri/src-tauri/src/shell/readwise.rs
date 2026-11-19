//! The open vault's Readwise run service (`readwise::scheduler::ReadwiseRuns`): built with every
//! vault open and for the vault open at launch, stopped with every close, so a vault switch
//! rebuilds it over the new vault's token and run state. A sign-out cancels the run in flight;
//! the schedule goes on and the next run pulls with no claim, as a signed-out install does.
//! The run status reaches the renderer as `ImportReadwiseStatusChangedEvent`.

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use memry_desktop::account::AccountService;
use memry_desktop::attachments::RemoteImages;
use memry_desktop::editor::EditorHost;
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::service::NotesService;
use memry_desktop::paths::DEVICE_VAR;
use memry_desktop::readwise::client::ReadwiseClient;
use memry_desktop::readwise::engine::Engine;
use memry_desktop::readwise::library::Library;
use memry_desktop::readwise::pull_gate::{PullGate, SyncView};
use memry_desktop::readwise::run_types::{RunGate, system_time_zone};
use memry_desktop::readwise::scheduler::{ReadwiseRuns, RunsParts};
use memry_desktop::readwise::sync_view::SessionSyncView;
use memry_desktop::readwise::token::ReadwiseToken;
use memry_desktop::seams::reachability::DesktopReachability;
use memry_desktop::seams::secure_store::{DeviceIdentityStore, GenericSecrets, KeyringStore};
use memry_desktop::session::{OpenStage, OpenVault, Session};
use memry_desktop::vault::activity::ActivityLog;
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::CommandError;
use crate::events::{ImportReadwiseStatusChangedEvent, broadcast};
use crate::shell::services;
use crate::startup::{self, Stage};

const SCOPE: &str = "Readwise:Shell";

/// The open vault's run service, `None` while no vault is open.
#[derive(Default)]
pub struct ReadwiseSlot(Mutex<Option<Arc<ReadwiseRuns>>>);

impl ReadwiseSlot {
    pub fn current(&self) -> Option<Arc<ReadwiseRuns>> {
        lock(&self.0).clone()
    }

    /// Stops whatever it held, so a run never outlives its vault.
    fn replace(&self, runs: Option<Arc<ReadwiseRuns>>) {
        let old = std::mem::replace(&mut *lock(&self.0), runs);
        if let Some(old) = old {
            old.stop();
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn register_stages() {
    startup::register(Stage::Schedulers, "start Readwise runs", start);
}

/// After the account stage, which manages the reachability this reads.
fn start(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    app.manage(ReadwiseSlot::default());
    let session = app.state::<Session>().inner().clone();
    let opened = app.clone();
    session.on_open(
        "readwise",
        OpenStage::SyncStart,
        Arc::new(move |open| {
            install(&opened, open);
            Ok(())
        }),
    );
    let closed = app.clone();
    session.on_close(
        "readwise",
        Arc::new(move |_| closed.state::<ReadwiseSlot>().replace(None)),
    );
    // The launch vault opened before these hooks existed. Off the setup thread: a build reads
    // the keychain.
    let launch = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(open) = launch.state::<Session>().current() {
            install(&launch, &open);
        }
    });
    Ok(())
}

/// A sign-out stops the run in flight; the next tick runs signed out.
pub fn cancel_run(app: &AppHandle<Wry>) {
    if let Some(runs) = app
        .try_state::<ReadwiseSlot>()
        .and_then(|slot| slot.current())
    {
        runs.cancel();
    }
}

fn install(app: &AppHandle<Wry>, open: &OpenVault) {
    match build(app, open) {
        Ok(runs) => {
            let notify = app.clone();
            runs.status()
                .on_change(move || broadcast(&notify, ImportReadwiseStatusChangedEvent));
            runs.start();
            app.state::<ReadwiseSlot>().replace(Some(runs));
        }
        Err(error) => {
            tracing::error!(scope = SCOPE, %error, "Readwise does not run for this vault");
            app.state::<ReadwiseSlot>().replace(None);
        }
    }
}

fn managed<T: Send + Sync + 'static + Clone>(
    app: &AppHandle<Wry>,
    what: &str,
) -> Result<T, String> {
    app.try_state::<T>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| format!("no {what}"))
}

fn now_ms() -> i64 {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
}

fn build(app: &AppHandle<Wry>, open: &OpenVault) -> Result<Arc<ReadwiseRuns>, String> {
    let notes: Arc<NotesService> = managed(app, "notes service")?;
    let index: Arc<NoteIndex> = managed(app, "note index")?;
    let account: Arc<AccountService> = managed(app, "account")?;
    let keyring: Arc<KeyringStore> = managed(app, "keychain")?;
    let runtime = tauri::async_runtime::handle().inner().clone();
    let indexed = Arc::clone(&index);
    let library = Library::new(
        open.clone(),
        notes,
        managed::<Arc<EditorHost>>(app, "editor host")?,
        managed::<Arc<RemoteImages>>(app, "remote images")?,
        Arc::new(move || indexed.indexing().is_some()),
        runtime.clone(),
        managed::<Arc<ActivityLog>>(app, "activity log")?,
    );
    let device = app.state::<LaunchEnv>().get(DEVICE_VAR).map(str::to_owned);
    let token = || {
        let secrets: Arc<dyn GenericSecrets> = keyring.clone();
        ReadwiseToken::new(secrets, &open.path, device.as_deref()).map_err(|e| e.to_string())
    };
    let (ids, signed) = (Arc::clone(&account), Arc::clone(&account));
    let sync: Arc<dyn SyncView> = Arc::new(SessionSyncView::new(
        app.state::<Session>().inner().clone(),
        index,
        runtime,
        Arc::new(move || ids.device_id()),
        // No local device-name table here: the claim names no device ("another device").
        Arc::new(|| None),
        Arc::new(move || signed.sync_facts().0),
    ));
    let identity: Arc<DeviceIdentityStore> = managed(app, "device identity store")?;
    let settings = (open.vault).settings(identity).map_err(|e| e.to_string())?;
    let gate = Arc::new(PullGate::new(
        library.store(),
        settings,
        token()?,
        Arc::clone(&sync),
    ));
    let clock = Arc::new(now_ms);
    let client = ReadwiseClient::new();
    let engine = Engine::new(
        client.clone(),
        Arc::clone(&gate) as Arc<dyn RunGate>,
        clock.clone(),
        Arc::new(system_time_zone),
    );
    let reachability = app
        .try_state::<Arc<DesktopReachability>>()
        .map(|state| state.inner().clone());
    let telemetry = services::telemetry(app);
    Ok(Arc::new(ReadwiseRuns::new(RunsParts {
        library,
        engine,
        gate,
        token: token()?,
        client,
        sync,
        online: Arc::new(move || reachability.as_ref().is_none_or(|r| r.is_online())),
        clock,
        track: Arc::new(move |event| {
            if let Some(telemetry) = &telemetry {
                telemetry.track(event);
            }
        }),
    })))
}
