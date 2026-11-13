//! Parity with transformers.js: `packages/contracts/test-vectors/embeddings-text.json`, written by
//! `tests/golden/generate.mjs` from Electron's text path, holds the token ids and the stored vector
//! of 31 texts, 2 texts Electron embeds with a lone surrogate, and 12 query and document pairs.
//! Needs the pinned text files in the directory `MEMRY_ML_MODEL_DIR` names; CI runs it on the full
//! tier in the dev profile. Run: `cargo test -p memry-ml --test golden_text -- --ignored`.

use std::path::{Path, PathBuf};

use memry_ml::{EMBEDDING_DIMENSION, Embedding, EmbeddingEngine, LoadOptions, ModelGroup};
use serde_json::Value;

fn vectors() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/test-vectors/embeddings-text.json");
    serde_json::from_str(&std::fs::read_to_string(&path).expect("embeddings-text.json"))
        .expect("valid JSON")
}

fn engine() -> EmbeddingEngine {
    let dir = PathBuf::from(std::env::var_os("MEMRY_ML_MODEL_DIR").expect("MEMRY_ML_MODEL_DIR"));
    memry_ml::verify(&dir, ModelGroup::Text).expect("the pinned text files");
    EmbeddingEngine::load(&dir, LoadOptions::default()).expect("load")
}

fn ids(value: &Value) -> Vec<i64> {
    value
        .as_array()
        .expect("tokenIds")
        .iter()
        .map(|id| id.as_i64().expect("an integer id"))
        .collect()
}

fn embedding(value: &Value) -> Vec<f32> {
    let values: Vec<f32> = value
        .as_array()
        .expect("embedding")
        .iter()
        .map(|v| v.as_f64().expect("a number") as f32)
        .collect();
    assert_eq!(values.len(), EMBEDDING_DIMENSION);
    values
}

fn cosine(a: &[f32], b: &[f32]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(&x, &y)| f64::from(x) * f64::from(y))
        .sum()
}

struct Tolerance {
    min_cosine: f64,
    max_component_diff: f64,
}

/// The file's bounds, which may not be looser than #3540's acceptance.
fn tolerance(vectors: &Value) -> Tolerance {
    let tolerance = Tolerance {
        min_cosine: vectors["tolerance"]["minCosine"]
            .as_f64()
            .expect("minCosine"),
        max_component_diff: vectors["tolerance"]["maxComponentDiff"]
            .as_f64()
            .expect("maxComponentDiff"),
    };
    assert!(tolerance.min_cosine >= 0.9999 && tolerance.max_component_diff <= 0.001);
    tolerance
}

/// Embeds `text` and compares its ids and vector with the oracle's. Returns the vector and, on a
/// mismatch, the reason, so every fixture is checked before the test fails.
fn check(
    engine: &mut EmbeddingEngine,
    tolerance: &Tolerance,
    name: &str,
    case: &Value,
    failures: &mut Vec<String>,
) -> Embedding {
    let text = case["text"].as_str().expect("text");
    let expected_ids = ids(&case["tokenIds"]);
    let actual_ids = engine.token_ids(text).expect("tokenize");
    if actual_ids != expected_ids {
        let at = actual_ids
            .iter()
            .zip(&expected_ids)
            .position(|(a, b)| a != b)
            .unwrap_or(actual_ids.len().min(expected_ids.len()));
        failures.push(format!(
            "{name}: token ids differ at {at} (rust {} ids {:?}..{:?}, transformers.js {} ids {:?}..{:?})",
            actual_ids.len(),
            actual_ids.get(at..(at + 3).min(actual_ids.len())),
            actual_ids.last(),
            expected_ids.len(),
            expected_ids.get(at..(at + 3).min(expected_ids.len())),
            expected_ids.last(),
        ));
    }
    let expected = embedding(&case["embedding"]);
    let actual = engine.embed_text(text).expect("embed");
    let similarity = cosine(&actual, &expected);
    let worst = actual
        .iter()
        .zip(&expected)
        .map(|(&a, &b)| (f64::from(a) - f64::from(b)).abs())
        .fold(0.0, f64::max);
    eprintln!("{name}: cosine {similarity:.9}, largest component difference {worst:.2e}");
    if similarity < tolerance.min_cosine || worst > tolerance.max_component_diff {
        failures.push(format!(
            "{name}: cosine {similarity:.7}, largest component difference {worst:.6}"
        ));
    }
    actual
}

#[test]
#[ignore = "needs the downloaded model in MEMRY_ML_MODEL_DIR"]
fn native_text_embeddings_match_transformers_js() {
    let vectors = vectors();
    let tolerance = tolerance(&vectors);
    let texts = vectors["texts"].as_array().expect("texts");
    assert_eq!(texts.len(), 31);

    let mut engine = engine();
    let mut failures = Vec::new();
    for case in texts {
        let name = case["name"].as_str().expect("name");
        check(&mut engine, &tolerance, name, case, &mut failures);
    }

    // Known divergence (test-vectors README): Electron embeds a lone surrogate as the three
    // byte-fallback tokens of EF BF BD; a Rust string holds U+FFFD, one token. The native vector
    // matches transformers.js on the U+FFFD form within the bounds, and its cosine with Electron's
    // vector stays at the measured gap, so a change on either side fails.
    let lone = vectors["loneSurrogates"]
        .as_array()
        .expect("loneSurrogates");
    assert_eq!(lone.len(), 2);
    for case in lone {
        let name = case["name"].as_str().expect("name");
        let actual = check(&mut engine, &tolerance, name, case, &mut failures);
        let measured = case["electron"]["cosine"]
            .as_f64()
            .expect("electron.cosine");
        let electron = cosine(&actual, &embedding(&case["electron"]["embedding"]));
        eprintln!("{name}: cosine with Electron's vector {electron:.9}, recorded {measured:.9}");
        if (electron - measured).abs() > 1e-4 {
            failures.push(format!(
                "{name}: cosine with Electron's lone-surrogate vector {electron:.7}, recorded {measured:.7}"
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
#[ignore = "needs the downloaded model in MEMRY_ML_MODEL_DIR"]
fn native_vectors_rank_documents_as_transformers_js() {
    let vectors = vectors();
    let tolerance = tolerance(&vectors);
    let queries = vectors["ranking"]["queries"].as_array().expect("queries");
    let documents = vectors["ranking"]["documents"]
        .as_array()
        .expect("documents");
    assert_eq!((queries.len(), documents.len()), (12, 12));

    let mut engine = engine();
    let mut failures = Vec::new();
    let documents: Vec<Embedding> = documents
        .iter()
        .enumerate()
        .map(|(i, case)| {
            check(
                &mut engine,
                &tolerance,
                &format!("document {i}"),
                case,
                &mut failures,
            )
        })
        .collect();
    for (i, case) in queries.iter().enumerate() {
        let query = check(
            &mut engine,
            &tolerance,
            &format!("query {i}"),
            case,
            &mut failures,
        );
        let scores: Vec<f64> = documents.iter().map(|d| cosine(&query, d)).collect();
        let mut order: Vec<usize> = (0..scores.len()).collect();
        order.sort_by(|&a, &b| scores[b].total_cmp(&scores[a]));
        let expected: Vec<usize> = case["order"]
            .as_array()
            .expect("order")
            .iter()
            .map(|v| v.as_u64().expect("an index") as usize)
            .collect();
        if order != expected {
            failures.push(format!(
                "query {i}: order {order:?}, transformers.js {expected:?}"
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
