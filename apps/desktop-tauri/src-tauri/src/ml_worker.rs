//! The `memry-ml-worker` sidecar, out of process, as two children of the same binary: the PDF
//! worker (pdfium and Tesseract, one `WorkerHandle`, read by the file text runner of the open vault, which stops
//! it on every vault close, #3542 lane G) and the embedding model (`WorkerModel` under the app's
//! `EmbeddingService`, Step 23). Each child starts on its first call and stops on every vault close
//! and in the `stop-utility-processes` shutdown step. The note embedding lane runs on every open
//! vault, and the image embedding lane too when the PDF worker exists (it renders PDF pages).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use memry_desktop::ai::features;
use memry_desktop::embedding::image_projector::ImageEmbeddingProjector;
use memry_desktop::embedding::projector::{self, NoteEmbeddingProjector};
use memry_desktop::embedding::service::{self, EmbeddingService, Timing};
use memry_desktop::embedding::worker::{WorkerModel, exit_telemetry};
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::paths::AppPaths;
use memry_desktop::services::file_text::ocr::OcrEngine;
use memry_desktop::services::file_text::runner::Recognize;
use memry_desktop::services::file_text::service::{FileText, FileTextConfig};
use memry_desktop::services::file_text::{WorkerHandle, WorkerPaths};
use memry_desktop::services::ocr_languages::OcrLanguages;
use memry_desktop::session::Session;
use memry_desktop::session::projection::feed;
use memry_desktop::settings::SettingsService;
use memry_desktop::vault::consumer::VaultTier;
use tauri::{AppHandle, Manager, Runtime, Wry};

use crate::commands::error::{CommandError, ErrorKind};
use crate::events::{AiEmbeddingProgressEvent, broadcast};
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
    let service = EmbeddingService::new(model.clone(), model_progress(app), Timing::default());
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

/// The text model's download and load progress, to every window.
pub fn model_progress<R: Runtime>(app: &AppHandle<R>) -> service::ProgressSink {
    let app = app.clone();
    Arc::new(move |progress| broadcast(&app, AiEmbeddingProgressEvent::from(progress)))
}

/// A note embedding pass's progress, to every window.
pub fn pass_progress<R: Runtime>(app: &AppHandle<R>) -> projector::ProgressSink {
    let app = app.clone();
    Arc::new(move |progress| broadcast(&app, AiEmbeddingProgressEvent::from(progress)))
}

fn worker_paths(app: &AppHandle<Wry>) -> Result<WorkerPaths, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let exe_dir = exe.parent().ok_or("the executable has no directory")?;
    Ok(WorkerPaths::new(exe_dir, &resource_dir(app)?))
}

/// A debug build runs from the checkout, where `scripts/fetch-pdfium.mjs` puts pdfium and the
/// English OCR data is committed; Tauri's resource dir of an unbundled build is the target dir,
/// which holds no resources.
fn resource_dir(app: &AppHandle<Wry>) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        let exe_dir = exe.parent().ok_or("the executable has no directory")?;
        return Ok(debug_resource_dir(
            Path::new(env!("MEMRY_CHECKOUT_DIR")),
            exe_dir,
        ));
    }
    app.path().resource_dir().map_err(|error| error.to_string())
}

/// The checkout's `src-tauri/resources` while that directory exists. A debug binary copied off its
/// build machine (the CI artifact the Windows and Ubuntu VMs run) has no checkout at the path it
/// was built at, and reads `resources/` beside the executable instead, where
/// `winvm.sh install-artifact --with-file-text` puts it.
fn debug_resource_dir(checkout: &Path, exe_dir: &Path) -> PathBuf {
    let in_checkout = checkout.join("src-tauri/resources");
    if in_checkout.is_dir() {
        in_checkout
    } else {
        exe_dir.join("resources")
    }
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

/// The note and image embedding lanes on every open of `session`, fed by `tier`'s facts and
/// deferred while `index` builds. Registered before the first open. Without the managed service
/// (see `manage`) there is no lane and no feed: the feed's events would reach no projector, and
/// the notes stay owed. The note lane checks the vault's `ai.enabled` before every inference, the
/// image lane `ai.enabled` and `ai.imageEmbeddings` before every image, and neither embeds once
/// the vault closes (REVIEW-4548). Without the PDF worker there is no image lane this run: its
/// images stay owed for a run that has one.
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
    let indexing: projector::Indexing = Arc::new(move || {
        index
            .upgrade()
            .is_some_and(|index| index.indexing().is_some())
    });
    let note_settings = settings.clone();
    let projector = NoteEmbeddingProjector::new(
        session,
        service.inner().clone(),
        Arc::new(move |open| features::read(&note_settings, Some(open)).is_ok_and(|ai| ai.enabled)),
        indexing.clone(),
        pass_progress(app),
    );
    session.register_projector(projector);
    match app.try_state::<Arc<WorkerHandle>>() {
        Some(worker) => session.register_projector(ImageEmbeddingProjector::new(
            session,
            service.inner().clone(),
            worker.inner().clone(),
            Arc::new(move |open| {
                features::read(&settings, Some(open))
                    .is_ok_and(|ai| ai.enabled && ai.image_embeddings)
            }),
            indexing,
        )),
        None => tracing::error!(
            scope = "Embeddings",
            "no PDF worker: images are not embedded this run"
        ),
    }
    if let Err(error) = feed::watch(session, tier.subscribe()) {
        tracing::error!(
            scope = "Embeddings",
            "no projection feed: note edits are embedded at the next open: {error}"
        );
    }
}

/// The file text runner of every open vault (#3542 lane G), reading PDFs and OCR through the
/// worker. No worker (see `manage`) leaves the app without file text this run, as without PDFs:
/// the runner's jobs would fail and be read again only a day later. The embedding model stops on every close
/// (`register_on_close`) whether or not the PDF worker exists.
pub fn register(app: &AppHandle<Wry>, session: &Session) {
    register_on_close(app, session);
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
    let Some(languages) = app.try_state::<Arc<OcrLanguages>>() else {
        tracing::error!(
            scope = "MlWorker",
            "no OCR this run: the OCR languages service is not running"
        );
        return None;
    };
    let languages = languages.inner().clone();
    match resource_dir(app) {
        Ok(dir) => Some(OcrEngine::new(worker.clone(), &dir).recognizer(languages)),
        Err(error) => {
            tracing::error!(scope = "MlWorker", "no OCR this run: {error}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_debug_build_reads_the_checkout_resources_while_the_checkout_exists() {
        let checkout = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(checkout.path().join("src-tauri/resources")).unwrap();
        assert_eq!(
            debug_resource_dir(checkout.path(), Path::new("/vm/memry-tauri")),
            checkout.path().join("src-tauri/resources")
        );
    }

    #[test]
    fn a_debug_build_copied_off_its_checkout_reads_resources_beside_the_executable() {
        let gone = tempfile::tempdir()
            .unwrap()
            .path()
            .join("runner/work/memry");
        assert_eq!(
            debug_resource_dir(&gone, Path::new("/vm/memry-tauri")),
            Path::new("/vm/memry-tauri/resources")
        );
    }
}
