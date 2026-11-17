//! The local Whisper engine (`services::voice::engine::LocalEngine`) over a real child process,
//! the stub worker (`memry-ml-worker/src/bin/stub.rs`, built here as `memry-desktop-worker-stub`),
//! whose transcription language picks its behaviour. The model status turns `loaded` with the
//! first transcription, as Electron's `VoiceModelBridge` does on the worker's `ready` progress
//! (`apps/desktop/src/main/inbox/voice-model.ts:280-296`), and back when the child that loaded it
//! ends: a crash (`failProcess`), a timeout, the idle exit (`IDLE_SHUTDOWN_MS`) and a stop.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_desktop::embedding::service::{ModelProgress, Phase};
use memry_desktop::services::file_text::WorkerPaths;
use memry_desktop::services::voice::engine::{LocalEngine, limits};
use memry_desktop::services::voice::model::VoiceModel;
use memry_ml_worker::{Limits, WorkerError};

fn engine(model: &Path, limits: Limits) -> Arc<LocalEngine> {
    let paths = WorkerPaths {
        program: PathBuf::from(env!("CARGO_BIN_EXE_memry-desktop-worker-stub")),
        pdfium_dir: model.with_file_name("pdfium"),
    };
    LocalEngine::new(&paths, model.to_path_buf(), limits)
}

/// The settings' model, which reads `downloaded` from `dir` and serves the status.
fn voice_model(dir: &Path) -> VoiceModel {
    // The shell installs this at boot (`install_crypto_provider`); `ModelSource` needs it.
    let _ = rustls::crypto::ring::default_provider().install_default();
    VoiceModel::new(dir)
}

type Seen = Arc<Mutex<Vec<Phase>>>;

fn recorder() -> (Seen, impl Fn(ModelProgress) + Sync) {
    let seen = Seen::default();
    let sink = seen.clone();
    (seen, move |event: ModelProgress| {
        sink.lock().unwrap().push(event.phase)
    })
}

#[test]
fn the_first_transcription_loads_the_model_and_the_status_says_loaded() {
    let dir = tempfile::tempdir().unwrap();
    let model = voice_model(dir.path());
    let engine = engine(&model.model_path(), limits());
    assert!(!model.status(&engine).loaded);

    let (seen, sink) = recorder();
    let first = engine.transcribe(b"RIFF", "en", &sink).unwrap();
    let status = model.status(&engine);
    assert!(status.loaded && !status.loading, "{status:?}");
    assert_eq!(status.error, None);
    assert_eq!(*seen.lock().unwrap(), [Phase::Loading, Phase::Ready]);

    // The loaded child answers the next one with no second load.
    assert_eq!(engine.transcribe(b"RIFF", "en", &sink).unwrap(), first);
    assert_eq!(seen.lock().unwrap().len(), 2);

    engine.stop();
    assert!(!model.status(&engine).loaded);
}

#[test]
fn a_crash_under_a_transcription_unloads_the_model_and_the_next_call_loads_it_again() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(&dir.path().join("ggml-small.bin"), limits());
    let (seen, sink) = recorder();
    engine.transcribe(b"RIFF", "en", &sink).unwrap();

    let crashed = engine.transcribe(b"RIFF", "crash", &sink);
    assert!(
        matches!(crashed, Err(WorkerError::Exited(_))),
        "{crashed:?}"
    );
    assert!(!engine.loaded());
    assert!(engine.error().is_some());

    engine.transcribe(b"RIFF", "en", &sink).unwrap();
    assert!(engine.loaded());
    assert_eq!(engine.error(), None);
    assert_eq!(
        *seen.lock().unwrap(),
        [Phase::Loading, Phase::Ready, Phase::Loading, Phase::Ready]
    );
}

#[test]
fn a_hung_transcription_is_killed_at_the_request_timeout() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(
        &dir.path().join("ggml-small.bin"),
        Limits {
            op_timeout: Duration::from_millis(300),
            ..limits()
        },
    );
    let (_, sink) = recorder();
    assert_eq!(
        engine.transcribe(b"RIFF", "hang", &sink),
        Err(WorkerError::Timeout { op: "transcribe" })
    );
    assert!(!engine.loaded());
}

#[test]
fn a_model_that_does_not_load_reports_the_error() {
    let dir = tempfile::tempdir().unwrap();
    let model = voice_model(dir.path());
    let engine = engine(&dir.path().join("missing.bin"), limits());
    let (seen, sink) = recorder();
    assert!(matches!(
        engine.transcribe(b"RIFF", "en", &sink),
        Err(WorkerError::Failed(_))
    ));
    let status = model.status(&engine);
    assert!(!status.loaded && !status.loading);
    assert_eq!(
        status.error.as_deref(),
        Some("failed to load the Whisper model")
    );
    assert_eq!(*seen.lock().unwrap(), [Phase::Loading, Phase::Error]);
}

#[test]
fn the_idle_child_exits_and_the_model_is_no_longer_loaded() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(
        &dir.path().join("ggml-small.bin"),
        Limits {
            idle_exit: Duration::from_millis(100),
            ..limits()
        },
    );
    let (_, sink) = recorder();
    engine.transcribe(b"RIFF", "en", &sink).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while engine.loaded() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!engine.loaded(), "the idle child exited");
}
