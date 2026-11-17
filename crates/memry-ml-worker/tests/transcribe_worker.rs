//! The transcription calls against the stub worker, which can hold an op open or abort under it:
//! a hung transcription is killed at the op timeout (Electron's 5 min `REQUEST_TIMEOUT_MS`, short
//! here), a crash fails only its call, and a recording or a language over its cap never starts a
//! child. Time is never asserted from above.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use memry_ml_worker::{
    Limits, MAX_LANGUAGE_BYTES, MAX_TRANSCRIBE_BYTES, Supervisor, SystemClock, WorkerError,
};

fn supervisor(limits: Limits) -> Supervisor {
    Supervisor::new(
        PathBuf::from(env!("CARGO_BIN_EXE_memry-ml-worker-stub")),
        Vec::new(),
        limits,
        Arc::new(SystemClock),
    )
}

fn transcribe(worker: &Supervisor, language: &str) -> Result<String, WorkerError> {
    worker.transcribe(Path::new("/models/ggml-small.bin"), language, b"RIFF")
}

#[test]
fn a_hung_transcription_is_killed_at_the_op_timeout_and_the_next_restarts() {
    let worker = supervisor(Limits {
        op_timeout: Duration::from_millis(300),
        ..Limits::default()
    });
    let first = transcribe(&worker, "en").expect("answered");
    assert_eq!(
        transcribe(&worker, "hang"),
        Err(WorkerError::Timeout { op: "transcribe" })
    );
    assert_eq!(worker.pid(), None, "the hung child was killed");
    let next = transcribe(&worker, "en").expect("a new child answered");
    assert_ne!(next, first);
}

#[test]
fn a_crash_under_a_transcription_fails_only_that_call() {
    let worker = supervisor(Limits::default());
    assert!(matches!(
        transcribe(&worker, "crash"),
        Err(WorkerError::Exited(_))
    ));
    assert_eq!(worker.pid(), None);
    assert!(transcribe(&worker, "en").is_ok());
}

#[test]
fn a_rejected_recording_leaves_the_worker_running() {
    let worker = supervisor(Limits::default());
    worker
        .transcribe_load(Path::new("/models/ggml-small.bin"))
        .expect("loaded");
    let pid = worker.pid();
    assert!(matches!(
        transcribe(&worker, "xx"),
        Err(WorkerError::Rejected(_))
    ));
    assert_eq!(worker.pid(), pid);
}

#[test]
fn a_recording_over_the_cap_never_reaches_the_worker() {
    let worker = supervisor(Limits::default());
    let wav = vec![0; MAX_TRANSCRIBE_BYTES + 1];
    let outcome = worker.transcribe(Path::new("/models/ggml-small.bin"), "en", &wav);
    assert!(
        matches!(outcome, Err(WorkerError::Failed(_))),
        "{outcome:?}"
    );
    assert_eq!(worker.pid(), None, "no child was started for it");
}

#[test]
fn a_language_over_the_cap_never_reaches_the_worker() {
    let worker = supervisor(Limits::default());
    let outcome = transcribe(&worker, &"a".repeat(MAX_LANGUAGE_BYTES + 1));
    assert!(
        matches!(outcome, Err(WorkerError::Rejected(_))),
        "{outcome:?}"
    );
    assert_eq!(worker.pid(), None, "no child was started for it");
}
