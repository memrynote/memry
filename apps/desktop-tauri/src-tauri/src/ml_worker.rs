//! The `memry-ml-worker` sidecar (pdfium, out of process): one `WorkerHandle` for the app, stopped
//! on every vault close and in the `stop-utility-processes` shutdown step. It has no caller until
//! the file-text runner lands (#3542 lane G), and the child starts only on the first call.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use memry_desktop::services::file_text::{WorkerHandle, WorkerPaths};
use memry_desktop::session::Session;
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::{CommandError, ErrorKind};
use crate::shutdown::ShutdownService;
use crate::startup::{self, Stage};

/// After `manage shutdown`, whose service the step registers with.
pub fn register_stages() {
    startup::register(Stage::Handlers, "manage ml worker", manage);
}

/// A path that cannot be resolved leaves the app without the worker, logged, rather than failing
/// the launch: PDF text is background work.
fn manage(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let paths = match worker_paths(app) {
        Ok(paths) => paths,
        Err(error) => {
            tracing::error!(scope = "MlWorker", "no PDF worker this run: {error}");
            return Ok(());
        }
    };
    let worker = WorkerHandle::new(paths);
    let stopping = worker.clone();
    app.state::<ShutdownService>()
        .register(
            "stop-utility-processes",
            Arc::new(move |_, _| {
                let worker = stopping.clone();
                Box::pin(async move {
                    tauri::async_runtime::spawn_blocking(move || worker.stop())
                        .await
                        .map_err(|error| error.to_string())
                })
            }),
        )
        .map_err(|error| {
            CommandError::new(ErrorKind::Internal, "shutdown_step", error.to_string())
        })?;
    app.manage(worker);
    Ok(())
}

fn worker_paths(app: &AppHandle<Wry>) -> Result<WorkerPaths, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let exe_dir = exe.parent().ok_or("the executable has no directory")?;
    Ok(WorkerPaths::new(exe_dir, &resource_dir(app)?))
}

/// A debug build runs from the checkout, where `scripts/fetch-pdfium.mjs` puts pdfium; Tauri's
/// resource dir of an unbundled build is the target dir, which holds no resources.
fn resource_dir(app: &AppHandle<Wry>) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(Path::new(env!("MEMRY_CHECKOUT_DIR")).join("src-tauri/resources"));
    }
    app.path().resource_dir().map_err(|error| error.to_string())
}

/// Every vault close stops the worker: its open documents belong to that vault. No worker (see
/// `manage`) leaves nothing to stop.
pub fn register_on_close(app: &AppHandle<Wry>, session: &Session) {
    if let Some(worker) = app.try_state::<Arc<WorkerHandle>>() {
        worker.register(session);
    }
}
