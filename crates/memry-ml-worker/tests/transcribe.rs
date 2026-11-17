//! The real `memry-ml-worker` binary on the transcription ops. Without the model it refuses a file
//! that is not a WAV before any load, and fails a load of a missing model with the reason. With
//! the pinned `ggml-small.bin` at `MEMRY_WHISPER_MODEL` it hears `fixtures/voice/quick-brown-fox.wav`
//! (16 kHz mono PCM16 with the renderer's 44-byte header) from a non-ASCII dir, and after the
//! worker is killed a new child loads the model again and hears it again.
//! Run: `MEMRY_WHISPER_MODEL=<dir>/ggml-small.bin cargo test -p memry-ml-worker --test transcribe -- --include-ignored`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use memry_ml_worker::{Limits, Supervisor, SystemClock, WorkerError};

fn worker(dir: &Path) -> Supervisor {
    Supervisor::new(
        PathBuf::from(env!("CARGO_BIN_EXE_memry-ml-worker")),
        vec!["--pdfium-dir".into(), dir.join("no-pdfium").into()],
        Limits {
            op_timeout: Duration::from_secs(300),
            ..Limits::default()
        },
        Arc::new(SystemClock),
    )
}

fn fixture() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/voice/quick-brown-fox.wav"
    ))
    .expect("fixture")
}

#[test]
fn a_file_that_is_not_a_wav_is_rejected_before_the_model_loads() {
    let dir = tempfile::tempdir().expect("tempdir");
    let worker = worker(dir.path());
    let missing = dir.path().join("ggml-small.bin");
    assert!(matches!(
        worker.transcribe(&missing, "en", b"not a wav file"),
        Err(WorkerError::Rejected(_))
    ));
}

#[test]
fn a_missing_model_fails_the_load_and_the_worker_lives_on() {
    let dir = tempfile::tempdir().expect("tempdir");
    let worker = worker(dir.path());
    let missing = dir.path().join("ggml-small.bin");
    let outcome = worker.transcribe_load(&missing);
    assert!(
        matches!(outcome, Err(WorkerError::Failed(_))),
        "{outcome:?}"
    );
    assert!(matches!(
        worker.transcribe(&missing, "en", &fixture()),
        Err(WorkerError::Failed(_))
    ));
    assert!(worker.pid().is_some(), "a failed load is not a crash");
}

#[test]
#[ignore = "needs ggml-small.bin at MEMRY_WHISPER_MODEL"]
fn the_pinned_model_hears_the_fixture_and_again_after_a_kill() {
    let model =
        PathBuf::from(std::env::var_os("MEMRY_WHISPER_MODEL").expect("MEMRY_WHISPER_MODEL"));
    let dir = tempfile::Builder::new()
        .prefix("memry-voice-Çağrı-")
        .tempdir()
        .expect("tempdir");
    let copy = dir.path().join("ggml-small.bin");
    std::fs::copy(&model, &copy).expect("copy the model");
    let worker = worker(dir.path());
    let heard = |worker: &Supervisor| {
        let text = worker
            .transcribe(&copy, "en", &fixture())
            .expect("transcribed");
        let words = text.to_lowercase();
        assert!(
            ["quick", "brown", "fox", "lazy", "dog"]
                .iter()
                .all(|word| words.contains(word)),
            "{text}"
        );
    };
    worker.transcribe_load(&copy).expect("loaded");
    heard(&worker);
    let first = worker.pid();
    worker.stop();
    heard(&worker);
    assert_ne!(worker.pid(), first, "a new child loaded the model");
    assert!(matches!(
        worker.transcribe(&copy, "xx", &fixture()),
        Err(WorkerError::Rejected(_))
    ));
}
