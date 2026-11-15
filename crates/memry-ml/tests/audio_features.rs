//! Parity with Electron's audio input: `packages/contracts/test-vectors/audio-features.json`,
//! written by `tests/golden/generate-audio.mjs` from `audio-embedding.ts` in place and
//! transformers.js's audio feature extractor. Decoding and windows are exact; features are held to
//! the file's tolerance. Needs no model.

mod common;

use common::audio::mono_samples;
use common::{floats, vectors};
use memry_ml::{
    MEL_BINS, MIN_SAMPLE_RATE, audio_features, audio_soft_tokens, audio_windows, decode_wav,
};
use serde_json::Value;

/// The cases of `section`, at least `floor` of them, so a generator that drops cases fails here.
fn cases<'a>(vectors: &'a Value, section: &str, floor: usize) -> &'a [Value] {
    let cases = vectors[section].as_array().expect(section);
    assert!(
        cases.len() >= floor,
        "{section}: {} cases, at least {floor}",
        cases.len()
    );
    cases
}

/// The sample rate of the last `fmt ` chunk before `data`, read as RIFF chunks.
fn header_rate(bytes: &[u8]) -> Option<u32> {
    let u32_at = |at: usize| Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?));
    let mut rate = None;
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let size = u32_at(at + 4)? as usize;
        match &bytes[at..at + 4] {
            b"fmt " => rate = u32_at(at + 12).or(rate),
            b"data" => break,
            _ => {}
        }
        at = at.checked_add(8 + size + size % 2)?;
    }
    rate
}

#[test]
fn decoded_wav_files_equal_electrons() {
    let vectors = vectors("audio-features.json");
    let mut failures = Vec::new();
    for case in cases(&vectors, "decode", 33) {
        let name = case["name"].as_str().expect("name");
        let bytes = hex::decode(case["wav"].as_str().expect("wav")).expect("hex");
        let actual = decode_wav(&bytes);
        let expected = (!case["expected"].is_null()).then(|| floats(&case["expected"]));
        // The only intended decoding divergence: a rate under 4 kHz that Electron decodes. It is
        // read from the header, and the file's tag must agree.
        let diverges = expected.is_some()
            && header_rate(&bytes).is_some_and(|rate| (1..MIN_SAMPLE_RATE).contains(&rate));
        if diverges != case.get("divergence").is_some() {
            failures.push(format!("{name}: divergence tag disagrees with the header"));
            continue;
        }
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
    for case in cases(&vectors, "windows", 9) {
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
    for case in cases(&vectors, "features", 7) {
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
        let soft_tokens = features.mask.iter().step_by(4).filter(|&&v| v).count();
        assert_eq!(audio_soft_tokens(samples.len()).expect(name), soft_tokens);
        let shape = (features.frames, valid, soft_tokens);
        if shape != (count("frames"), count("validFrames"), count("softTokens"))
            || features.mask[valid..].iter().any(|&valid| valid)
        {
            failures.push(format!(
                "{name}: frames, valid frames, soft tokens {shape:?}"
            ));
            continue;
        }
        let rows: &[[f32; MEL_BINS]] = features.values.as_chunks::<MEL_BINS>().0;
        let row_sums = expected["rowSums"].as_array().expect("rowSums");
        let kept = expected["rows"].as_object().expect("rows");
        assert_eq!(row_sums.len(), features.frames, "{name}: one sum per frame");
        assert!(kept.len() >= 2, "{name}: {} kept rows", kept.len());
        let sum_diff = rows
            .iter()
            .zip(row_sums)
            .map(|(row, sum)| {
                let actual: f64 = row.iter().map(|&v| f64::from(v)).sum();
                (actual - sum.as_f64().expect("a sum")).abs()
            })
            .fold(0.0, f64::max);
        let mut row_diff = 0.0_f64;
        for (index, values) in kept {
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
