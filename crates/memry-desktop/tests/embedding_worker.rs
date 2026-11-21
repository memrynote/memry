//! `EmbeddingService` over the app's `WorkerModel` and a real child process, the stub worker
//! (`memry-ml-worker/src/bin/stub.rs`, built here as `memry-desktop-worker-stub`), which aborts on
//! a text that starts with `crash`. A child that dies under an embed counts as Electron's
//! `failProcess` does with an embed in flight (`apps/desktop/src/main/lib/embeddings.ts:820-835`):
//! the model is no longer loaded, and five in a row stop the model for the session (#3407). A
//! recording whose worker dies under a window feeds only the audio encoder's breaker
//! (`recordEncoderFailure('audio')`, embeddings.ts:830-832): text indexing goes on.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use memry_desktop::embedding::MAX_CONSECUTIVE_FAILURES;
use memry_desktop::embedding::download::Abort;
use memry_desktop::embedding::service::{EmbeddingService, ModelLoader, Timing};
use memry_desktop::embedding::worker::WorkerModel;
use memry_desktop::services::file_text::WorkerPaths;
use memry_ml_worker::MODEL_REPO;
use tokio_util::sync::CancellationToken;

/// The service over the stub, its model cache holding the stub's one pinned file.
fn stub_service(
    runtime: &tokio::runtime::Runtime,
    cache: &tempfile::TempDir,
) -> (Arc<EmbeddingService>, Arc<WorkerModel>) {
    // The shell installs this at boot (`install_crypto_provider`); `ModelSource` needs it.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut model_dir = cache.path().to_path_buf();
    model_dir.extend(MODEL_REPO.split('/'));
    std::fs::create_dir_all(&model_dir).expect("model dir");
    // The stub's manifest pins one empty file, so no download runs.
    std::fs::write(model_dir.join("config.json"), b"").expect("pinned file");

    let paths = WorkerPaths {
        program: PathBuf::from(env!("CARGO_BIN_EXE_memry-desktop-worker-stub")),
        pdfium_dir: cache.path().join("pdfium"),
    };
    let model = WorkerModel::new(
        &paths,
        cache.path().to_path_buf(),
        runtime.handle().clone(),
        Arc::new(|_, _| {}),
    );
    let service = EmbeddingService::new(
        model.clone(),
        Arc::new(|_| {}),
        Timing {
            retry_base: Duration::ZERO,
            ..Timing::default()
        },
    );
    (service, model)
}

#[test]
fn a_worker_that_dies_under_each_embed_stops_the_model_for_the_session() {
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    let cache = tempfile::tempdir().expect("cache");
    let (service, model) = stub_service(&runtime, &cache);

    for attempt in 0..MAX_CONSECUTIVE_FAILURES {
        assert_eq!(
            service.embed("crash the embedding worker"),
            None,
            "attempt {attempt}"
        );
        let status = service.status();
        assert!(
            !status.loaded,
            "attempt {attempt}: the model died with its child"
        );
        assert!(status.error.is_some(), "attempt {attempt}");
    }
    assert!(
        !service.load(),
        "five crashes in a row stop loads until the user resets the failure"
    );
    assert_eq!(service.embed("a note long enough to embed"), None);

    service.reset_failure();
    let vector = service
        .embed("a note long enough to embed")
        .expect("a fresh child answers");
    assert_eq!(vector.len(), 256);
    assert!(service.status().loaded);
    model.stop();
}

/// The stub opens any path as three windows and aborts on window 1 of `crash.wav`. A hostile
/// recording that kills the worker every time never stops text indexing.
#[test]
fn a_worker_that_dies_under_each_recording_never_stops_text() {
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    let cache = tempfile::tempdir().expect("cache");
    let (service, model) = stub_service(&runtime, &cache);
    let memo = cache.path().join("memo.wav");

    assert_eq!(
        service.embed_audio(&cache.path().join("short.wav")),
        None,
        "a recording under one second has no window"
    );
    let vectors = service.embed_audio(&memo).expect("three windows");
    assert_eq!(vectors.len(), 3);
    assert!(vectors.iter().all(|vector| vector.len() == 256));

    for attempt in 0..MAX_CONSECUTIVE_FAILURES {
        assert_eq!(
            service.embed_audio(&cache.path().join("crash.wav")),
            None,
            "attempt {attempt}"
        );
        let status = service.status();
        assert!(
            !status.loaded,
            "attempt {attempt}: the model died with its child"
        );
        assert!(status.error.is_some(), "attempt {attempt}");
    }
    assert!(service.load(), "audio crashes never stop text loads");
    let vector = service
        .embed("a note long enough to embed")
        .expect("text still embeds");
    assert_eq!(vector.len(), 256);
    assert_eq!(service.embed_audio(&memo).map(|v| v.len()), Some(3));
    model.stop();
}

/// A worker that answers NaNs to a text breaks the protocol: the model is dropped with the child
/// and the failure counts toward the breaker (`failProcess`, embeddings.ts:820-835).
#[test]
fn a_worker_that_answers_nans_drops_the_model_and_counts_the_failure() {
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    let cache = tempfile::tempdir().expect("cache");
    let (service, model) = stub_service(&runtime, &cache);

    for attempt in 0..MAX_CONSECUTIVE_FAILURES {
        assert_eq!(
            service.embed("nan, a note long enough to embed"),
            None,
            "attempt {attempt}"
        );
        let status = service.status();
        assert!(!status.loaded, "attempt {attempt}: the model was dropped");
        assert!(status.error.is_some(), "attempt {attempt}");
    }
    assert!(
        !service.load(),
        "five protocol failures in a row stop loads until the user resets the failure"
    );
    model.stop();
}

/// The recording handles one `WorkerModel` hands out never repeat, across the engines it loads:
/// an engine reloaded after a text crash must not reuse a handle a caller still holds.
#[test]
fn recording_handles_never_repeat_across_reloaded_engines() {
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    let cache = tempfile::tempdir().expect("cache");
    let (_, model) = stub_service(&runtime, &cache);
    let abort = Abort {
        cancel: CancellationToken::new(),
        deadline: Instant::now() + Duration::from_secs(60),
    };
    let memo = cache.path().join("memo.wav");

    let mut first = model.load(&abort, &|_| {}).expect("first engine");
    let held = first.open_audio(&memo).expect("opened").recording;
    let mut second = model.load(&abort, &|_| {}).expect("reloaded engine");
    let reopened = second.open_audio(&memo).expect("opened").recording;
    assert_ne!(held, reopened);
    model.stop();
}

/// A recording the worker dies on at open, again and again, never pauses the worker for text:
/// the audio encoder's breaker bounds those crashes, so the supervisor's crash bound leaves them
/// out (`recordEncoderFailure('audio')`, embeddings.ts:830-832).
#[test]
fn recordings_that_kill_the_worker_at_open_never_pause_it_for_text() {
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    let cache = tempfile::tempdir().expect("cache");
    let (service, model) = stub_service(&runtime, &cache);
    let hostile = cache.path().join("crash-open.wav");

    for attempt in 0..MAX_CONSECUTIVE_FAILURES {
        assert_eq!(service.embed_audio(&hostile), None, "attempt {attempt}");
    }
    let vector = service
        .embed("a note long enough to embed")
        .expect("text still embeds");
    assert_eq!(vector.len(), 256);
    model.stop();
}
