//! Parity with Electron's audio embeddings: `packages/contracts/test-vectors/embeddings-audio.json`,
//! written by `tests/golden/generate-audio.mjs` from `audio-embedding.ts` in place and the audio
//! path of `embedding-worker.ts` on transformers.js, holds every window Electron embeds for eight
//! WAV files. Each file is decoded, split and embedded natively. Needs the pinned text and audio
//! files in the directory `MEMRY_ML_MODEL_DIR` names; CI runs it on the full tier in the dev
//! profile. Run: `cargo test -p memry-ml --test golden_audio -- --ignored`.

mod common;

use std::path::PathBuf;

use common::{floats, vectors, wav};
use memry_ml::{
    EMBEDDING_DIMENSION, EmbeddingEngine, LoadOptions, ModelGroup, audio_windows, decode_wav,
};
use serde_json::Value;

fn engine() -> EmbeddingEngine {
    let dir = PathBuf::from(std::env::var_os("MEMRY_ML_MODEL_DIR").expect("MEMRY_ML_MODEL_DIR"));
    memry_ml::verify(&dir, ModelGroup::Text).expect("the pinned text files");
    memry_ml::verify(&dir, ModelGroup::Audio).expect("the pinned audio files");
    let mut engine = EmbeddingEngine::load(&dir, LoadOptions::default()).expect("load");
    engine.load_audio(&dir).expect("load the audio encoder");
    engine
}

fn ids(value: &Value) -> Vec<i64> {
    value
        .as_array()
        .expect("tokenIds")
        .iter()
        .map(|id| id.as_i64().expect("an integer id"))
        .collect()
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
    for case in vectors["cases"].as_array().expect("cases") {
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
            let oracle = floats(&oracle["embedding"]);
            assert_eq!(oracle.len(), EMBEDDING_DIMENSION);
            let cosine: f64 = vector
                .iter()
                .zip(&oracle)
                .map(|(&a, &b)| f64::from(a) * f64::from(b))
                .sum();
            let worst = vector
                .iter()
                .zip(&oracle)
                .map(|(&a, &b)| (f64::from(a) - f64::from(b)).abs())
                .fold(0.0, f64::max);
            eprintln!("{name}: cosine {cosine:.9}, largest component difference {worst:.2e}");
            if cosine < min_cosine || worst > max_diff {
                failures.push(format!(
                    "{name}: cosine {cosine:.7}, largest difference {worst:.6}"
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Without `load_audio`, a window is refused with the worker's message instead of loading the
/// encoder behind the caller's back.
#[test]
#[ignore = "needs the downloaded model in MEMRY_ML_MODEL_DIR"]
fn a_window_before_load_audio_is_refused() {
    let dir = PathBuf::from(std::env::var_os("MEMRY_ML_MODEL_DIR").expect("MEMRY_ML_MODEL_DIR"));
    let mut engine = EmbeddingEngine::load(&dir, LoadOptions::default()).expect("load");
    let error = engine.embed_audio(&[0.0; 16_000]).expect_err("not loaded");
    assert_eq!(
        error.to_string(),
        "loading the model failed: Audio encoder is not loaded"
    );
}
