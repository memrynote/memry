//! The `memry-ml-worker` sidecar (pdfium and Tesseract, out of process): one `WorkerHandle` for the app, read
//! by the file text runner of the open vault, which stops it on every vault close, and stopped in
//! the `stop-utility-processes` shutdown step. The child starts only on the first call.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use memry_desktop::notes::index::NoteIndex;
use memry_desktop::services::file_text::ocr::OcrEngine;
use memry_desktop::services::file_text::runner::Recognize;
use memry_desktop::services::file_text::service::{FileText, FileTextConfig};
use memry_desktop::services::file_text::{WorkerHandle, WorkerPaths};
use memry_desktop::services::ocr_languages::OcrLanguages;
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

/// A debug build runs from the checkout, where `scripts/fetch-pdfium.mjs` puts pdfium and the
/// English OCR data is committed; Tauri's resource dir of an unbundled build is the target dir, which holds no resources.
fn resource_dir(app: &AppHandle<Wry>) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(Path::new(env!("MEMRY_CHECKOUT_DIR")).join("src-tauri/resources"));
    }
    app.path().resource_dir().map_err(|error| error.to_string())
}

/// The file text runner of every open vault (#3542 lane G), reading PDFs and OCR through the
/// worker. No worker (see `manage`) leaves the app without file text this run, as without PDFs:
/// the runner's jobs would fail and be read again only a day later.
pub fn register(app: &AppHandle<Wry>, session: &Session) {
    let Some(worker) = app.try_state::<Arc<WorkerHandle>>() else {
        return;
    };
    let recognize = recognizer(app, worker.inner());
    let (languages, index) = (app.clone(), app.clone());
    let file_text = FileText::new(
        session,
        FileTextConfig {
            app_version: app.package_info().version.to_string(),
            pdf: worker.inner().clone(),
            recognize,
            ocr_languages: Arc::new(move || {
                languages
                    .try_state::<Arc<OcrLanguages>>()
                    .map(|service| {
                        service
                            .ready()
                            .iter()
                            .map(|l| l.code().to_owned())
                            .collect()
                    })
                    .unwrap_or_default()
            }),
            now_ms: Arc::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |since| {
                        i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
                    })
            }),
            indexing: Arc::new(move || {
                index
                    .try_state::<Arc<NoteIndex>>()
                    .is_some_and(|index| index.indexing().is_some())
            }),
        },
    );
    file_text.register();
    app.manage(file_text);
}

/// OCR with the languages the OCR languages service has ready. Without that service or the
/// resource dir, images and scanned pages fail `OCR unavailable` this run.
fn recognizer(app: &AppHandle<Wry>, worker: &Arc<WorkerHandle>) -> Option<Recognize> {
    let languages = app.try_state::<Arc<OcrLanguages>>()?.inner().clone();
    match resource_dir(app) {
        Ok(dir) => Some(OcrEngine::new(worker.clone(), &dir).recognizer(languages)),
        Err(error) => {
            tracing::error!(scope = "MlWorker", "no OCR this run: {error}");
            None
        }
    }
}
