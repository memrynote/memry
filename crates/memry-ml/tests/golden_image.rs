//! Parity with transformers.js: `packages/contracts/test-vectors/embeddings-image.json`, written by
//! `tests/golden/generate-image.mjs` from Electron's `embedImage`, holds the token ids and the
//! stored vector of photos, an OCR page with and without its text and small lossless images.
//! Token ids are exact. PNG, WebP and GIF vectors meet the text bounds; JPEG and ICC-tagged images
//! decode differently (test-vectors README) and meet the file's measured `divergentMinCosine`.
//! Needs the pinned text and vision files in `MEMRY_ML_MODEL_DIR`; CI runs it on the full tier.
//! Run: `cargo test -p memry-ml --test golden_image -- --ignored`.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use memry_ml::{EMBEDDING_DIMENSION, EmbeddingEngine, LoadOptions, ModelGroup, image_prep};
use serde_json::Value;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read_json(name: &str) -> Value {
    let path = root().join("packages/contracts/test-vectors").join(name);
    serde_json::from_slice(&std::fs::read(path).expect(name)).expect("valid JSON")
}

/// The bytes of a `pixel-tensors.json` input by image name.
fn image_bytes(pixels: &Value, image: &str) -> Vec<u8> {
    let case = pixels["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| {
            case["name"]
                .as_str()
                .is_some_and(|name| name.starts_with(&format!("{image} @")))
        })
        .unwrap_or_else(|| panic!("no input {image}"));
    if let Some(data) = case["input"].as_str() {
        return base64::engine::general_purpose::STANDARD
            .decode(data)
            .expect("base64");
    }
    std::fs::read(root().join(case["path"].as_str().expect("path"))).expect("asset")
}

fn cosine(a: &[f32], b: &[f32]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(&x, &y)| f64::from(x) * f64::from(y))
        .sum()
}

#[test]
#[ignore = "needs the model files in MEMRY_ML_MODEL_DIR"]
fn image_embeddings_match_electron() {
    let vectors = read_json("embeddings-image.json");
    let pixels = read_json("pixel-tensors.json");
    let tolerance = &vectors["tolerance"];
    let min_cosine = tolerance["minCosine"].as_f64().expect("minCosine");
    let max_diff = tolerance["maxComponentDiff"]
        .as_f64()
        .expect("maxComponentDiff");
    assert!(min_cosine >= 0.9999 && max_diff <= 0.001);
    let dir = PathBuf::from(std::env::var_os("MEMRY_ML_MODEL_DIR").expect("MEMRY_ML_MODEL_DIR"));
    memry_ml::verify(&dir, ModelGroup::Text).expect("the pinned text files");
    memry_ml::verify(&dir, ModelGroup::Vision).expect("the pinned vision files");
    let mut engine = EmbeddingEngine::load(&dir, LoadOptions::default()).expect("load");

    let cases = vectors["cases"].as_array().expect("cases");
    assert!(cases.len() >= 14, "{} cases", cases.len());
    let mut failures = Vec::new();
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let bytes = image_bytes(&pixels, case["image"].as_str().expect("image"));
        let soft_tokens =
            usize::try_from(case["softTokens"].as_u64().expect("softTokens")).expect("usize");
        let text = case["text"].as_str();
        let tensor = image_prep::prepare(&bytes, soft_tokens).expect(name);
        let ids = engine
            .image_token_ids(text, tensor.num_soft_tokens)
            .expect(name);
        let want_ids: Vec<i64> = case["tokenIds"]
            .as_array()
            .expect("tokenIds")
            .iter()
            .map(|id| id.as_i64().expect("id"))
            .collect();
        if ids != want_ids {
            failures.push(format!("{name}: token ids differ"));
            continue;
        }
        let want: Vec<f32> = case["embedding"]
            .as_array()
            .expect("embedding")
            .iter()
            .map(|v| v.as_f64().expect("number") as f32)
            .collect();
        assert_eq!(want.len(), EMBEDDING_DIMENSION);
        let got = engine
            .embed_image(&bytes, text, Some(soft_tokens))
            .expect(name);
        let cos = cosine(&got, &want);
        let worst = got
            .iter()
            .zip(&want)
            .map(|(a, b)| f64::from((a - b).abs()))
            .fold(0.0, f64::max);
        eprintln!("{name}: cosine {cos:.6}, largest component difference {worst:.6}");
        match case["divergent"].as_str() {
            Some(kind) => {
                let bound = vectors["divergentMinCosine"][kind]
                    .as_f64()
                    .unwrap_or_else(|| panic!("divergentMinCosine.{kind}"));
                assert!(bound >= 0.999, "the {kind} bound may not go under 0.999");
                if cos < bound {
                    failures.push(format!(
                        "{name}: cosine {cos} under the {kind} bound {bound}"
                    ));
                }
            }
            None if cos < min_cosine || worst > max_diff => failures.push(format!(
                "{name}: cosine {cos}, largest component difference {worst}"
            )),
            None => {}
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
