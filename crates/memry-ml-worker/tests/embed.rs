//! The real `memry-ml-worker` binary on the embedding ops. Without the model it answers the
//! manifest from memry-ml's pins and fails an embed with the missing file. With the pinned text
//! files in `MEMRY_ML_MODEL_DIR` (CI's full tier), every text of
//! `packages/contracts/test-vectors/embeddings-text.json` matches its transformers.js vector within
//! `tests/golden_text.rs`'s bounds (cosine and largest component difference), and after the worker
//! is killed the next embed loads the model in a new child and is within them again. The kill of an embed in flight is
//! `tests/embed_worker.rs`, on the stub, which can hold an op open.
//! Run: `cargo test -p memry-ml-worker --test embed -- --include-ignored`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use memry_ml_worker::{Limits, ModelGroup, Supervisor, SystemClock, WorkerError};
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

#[test]
fn the_manifest_is_memry_mls_pins() {
    let dir = tempfile::Builder::new()
        .prefix("memry-embed-manifest")
        .tempdir()
        .expect("tempdir");
    let worker = worker(dir.path());
    for (group, pinned) in [
        (ModelGroup::Text, memry_ml::ModelGroup::Text),
        (ModelGroup::Vision, memry_ml::ModelGroup::Vision),
        (ModelGroup::Audio, memry_ml::ModelGroup::Audio),
    ] {
        let manifest = worker.model_manifest(group).expect("manifest");
        assert_eq!(manifest.repo, memry_ml::MODEL_REPO);
        assert_eq!(manifest.revision, memry_ml::MODEL_REVISION);
        let files: Vec<_> = manifest
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.size, f.sha256.as_str()))
            .collect();
        let expected: Vec<_> = pinned
            .files()
            .iter()
            .map(|f| (f.path, f.size, f.sha256))
            .collect();
        assert_eq!(files, expected);
    }
}

#[test]
fn an_embed_without_the_model_fails_with_the_missing_file() {
    let dir = tempfile::Builder::new()
        .prefix("memry-embed-missing")
        .tempdir()
        .expect("tempdir");
    let worker = worker(dir.path());
    assert_eq!(
        worker.embed_text("a note about the sea"),
        Err(WorkerError::Failed(
            "model file tokenizer.json is missing or incomplete".into()
        ))
    );
    let pid = worker.pid().expect("the worker stays up");
    assert!(worker.embed_load().is_err());
    assert_eq!(worker.pid(), Some(pid), "a failed load is not a crash");
}

/// The 31 texts of `embeddings-text.json` and `tests/golden_text.rs`'s bounds on them.
struct Golden {
    texts: Vec<(String, String, Vec<f32>)>,
    min_cosine: f64,
    max_component_diff: f64,
}

fn golden() -> Golden {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/test-vectors/embeddings-text.json");
    let vectors: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("embeddings-text.json"))
            .expect("valid JSON");
    let texts: Vec<_> = vectors["texts"]
        .as_array()
        .expect("texts")
        .iter()
        .map(|case| {
            let embedding = case["embedding"]
                .as_array()
                .expect("embedding")
                .iter()
                .map(|v| v.as_f64().expect("a number") as f32)
                .collect();
            (
                case["name"].as_str().expect("name").to_owned(),
                case["text"].as_str().expect("text").to_owned(),
                embedding,
            )
        })
        .collect();
    assert_eq!(texts.len(), 31);
    let golden = Golden {
        texts,
        min_cosine: vectors["tolerance"]["minCosine"].as_f64().expect("bound"),
        max_component_diff: vectors["tolerance"]["maxComponentDiff"]
            .as_f64()
            .expect("bound"),
    };
    assert!(golden.min_cosine >= 0.9999 && golden.max_component_diff <= 0.001);
    golden
}

impl Golden {
    /// Why `actual` is outside the bounds of `expected`, if it is.
    fn miss(&self, name: &str, actual: &[f32], expected: &[f32]) -> Option<String> {
        let similarity = cosine(actual, expected);
        let worst = actual
            .iter()
            .zip(expected)
            .map(|(&a, &b)| (f64::from(a) - f64::from(b)).abs())
            .fold(0.0, f64::max);
        (actual.len() != expected.len()
            || similarity < self.min_cosine
            || worst > self.max_component_diff)
            .then(|| {
                format!(
                    "{name}: {} values, cosine {similarity:.7}, largest component difference {worst:.6}",
                    actual.len()
                )
            })
    }
}

fn kill(pid: u32) {
    #[cfg(unix)]
    {
        // SAFETY: plain FFI call on the child this test's supervisor started.
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) }, 0);
    }
    #[cfg(windows)]
    {
        let status = std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .status()
            .expect("taskkill");
        assert!(status.success());
    }
}

fn cosine(a: &[f32], b: &[f32]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(&x, &y)| f64::from(x) * f64::from(y))
        .sum()
}

#[test]
#[ignore = "needs the pinned text files in MEMRY_ML_MODEL_DIR"]
fn an_embed_through_the_real_worker_matches_transformers_js_and_survives_a_kill() {
    let dir = PathBuf::from(std::env::var_os("MEMRY_ML_MODEL_DIR").expect("MEMRY_ML_MODEL_DIR"));
    memry_ml::verify(&dir, memry_ml::ModelGroup::Text).expect("the pinned text files");
    let golden = golden();
    // `MEMRY_ML_MODEL_DIR` is `<cache>/onnx-community/embeddinggemma-2-ONNX`.
    let cache = dir.ancestors().nth(2).expect("the cache above the repo");
    let worker = worker(cache);
    worker.embed_load().expect("load");
    let mut failures = Vec::new();
    for (name, text, expected) in &golden.texts {
        let actual = worker.embed_text(text).expect("embed");
        failures.extend(golden.miss(name, &actual, expected));
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));

    let killed = worker.pid().expect("running");
    kill(killed);
    // A call racing the reader's discovery of the exit would reach the dead child and fail with
    // it, so the test waits until the supervisor has dropped it.
    let deadline = Instant::now() + Duration::from_secs(30);
    while worker.pid() == Some(killed) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let (name, text, expected) = &golden.texts[0];
    let again = worker
        .embed_text(text)
        .expect("a new child loads the model");
    assert_ne!(worker.pid(), Some(killed));
    assert_eq!(golden.miss(name, &again, expected), None);
}
