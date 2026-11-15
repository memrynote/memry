//! The real `memry-ml-worker` binary on the audio ops. The recordings are the seven WAV files of
//! `packages/contracts/test-vectors/embeddings-audio.json`, rebuilt from their recipes by
//! memry-ml's `tests/common/audio.rs`. Without the model the worker decodes each into the window
//! count Electron's `embedAudio` gives, refuses a file over its cap before reading it, and fails a
//! bad file or a window without the model without dying. With the pinned text and audio files in
//! `MEMRY_ML_MODEL_DIR` (CI's full tier), every window's vector is within the file's bounds. The
//! crash and the timeout of a window are `tests/embed_worker.rs`, on the stub.
//! Run: `cargo test -p memry-ml-worker --test embed_audio -- --include-ignored`.

#[allow(dead_code)]
#[path = "../../memry-ml/tests/common/audio.rs"]
mod audio;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use memry_ml_worker::{
    EMBEDDING_DIMENSION, Limits, MAX_AUDIO_BYTES, Supervisor, SystemClock, WorkerError,
};
use serde_json::Value;

/// The worker on `cache`, the directory that holds `<repo>/` (the transformers.js layout).
fn worker(cache: &Path) -> Supervisor {
    Supervisor::new(
        PathBuf::from(env!("CARGO_BIN_EXE_memry-ml-worker")),
        vec![
            "--pdfium-dir".into(),
            cache.join("no-pdfium").into(),
            "--model-cache".into(),
            cache.into(),
        ],
        Limits::default(),
        Arc::new(SystemClock),
    )
}

fn tempdir(prefix: &str) -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix(prefix)
        .tempdir()
        .expect("tempdir")
}

fn vectors() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/test-vectors/embeddings-audio.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("embeddings-audio.json"))
        .expect("valid JSON")
}

/// Each case's name, its WAV file written under `dir`, and its oracle windows.
fn recordings(vectors: &Value, dir: &Path) -> Vec<(String, PathBuf, Vec<Value>)> {
    let cases = vectors["cases"].as_array().expect("cases");
    assert!(cases.len() >= 7, "{} cases, at least 7", cases.len());
    cases
        .iter()
        .enumerate()
        .map(|(index, case)| {
            let path = dir.join(format!("recording-{index}.wav"));
            std::fs::write(&path, audio::wav(&case["recipe"])).expect("write the recording");
            (
                case["name"].as_str().expect("name").to_owned(),
                path,
                case["windows"].as_array().expect("windows").clone(),
            )
        })
        .collect()
}

#[test]
fn the_worker_splits_each_recording_into_electrons_windows() {
    let dir = tempdir("memry-audio-windows");
    let worker = worker(dir.path());
    for (name, path, windows) in recordings(&vectors(), dir.path()) {
        let recording = worker.open_audio(&path).expect(&name);
        assert_eq!(recording.windows() as usize, windows.len(), "{name}");
        recording.close().expect("close");
    }
}

/// A recording past the cap is refused from its size, before the worker reads a byte of it (the
/// file is sparse, so the test writes none either).
#[test]
fn a_recording_over_the_cap_is_refused_before_it_is_read() {
    let dir = tempdir("memry-audio-cap");
    let path = dir.path().join("long.wav");
    let file = std::fs::File::create(&path).expect("create");
    file.set_len(MAX_AUDIO_BYTES as u64 + 1).expect("sparse");
    let worker = worker(dir.path());
    match worker.open_audio(&path) {
        Err(WorkerError::Failed(message)) => assert_eq!(
            message,
            format!(
                "the recording of {} bytes is over the {MAX_AUDIO_BYTES}-byte cap",
                MAX_AUDIO_BYTES + 1
            )
        ),
        other => panic!("{:?}", other.map(|recording| recording.windows())),
    }
}

