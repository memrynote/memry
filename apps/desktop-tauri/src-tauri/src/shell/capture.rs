//! The browser extension's capture server in the app (Step 27, #3544). It starts once the
//! launch's vault open has resolved (Electron's `autoOpenLastVault().then(startCaptureServer)`,
//! `index.ts:1761`), survives vault switches, and stops in the `stop-capture-server` shutdown
//! step. The `pair` deep link opens the claim window only after Step 11's confirm dialog
//! (`deep_link::DeepLinkRouter::confirm_pair`). Routes and checks are
//! `memry_desktop::services::capture`.

use std::sync::{Arc, Mutex, PoisonError};

use memry_desktop::i18n::{self, Args};
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::locale::LocaleService;
use memry_desktop::paths::DEVICE_VAR;
use memry_desktop::registry::AppConfig;
use memry_desktop::seams::secure_store::{DeviceIdentityStore, KeyringStore};
use memry_desktop::services::capture::pairing::Pairing;
use memry_desktop::services::capture::{self, CaptureDeps, CaptureServer, Consent};
use memry_desktop::session::Session;
use memry_desktop::telemetry::diagnostics::Failure;
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::{CommandError, ErrorKind};
use crate::deep_link::DeepLinkRouter;
use crate::shutdown::ShutdownService;
use crate::startup::{self, Stage};
use crate::windows::registry::WindowRegistry;

/// The running server, taken by `stop-capture-server`.
#[derive(Default)]
struct Running(Mutex<Option<CaptureServer>>);

pub fn register_stages() {
    // After `VaultOpen`, which manages the `Session`.
    startup::register(Stage::Schedulers, "start the capture server", start);
}

fn start(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let device = app.state::<LaunchEnv>().get(DEVICE_VAR).map(str::to_owned);
    let pairing = Arc::new(Pairing::new(
        app.state::<Arc<KeyringStore>>().inner().clone(),
        device.as_deref(),
        app.state::<Arc<AppConfig>>().inner().clone(),
    ));
    let opener = pairing.clone();
    app.state::<DeepLinkRouter>()
        .on("pair", Arc::new(move |_, _| opener.open_window()));

    app.manage(Running::default());
    let stopping = app.clone();
    app.state::<ShutdownService>()
        .register(
            "stop-capture-server",
            Arc::new(move |_, _| {
                let running = stopping.state::<Running>();
                drop(
                    running
                        .0
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .take(),
                );
                Box::pin(async { Ok(()) })
            }),
        )
        .map_err(|error| {
            CommandError::new(ErrorKind::Internal, "shutdown_step", error.to_string())
        })?;

    let telemetry = crate::shell::services::telemetry(app);
    let deps = CaptureDeps {
        session: app.state::<Session>().inner().clone(),
        store: app.state::<Arc<DeviceIdentityStore>>().inner().clone(),
        pairing,
        consent: consent(app),
        version: app.package_info().version.to_string(),
        hero: None,
        filer: None,
        telemetry: telemetry.clone(),
    };
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match capture::start(deps).await {
            Ok(server) => {
                *handle
                    .state::<Running>()
                    .0
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner) = Some(server);
            }
            // The clipper is off for this launch; the app runs on.
            Err(error) => {
                tracing::error!(scope = "Capture", "capture server failed to start: {error}");
                if let Some(telemetry) = telemetry {
                    let failure = Failure {
                        code: Some(format!("{:?}", error.kind())),
                        message: error.to_string(),
                        expected_condition: false,
                        expected_warning: false,
                    };
                    telemetry.track_main_error("capture_server", "capture_server_start", &failure);
                }
            }
        }
    });
    Ok(())
}

/// `showPairConsentDialog` (`consent-dialog.ts`): the main window comes forward first, since
/// the browser stays frontmost and a hidden window would hide the prompt; no main window
/// answers Deny. The origin is the dialog's detail line.
fn consent(app: &AppHandle<Wry>) -> Consent {
    let app = app.clone();
    Arc::new(move |origin: &str| {
        if WindowRegistry::main_window(&app).is_none() {
            return false;
        }
        crate::tray::show_main_window(&app);
        let locale = app.state::<Arc<LocaleService>>().get();
        let t = |key: &str| i18n::t(locale, key, &Args::new());
        crate::shell::dialogs::confirm(
            &app,
            &t("system:dialog.pair.title"),
            &t("system:dialog.pair.message"),
            origin,
            &t("system:dialog.pair.buttonAllow"),
            &t("system:dialog.pair.buttonDeny"),
        )
    })
}
