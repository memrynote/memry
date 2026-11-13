//! `packages/contracts/test-vectors/pixel-tensors.json`: the pixels Electron's image path hands the
//! vision encoder (`crates/memry-ml/tests/golden/generate-image.mjs`). PNG, WebP and GIF inputs
//! match bit for bit. JPEG decoding and ICC conversion are a known divergence (test-vectors
//! README): those cases match in every size and position and stay within `maxLevelDiff` per
//! channel of Electron's decoded pixels.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use memry_ml::image_prep::{self, PixelTensor};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn vectors() -> Value {
    let path = root().join("packages/contracts/test-vectors/pixel-tensors.json");
    serde_json::from_slice(&std::fs::read(path).expect("pixel-tensors.json")).expect("json")
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn input_bytes(case: &Value) -> Vec<u8> {
    if let Some(data) = case["input"].as_str() {
        return base64::engine::general_purpose::STANDARD
            .decode(data)
            .expect("base64");
    }
    let bytes = std::fs::read(root().join(case["path"].as_str().expect("path"))).expect("asset");
    assert_eq!(sha256(&bytes), case["sha256"], "{} changed", case["path"]);
    bytes
}

fn usize_of(value: &Value) -> usize {
    usize::try_from(value.as_u64().expect("number")).expect("usize")
}

fn le_bytes<T: Copy, const N: usize>(values: &[T], to_le: fn(T) -> [u8; N]) -> Vec<u8> {
    values.iter().flat_map(|&value| to_le(value)).collect()
}

/// Largest per-channel difference between two decoded images of the same size.
fn max_level_diff(a: &[u8], b: &[u8]) -> u8 {
    assert_eq!(a.len(), b.len());
    a.iter()
        .zip(b)
        .map(|(x, y)| x.abs_diff(*y))
        .max()
        .unwrap_or(0)
}

/// Checks one valid case and returns the measured level difference of a divergent one.
fn check(name: &str, case: &Value, bytes: &[u8], limits: &Value) -> Option<u8> {
    let expected = &case["expected"];
    let soft_tokens = usize_of(&case["softTokens"]);
    let decoded = image_prep::decode(bytes).unwrap_or_else(|error| panic!("{name}: {error}"));
    let tensor: PixelTensor = image_prep::pixel_tensor(decoded.clone(), soft_tokens)
        .unwrap_or_else(|error| panic!("{name}: {error}"));
    let want = &expected["decoded"];
    assert_eq!(
        (decoded.width, decoded.height),
        (usize_of(&want["width"]), usize_of(&want["height"])),
        "{name}: decoded size"
    );
    let resized = &expected["resized"];
    assert_eq!(
        (tensor.resized.width, tensor.resized.height),
        (usize_of(&resized["width"]), usize_of(&resized["height"])),
        "{name}: resized size"
    );
    assert_eq!(
        tensor.max_patches,
        usize_of(&expected["maxPatches"]),
        "{name}"
    );
    assert_eq!(
        tensor.num_soft_tokens,
        usize_of(&expected["numSoftTokens"]),
        "{name}"
    );
    let patches = tensor.position_ids.chunks(2).filter(|p| p[0] >= 0).count();
    assert_eq!(patches, usize_of(&expected["patches"]), "{name}: patches");
    assert_eq!(
        sha256(&le_bytes(&tensor.position_ids, i64::to_le_bytes)),
        expected["positionIds"],
        "{name}: position ids"
    );
    let Some(kind) = case["divergent"].as_str() else {
        assert_eq!(
            sha256(&decoded.data),
            want["sha256"],
            "{name}: decoded pixels"
        );
        assert_eq!(
            sha256(&le_bytes(&tensor.pixel_values, f32::to_le_bytes)),
            expected["pixelValues"],
            "{name}: pixel values"
        );
        return None;
    };
    let rgb = want["rgb"].as_str()?;
    let oracle = base64::engine::general_purpose::STANDARD
        .decode(rgb)
        .expect("base64");
    let diff = max_level_diff(&decoded.data, &oracle);
    let bound = limits[kind].as_u64().expect("maxLevelDiff");
    assert!(
        u64::from(diff) <= bound,
        "{name}: decoded pixels differ by {diff} levels, over the {kind} bound {bound}"
    );
    Some(diff)
}

#[test]
fn every_case_matches_electrons_preprocessing() {
    let file = vectors();
    let cases = file["cases"].as_array().expect("cases");
    assert!(cases.len() >= 50, "{} cases", cases.len());
    let (mut exact, mut bounded, mut failures) = (0, 0, Vec::new());
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let bytes = input_bytes(case);
        // Each case runs to the end, so one run lists every mismatch.
        let outcome = std::panic::catch_unwind(|| {
            if case["expected"].get("error").is_some() {
                let soft_tokens = usize_of(&case["softTokens"]);
                assert!(
                    image_prep::prepare(&bytes, soft_tokens).is_err(),
                    "{name}: Electron throws {}",
                    case["expected"]["error"]
                );
                return None;
            }
            Some(check(name, case, &bytes, &file["maxLevelDiff"]))
        });
        match outcome {
            Err(panic) => failures.push(
                panic
                    .downcast_ref::<String>()
                    .cloned()
                    .unwrap_or_else(|| format!("{name}: panicked")),
            ),
            Ok(Some(Some(diff))) => {
                bounded += 1;
                eprintln!("{name}: max level diff {diff}");
            }
            Ok(Some(None)) if case["divergent"].is_null() => exact += 1,
            Ok(Some(None)) => bounded += 1,
            Ok(None) => {}
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(
        exact >= 20 && bounded >= 10,
        "{exact} exact, {bounded} bounded"
    );
}
