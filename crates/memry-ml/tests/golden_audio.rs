//! Parity with Electron's audio embeddings: `packages/contracts/test-vectors/embeddings-audio.json`,
//! written by `tests/golden/generate-audio.mjs` from `audio-embedding.ts` in place and the audio
//! path of `embedding-worker.ts` on transformers.js, holds every 30 s window of seven WAV files.
//! Each file is decoded, split and embedded natively. Electron's windows are 300 s, of which its
//! extractor keeps the first 30 s (Kaan, 2026-11-14; test-vectors README), so the native window
//! that starts each Electron window also records Electron's stored vector and their cosine. Needs the
//! pinned text and audio files in the directory `MEMRY_ML_MODEL_DIR` names; CI runs it on the full
//! tier in the dev profile. Run: `cargo test -p memry-ml --test golden_audio -- --ignored`.

mod common;

use std::path::PathBuf;

use common::audio::wav;
use common::{cosine, floats, ids, vectors};
use memry_ml::{
    EMBEDDING_DIMENSION, EmbeddingEngine, LoadOptions, MlError, ModelGroup, SAMPLE_RATE,
    WINDOW_SAMPLES, audio_windows, decode_wav,
};

/// Electron's window (`EMBEDDING_AUDIO_WINDOW_SECONDS`, 300 s): its vector is the native window
/// that starts at the same sample.
const ELECTRON_WINDOW_SAMPLES: usize = 300 * SAMPLE_RATE as usize;

fn model_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("MEMRY_ML_MODEL_DIR").expect("MEMRY_ML_MODEL_DIR"))
}

/// The text group only: the audio encoder loads with the first window.
fn engine() -> EmbeddingEngine {
    let dir = model_dir();
    memry_ml::verify(&dir, ModelGroup::Text).expect("the pinned text files");
    memry_ml::verify(&dir, ModelGroup::Audio).expect("the pinned audio files");
    EmbeddingEngine::load(&dir, LoadOptions::default()).expect("load")
}

#[test]
#[ignore = "needs the downloaded model in MEMRY_ML_MODEL_DIR"]
fn native_audio_embeddings_match_transformers_js() {
    let vectors = vectors("embeddings-audio.json");
    let min_cosine = vectors["tolerance"]["minCosine"]
        .as_f64()
        .expect("minCosine");
    let max_diff = vectors["tolerance"]["maxComponentDiff"]
        .as_f64()
        .expect("maxComponentDiff");
    assert!(
        min_cosine >= 0.9999 && max_diff <= 0.001,
        "the bounds may not be loosened"
    );
    let mut engine = engine();
    let mut failures = Vec::new();
    let cases = vectors["cases"].as_array().expect("cases");
    assert!(cases.len() >= 7, "{} cases, at least 7", cases.len());
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let samples = decode_wav(&wav(&case["recipe"])).expect(name);
        assert_eq!(
            samples.len() as u64,
            case["decodedSamples"].as_u64().expect("decodedSamples")
        );
        let expected = case["windows"].as_array().expect("windows");
        let windows = audio_windows(&samples);
        if windows.len() != expected.len() {
            failures.push(format!(
                "{name}: {} windows, electron {}",
                windows.len(),
                expected.len()
            ));
            continue;
        }
        for (index, (window, oracle)) in windows.iter().zip(expected).enumerate() {
            let name = format!("{name} / window {index}");
            assert_eq!(
                window.len() as u64,
                oracle["samples"].as_u64().expect("samples")
            );
            let actual_ids = engine.audio_token_ids(window).expect("ids");
            if actual_ids != ids(&oracle["tokenIds"]) {
                failures.push(format!("{name}: {} token ids differ", actual_ids.len()));
            }
            let vector = engine.embed_audio(window).expect("embed");
            let electron = &oracle["electron"];
            let expected = floats(&oracle["embedding"]);
            assert_eq!(expected.len(), EMBEDDING_DIMENSION);
            let similarity = cosine(&vector, &expected);
            let worst = vector
                .iter()
                .zip(&expected)
                .map(|(&a, &b)| (f64::from(a) - f64::from(b)).abs())
                .fold(0.0, f64::max);
            eprintln!("{name}: cosine {similarity:.9}, largest component difference {worst:.2e}");
            if similarity < min_cosine || worst > max_diff {
                failures.push(format!(
                    "{name}: cosine {similarity:.7}, largest difference {worst:.6}"
                ));
            }
            // Read from the window's position, so the file cannot drop a record.
            let starts_electron_window =
                (index * WINDOW_SAMPLES).is_multiple_of(ELECTRON_WINDOW_SAMPLES);
            if starts_electron_window != electron.is_object() {
                failures.push(format!(
                    "{name}: electron record does not match its position"
                ));
                continue;
            }
            if electron.is_object() {
                let measured = electron["cosine"].as_f64().expect("electron.cosine");
                let actual = cosine(&vector, &floats(&electron["embedding"]));
                eprintln!(
                    "{name}: cosine with Electron's vector {actual:.9}, recorded {measured:.9}"
                );
                if actual < min_cosine || (actual - measured).abs() > 1e-4 {
                    failures.push(format!(
                        "{name}: cosine with Electron's vector {actual:.7}, recorded {measured:.7}"
                    ));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The audio encoder loads with the first window: an engine on a folder without the audio group
/// embeds text and reports the missing encoder file on a window, before decoding anything else.
#[test]
#[ignore = "needs the downloaded model in MEMRY_ML_MODEL_DIR"]
fn the_audio_encoder_loads_with_the_first_window() {
    let dir = model_dir();
    // Next to the model so the hard links stay on one volume (the runner temp on Windows).
    let text_only = tempfile::Builder::new()
        .prefix("memry-ml-text-only")
        .tempdir_in(dir.parent().expect("parent"))
        .expect("tempdir");
    for file in ModelGroup::Text.files() {
        let target = text_only.path().join(file.path);
        std::fs::create_dir_all(target.parent().expect("parent")).expect("mkdir");
        std::fs::hard_link(dir.join(file.path), target).expect("link");
    }
    let mut engine = EmbeddingEngine::load(text_only.path(), LoadOptions::default()).expect("load");
    engine
        .embed_text("a text needs no audio encoder")
        .expect("text");
    let error = engine.embed_audio(&[0.0; 16_000]).expect_err("no encoder");
    assert!(
        matches!(error, MlError::ModelMissing(ref path) if path == "onnx/audio_encoder_q4.onnx"),
        "{error}"
    );
}