/// A file that is not a WAV the decoder takes, a missing file and a window without the model are
/// failures of a healthy worker, never a crash that the app's breaker would count.
#[test]
fn a_bad_recording_or_a_missing_model_fails_without_a_crash() {
    let dir = tempdir("memry-audio-bad");
    let worker = worker(dir.path());
    let not_wav = dir.path().join("memo.wav");
    std::fs::write(&not_wav, b"RIFF\0\0\0\0WAVEjunk").expect("write");
    let bad = worker.open_audio(&not_wav).map(|r| r.windows());
    assert!(matches!(bad, Err(WorkerError::Failed(_))), "{bad:?}");
    let pid = worker.pid().expect("the worker stays up");
    let gone = worker
        .open_audio(&dir.path().join("gone.wav"))
        .map(|r| r.windows());
    assert!(matches!(gone, Err(WorkerError::Failed(_))), "{gone:?}");
    let vectors = vectors();
    let (_, path, _) = recordings(&vectors, dir.path()).swap_remove(0);
    let recording = worker.open_audio(&path).expect("open");
    assert_eq!(
        recording.embed_window(0),
        Err(WorkerError::Failed(
            "model file tokenizer.json is missing or incomplete".into()
        ))
    );
    let past = recording.embed_window(recording.windows());
    assert!(matches!(past, Err(WorkerError::Failed(_))), "{past:?}");
    assert_eq!(worker.pid(), Some(pid), "no failure here is a crash");
}

fn floats(value: &Value) -> Vec<f32> {
    value
        .as_array()
        .expect("an array")
        .iter()
        .map(|v| v.as_f64().expect("a number") as f32)
        .collect()
}

fn cosine(a: &[f32], b: &[f32]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(&x, &y)| f64::from(x) * f64::from(y))
        .sum()
}

/// `tests/golden_audio.rs` through the worker: the same windows, the same bounds.
#[test]
#[ignore = "needs the pinned text and audio files in MEMRY_ML_MODEL_DIR"]
fn audio_embeddings_through_the_real_worker_match_transformers_js() {
    let model = PathBuf::from(std::env::var_os("MEMRY_ML_MODEL_DIR").expect("MEMRY_ML_MODEL_DIR"));
    memry_ml::verify(&model, memry_ml::ModelGroup::Text).expect("the pinned text files");
    memry_ml::verify(&model, memry_ml::ModelGroup::Audio).expect("the pinned audio files");
    let vectors = vectors();
    let min_cosine = vectors["tolerance"]["minCosine"].as_f64().expect("bound");
    let max_diff = vectors["tolerance"]["maxComponentDiff"]
        .as_f64()
        .expect("bound");
    assert!(
        min_cosine >= 0.9999 && max_diff <= 0.001,
        "the bounds may not be loosened"
    );
    // `MEMRY_ML_MODEL_DIR` is `<cache>/onnx-community/embeddinggemma-2-ONNX`.
    let worker = worker(model.ancestors().nth(2).expect("the cache above the repo"));
    let files = tempdir("memry-audio-golden");
    let mut failures = Vec::new();
    for (name, path, windows) in recordings(&vectors, files.path()) {
        let recording = worker.open_audio(&path).expect(&name);
        assert_eq!(recording.windows() as usize, windows.len(), "{name}");
        for (index, oracle) in windows.iter().enumerate() {
            let actual = recording.embed_window(index as u32).expect("embed");
            let expected = floats(&oracle["embedding"]);
            assert_eq!(expected.len(), EMBEDDING_DIMENSION);
            let similarity = cosine(&actual, &expected);
            let worst = actual
                .iter()
                .zip(&expected)
                .map(|(&a, &b)| (f64::from(a) - f64::from(b)).abs())
                .fold(0.0, f64::max);
            if similarity < min_cosine || worst > max_diff {
                failures.push(format!(
                    "{name} / window {index}: cosine {similarity:.7}, largest difference {worst:.6}"
                ));
            }
        }
        recording.close().expect("close");
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
