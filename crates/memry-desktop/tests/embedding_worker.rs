//! `EmbeddingService` over the app's `WorkerModel` and a real child process, the stub worker
//! (`memry-ml-worker/src/bin/stub.rs`, built here as `memry-desktop-worker-stub`), which aborts on
//! a text that starts with `crash`. A child that dies under an embed counts as Electron's
//! `failProcess` does with an embed in flight (`apps/desktop/src/main/lib/embeddings.ts:820-835`):
//! the model is no longer loaded, and five in a row stop the model for the session (#3407). A
//! recording whose worker dies under a window counts the same way.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use memry_desktop::embedding::MAX_CONSECUTIVE_FAILURES;
use memry_desktop::embedding::service::{EmbeddingService, Timing};
use memry_desktop::embedding::worker::WorkerModel;
use memry_desktop::services::file_text::WorkerPaths;
use memry_ml_worker::MODEL_REPO;

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

/// The stub opens any path as three windows and aborts on window 1 of `crash.wav`.
#[test]
fn a_worker_that_dies_under_each_recording_stops_the_model_for_the_session() {
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
    assert!(
        !service.load(),
        "five crashes in a row stop loads until the user resets the failure"
    );
    assert_eq!(service.embed_audio(&memo), None);
    assert_eq!(service.embed("a note long enough to embed"), None);

    service.reset_failure();
    assert_eq!(service.embed_audio(&memo).map(|v| v.len()), Some(3));
    assert!(service.status().loaded);
    model.stop();
}
