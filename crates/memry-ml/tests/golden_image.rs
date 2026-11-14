//! Parity with transformers.js: `packages/contracts/test-vectors/embeddings-image.json`, written by
//! `tests/golden/generate-image.mjs` from Electron's `embedImage`, holds the token ids and the
//! stored vector of photos, an OCR page with and without its text and small lossless images.
//! Token ids are exact. PNG, WebP and GIF vectors meet the text bounds; JPEG, ICC-tagged and CMYK
//! images, found from the input bytes, decode differently (test-vectors README) and meet the file's
//! `divergentMinCosine`, which never goes under the class's floor in `MIN_DIVERGENT_COSINE`.
//! Needs the pinned text and vision files in `MEMRY_ML_MODEL_DIR`; CI runs it on the full tier.
//! Run: `cargo test -p memry-ml --test golden_image -- --ignored`.

mod common;

use std::path::PathBuf;

use base64::Engine as _;
use common::{divergence, root};
use memry_ml::{EMBEDDING_DIMENSION, EmbeddingEngine, LoadOptions, ModelGroup, image_prep};
use serde_json::Value;

/// The floor of each divergent class's cosine with Electron's vector; lowering one needs Kaan's
/// approval. CMYK and YCCK JPEGs convert naively, without their profile (Kaan, 2026-11-14:
/// accepted; measured 0.977145 without a profile and 0.985693 with libvips' profile, 0.978037 with
/// the resampled profile the vector embeds).
const MIN_DIVERGENT_COSINE: [(&str, f64); 5] = [
    ("jpeg", 0.999),
    ("icc", 0.999),
    ("jpeg+icc", 0.999),
    ("cmyk", 0.97),
    ("cmyk+icc", 0.97),
];

fn floor(kind: &str) -> f64 {
    MIN_DIVERGENT_COSINE
        .iter()
        .find(|(class, _)| *class == kind)
        .unwrap_or_else(|| panic!("no floor for {kind}"))
        .1
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

/// The bounds and divergence tags of `embeddings-image.json` that loosen what the inputs allow: text
/// bounds looser than `golden_text.rs`, a divergent cosine under the floor, or a `divergent` tag
/// the image's bytes do not call for.
fn bound_failures(vectors: &Value, pixels: &Value) -> Vec<String> {
    let mut failures = Vec::new();
    let tolerance = &vectors["tolerance"];
    if !(tolerance["minCosine"]
        .as_f64()
        .is_some_and(|cosine| cosine >= 0.9999)
        && tolerance["maxComponentDiff"]
            .as_f64()
            .is_some_and(|diff| diff <= 0.001))
    {
        failures.push(format!(
            "tolerance {tolerance} is looser than the text bounds"
        ));
    }
    for (kind, floor) in MIN_DIVERGENT_COSINE {
        let bound = vectors["divergentMinCosine"][kind].as_f64();
        if !bound.is_some_and(|bound| bound >= floor) {
            failures.push(format!(
                "divergentMinCosine.{kind} is {bound:?}, under {floor}"
            ));
        }
    }
    for case in vectors["cases"].as_array().expect("cases") {
        let derived = divergence(&image_bytes(pixels, case["image"].as_str().expect("image")));
        if case["divergent"].as_str() != derived {
            failures.push(format!(
                "{}: tagged {} but the image is {derived:?}",
                case["name"], case["divergent"]
            ));
        }
    }
    failures
}

#[test]
fn a_file_that_loosens_a_bound_or_a_tag_fails() {
    let vectors = read_json("embeddings-image.json");
    let pixels = read_json("pixel-tensors.json");
    assert_eq!(bound_failures(&vectors, &pixels), Vec::<String>::new());
    type Edit = (&'static str, fn(&mut Value));
    let edits: [Edit; 7] = [
        ("jpeg floor lowered", |file| {
            file["divergentMinCosine"]["jpeg"] = 0.99.into();
        }),
        ("cmyk floor lowered", |file| {
            file["divergentMinCosine"]["cmyk"] = 0.96.into();
        }),
        ("cmyk+icc floor removed", |file| {
            file["divergentMinCosine"]
                .as_object_mut()
                .expect("floors")
                .remove("cmyk+icc");
        }),
        ("cmyk tagged jpeg", |file| {
            let cases = file["cases"].as_array_mut().expect("cases");
            let cmyk = cases
                .iter_mut()
                .find(|case| case["image"] == "jpeg cmyk")
                .expect("jpeg cmyk");
            cmyk["divergent"] = "jpeg".into();
        }),
        ("text bound loosened", |file| {
            file["tolerance"]["minCosine"] = 0.999.into();
        }),
        ("jpeg untagged", |file| {
            file["cases"][0]["divergent"] = Value::Null
        }),
        ("png tagged divergent", |file| {
            let cases = file["cases"].as_array_mut().expect("cases");
            let png = cases
                .iter_mut()
                .find(|case| case["image"] == "png rgb")
                .expect("png rgb");
            png["divergent"] = "icc".into();
        }),
    ];
    for (name, edit) in edits {
        let mut copy = vectors.clone();
        edit(&mut copy);
        assert!(!bound_failures(&copy, &pixels).is_empty(), "{name} passed");
    }
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
    let loosened = bound_failures(&vectors, &pixels);
    assert!(loosened.is_empty(), "{}", loosened.join("\n"));
    let tolerance = &vectors["tolerance"];
    let min_cosine = tolerance["minCosine"].as_f64().expect("minCosine");
    let max_diff = tolerance["maxComponentDiff"]
        .as_f64()
        .expect("maxComponentDiff");
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
        match divergence(&bytes) {
            Some(kind) => {
                let bound = vectors["divergentMinCosine"][kind]
                    .as_f64()
                    .unwrap_or_else(|| panic!("divergentMinCosine.{kind}"))
                    .max(floor(kind));
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
