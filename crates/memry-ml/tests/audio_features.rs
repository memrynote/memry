//! Parity with Electron's audio input: `packages/contracts/test-vectors/audio-features.json`,
//! written by `tests/golden/generate-audio.mjs` from `audio-embedding.ts` in place and
//! transformers.js's audio feature extractor. Decoding and windows are exact; features are held to
//! the file's tolerance. Needs no model.

mod common;

use common::{floats, mono_samples, vectors};
use memry_ml::{MEL_BINS, audio_features, audio_windows, decode_wav};

#[test]
fn decoded_wav_files_equal_electrons() {
    let vectors = vectors("audio-features.json");
    let mut failures = Vec::new();
    for case in vectors["decode"].as_array().expect("decode") {
        let name = case["name"].as_str().expect("name");
        let bytes = hex::decode(case["wav"].as_str().expect("wav")).expect("hex");
        let actual = decode_wav(&bytes);
        let expected = (!case["expected"].is_null()).then(|| floats(&case["expected"]));
        let diverges = case.get("divergence").is_some();
        match (actual, expected) {
            (Err(_), _) if diverges => {}
            (Ok(_), _) if diverges => failures.push(format!("{name}: decoded a refused file")),
            (Err(_), None) => {}
            (Ok(samples), Some(expected)) if samples == expected => {}
            (actual, expected) => failures.push(format!(
                "{name}: rust {:?} samples, electron {:?}",
                actual.map(|s| s.len()).map_err(|e| e.to_string()),
                expected.map(|s| s.len())
            )),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn windows_equal_electrons() {
    let vectors = vectors("audio-features.json");
    for case in vectors["windows"].as_array().expect("windows") {
        let samples = vec![0.0_f32; case["samples"].as_u64().expect("samples") as usize];
        let lengths: Vec<u64> = audio_windows(&samples)
            .iter()
            .map(|window| window.len() as u64)
            .collect();
        let expected: Vec<u64> = case["windows"]
            .as_array()
            .expect("lengths")
            .iter()
            .map(|n| n.as_u64().expect("length"))
            .collect();
        assert_eq!(lengths, expected, "{} samples", case["samples"]);
    }
}

fn worst(actual: &[f32], expected: &[f32]) -> f64 {
    actual
        .iter()
        .zip(expected)
        .map(|(&a, &b)| (f64::from(a) - f64::from(b)).abs())
        .fold(0.0, f64::max)
}

#[test]
fn features_match_transformers_js_within_the_tolerance() {
    let vectors = vectors("audio-features.json");
    let tolerance = vectors["tolerance"]["maxAbsDiff"]
        .as_f64()
        .expect("maxAbsDiff");
    assert!(tolerance <= 1e-4, "the bound may not be loosened");
    let mut failures = Vec::new();
    for case in vectors["features"].as_array().expect("features") {
        let name = case["name"].as_str().expect("name");
        let samples = mono_samples(&case["signal"]);
        assert_eq!(
            samples.len() as u64,
            case["samples"].as_u64().expect("samples")
        );
        let expected = &case["expected"];
        let features = audio_features(&samples).expect(name);
        let count = |key: &str| expected[key].as_u64().expect(key) as usize;
        let valid = features.mask.iter().take_while(|&&valid| valid).count();
        let shape = (features.frames, valid, features.soft_tokens());
        if shape != (count("frames"), count("validFrames"), count("softTokens"))
            || features.mask[valid..].iter().any(|&valid| valid)
        {
            failures.push(format!(
                "{name}: frames, valid frames, soft tokens {shape:?}"
            ));
            continue;
        }
        let rows: &[[f32; MEL_BINS]] = features.values.as_chunks::<MEL_BINS>().0;
        let sum_diff = rows
            .iter()
            .zip(expected["rowSums"].as_array().expect("rowSums"))
            .map(|(row, sum)| {
                let actual: f64 = row.iter().map(|&v| f64::from(v)).sum();
                (actual - sum.as_f64().expect("a sum")).abs()
            })
            .fold(0.0, f64::max);
        let mut row_diff = 0.0_f64;
        for (index, values) in expected["rows"].as_object().expect("rows") {
            let index: usize = index.parse().expect("row index");
            row_diff = row_diff.max(worst(&rows[index], &floats(values)));
        }
        eprintln!("{name}: row difference {row_diff:.2e}, row sum difference {sum_diff:.2e}");
        if row_diff > tolerance || sum_diff > MEL_BINS as f64 * tolerance {
            failures.push(format!("{name}: row {row_diff}, row sum {sum_diff}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
