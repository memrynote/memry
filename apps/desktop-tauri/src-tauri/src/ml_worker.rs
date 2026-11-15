//! The `memry-ml-worker` sidecar, out of process, as two children of the same binary: the PDF
//! worker (pdfium, one `WorkerHandle`, read by the file text runner of the open vault, which stops
//! it on every vault close, #3542 lane G) and the embedding model (`WorkerModel` under the app's
//! `EmbeddingService`, Step 23). Each child starts on its first call and stops on every vault close
//! and in the `stop-utility-processes` shutdown step. The note embedding lane runs on every open
//! vault.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use memry_desktop::ai::features;
use memry_desktop::embedding::projector::NoteEmbeddingProjector;
use memry_desktop::embedding::service::{EmbeddingService, Timing};
use memry_desktop::embedding::worker::{WorkerModel, exit_telemetry};
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::paths::AppPaths;
use memry_desktop::services::file_text::service::{FileText, FileTextConfig};
use memry_desktop::services::file_text::{WorkerHandle, WorkerPaths};
use memry_desktop::services::ocr_languages::OcrLanguages;
use memry_desktop::session::Session;
use memry_desktop::session::projection::feed;
use memry_desktop::settings::SettingsService;
use memry_desktop::vault::consumer::VaultTier;
use tauri::{AppHandle, Manager, Runtime, Wry};

use crate::commands::error::{CommandError, ErrorKind};
use crate::shutdown::ShutdownService;
use crate::startup::{self, Stage};

/// After `manage shutdown`, whose service the step registers with.
pub fn register_stages() {
    startup::register(Stage::Handlers, "manage ml worker", manage);
}

/// A path that cannot be resolved leaves the app without the workers, logged, rather than failing
/// the launch: PDF text and embeddings are background work, and the notes stay owed (the
/// embedding lane's stored hashes) for a run that has the model.
fn manage(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let paths = match worker_paths(app) {
        Ok(paths) => paths,
        Err(error) => {
            tracing::error!(
                scope = "MlWorker",
                "no PDF or embedding worker this run: {error}"
            );
            return Ok(());
        }
    };
    let worker = WorkerHandle::new(paths.clone());
    let telemetry = app.clone();
    let model = WorkerModel::new(
        &paths,
        app.state::<AppPaths>()
            .data_dir
            .join("models")
            .join("transformers"),
        tauri::async_runtime::handle().inner().clone(),
        exit_telemetry(move || crate::shell::services::telemetry(&telemetry)),
    );
    // A log sink until the renderer's progress event lands (#3540 lane 11).
    let service = EmbeddingService::new(
        model.clone(),
        Arc::new(|progress| {
            tracing::debug!(
                scope = "Embeddings",
                phase = ?progress.phase,
                progress = progress.progress,
                status = progress.status,
                "model progress"
            );
        }),
        Timing::default(),
    );
    let shutdown = app.state::<ShutdownService>();
    let to_error = |error: memry_desktop::shell::shutdown::UnknownStep| {
        CommandError::new(ErrorKind::Internal, "shutdown_step", error.to_string())
    };
    // The embedding thread is retired first, so it takes no new request, then both children are
    // killed, which fails an inference in flight at once; the service's step then waits for the
    // thread to finish.
    let (stopping, stopping_model, stopping_service) =
        (worker.clone(), model.clone(), service.clone());
    shutdown
        .register(
            "stop-utility-processes",
            Arc::new(move |_, _| {
                let (worker, model, service) = (
                    stopping.clone(),
                    stopping_model.clone(),
                    stopping_service.clone(),
                );
                Box::pin(async move {
                    tauri::async_runtime::spawn_blocking(move || {
                        service.stop();
                        worker.stop();
                        model.stop();
                    })
                    .await
                    .map_err(|error| error.to_string())
                })
            }),
        )
        .map_err(to_error)?;
    shutdown
        .register("stop-utility-processes", service.shutdown_step())
        .map_err(to_error)?;
    app.manage(worker);
    app.manage(model);
    app.manage(service);
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

/// Every vault close stops the embedding model: no embedding request of the closing vault is
/// served once the next one opens. The PDF worker is stopped by the file text runner's close
/// (`register`). No model (see `manage`) leaves nothing to stop.
pub fn register_on_close<R: Runtime>(app: &AppHandle<R>, session: &Session) {
    if let Some(model) = app.try_state::<Arc<WorkerModel>>() {
        model.register(session);
    }
    if let Some(service) = app.try_state::<Arc<EmbeddingService>>() {
        service.register(session);
    }
}

/// The note embedding lane on every open of `session`, fed by `tier`'s facts and deferred while
/// `index` builds. Registered before the first open. Without the managed service (see `manage`)
/// there is no lane and no feed: the feed's events would reach no projector, and the notes stay
/// owed. The lane checks the vault's `ai.enabled` before every inference and embeds nothing once
/// the vault closes (REVIEW-4548).
pub fn register_embedding_lane<R: Runtime>(
    app: &AppHandle<R>,
    session: &Session,
    index: &Arc<NoteIndex>,
    tier: &VaultTier,
) {
    let (Some(service), Some(settings)) = (
        app.try_state::<Arc<EmbeddingService>>(),
        app.try_state::<SettingsService>(),
    ) else {
        tracing::error!(
            scope = "Embeddings",
            "no embedding service or settings: notes are not embedded this run"
        );
        return;
    };
    let settings = settings.inner().clone();
    let index = Arc::downgrade(index);
    let projector = NoteEmbeddingProjector::new(
        session,
        service.inner().clone(),
        Arc::new(move |open| features::read(&settings, Some(open)).is_ok_and(|ai| ai.enabled)),
        Arc::new(move || {
            index
                .upgrade()
                .is_some_and(|index| index.indexing().is_some())
        }),
        // A log sink until the renderer's progress event lands (#3540 lane 11).
        Arc::new(|progress| {
            tracing::debug!(
                scope = "Embeddings",
                current = progress.current,
                total = progress.total,
                phase = progress.phase,
                "note embedding progress"
            );
        }),
    );
    session.register_projector(projector);
    if let Err(error) = feed::watch(session, tier.subscribe()) {
        tracing::error!(
            scope = "Embeddings",
            "no projection feed: note edits are embedded at the next open: {error}"
        );
    }
}

/// The file text runner of every open vault (#3542 lane G), reading PDFs through the worker. No
/// worker (see `manage`) leaves the app without file text this run, as without PDFs: the runner's
/// jobs would fail and be read again only a day later. The embedding model stops on every close
/// (`register_on_close`) whether or not the PDF worker exists.
pub fn register(app: &AppHandle<Wry>, session: &Session) {
    register_on_close(app, session);
    let Some(worker) = app.try_state::<Arc<WorkerHandle>>() else {
        return;
    };
    let (languages, index) = (app.clone(), app.clone());
    let file_text = FileText::new(
        session,
        FileTextConfig {
            app_version: app.package_info().version.to_string(),
            pdf: worker.inner().clone(),
            recognize: None,
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
