//! The integer input recipes of `tests/golden/generate-audio.mjs` (`recipeSamples`, `wav`), so the
//! audio tests rebuild the oracle's inputs byte for byte instead of storing them.

#![allow(dead_code)]

use std::path::Path;

use serde_json::Value;

pub fn vectors(file: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/test-vectors")
        .join(file);
    serde_json::from_str(&std::fs::read_to_string(&path).expect(file)).expect("valid JSON")
}

fn int(value: &Value, key: &str) -> i64 {
    value[key]
        .as_i64()
        .unwrap_or_else(|| panic!("integer {key}"))
}

/// `recipeSamples(signal, channels)`: one integer sample per frame and channel.
pub fn recipe_samples(signal: &Value, channels: usize) -> Vec<i32> {
    let mut out = Vec::new();
    for segment in signal.as_array().expect("signal") {
        let frames = int(segment, "frames") as usize;
        let kind = segment["kind"].as_str().expect("kind");
        let mut x = segment["seed"].as_u64().unwrap_or(0) as u32;
        for frame in 0..frames as i64 {
            for channel in 0..channels as u32 {
                out.push(match kind {
                    "noise" => {
                        x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                        ((x >> 16) as i32 - 32768) >> int(segment, "shift")
                    }
                    "square" => {
                        let (period, amplitude) =
                            (int(segment, "period"), int(segment, "amplitude"));
                        let value = if (frame % period) * 2 < period {
                            amplitude
                        } else {
                            -amplitude
                        };
                        (value as i32) >> channel
                    }
                    "triangle" => {
                        let (period, amplitude) =
                            (int(segment, "period"), int(segment, "amplitude"));
                        let phase = frame % period;
                        let up = (4 * amplitude * phase).div_euclid(period);
                        let value = if phase * 2 < period {
                            -amplitude + up
                        } else {
                            3 * amplitude - up
                        };
                        (value as i32) >> channel
                    }
                    "silence" => 0,
                    other => panic!("unknown segment {other}"),
                });
            }
        }
    }
    out
}

/// 16 kHz mono samples of a feature case: `int / 32768`.
pub fn mono_samples(signal: &Value) -> Vec<f32> {
    recipe_samples(signal, 1)
        .into_iter()
        .map(|value| value as f32 / 32768.0)
        .collect()
}

/// `wav(recipe)`: a `fmt ` chunk (40 bytes when extensible), then the `data` chunk.
pub fn wav(recipe: &Value) -> Vec<u8> {
    let format = int(recipe, "format") as u16;
    let sub_format = recipe["subFormat"].as_i64().map(|f| f as u16);
    let bits = int(recipe, "bits") as u16;
    let channels = int(recipe, "channels") as u16;
    let rate = int(recipe, "sampleRate") as u32;
    let ints = recipe_samples(&recipe["signal"], usize::from(channels));
    let width = usize::from(bits / 8);
    let extensible = format == 0xFFFE;
    let fmt_size: u32 = if extensible { 40 } else { 16 };
    let data_size = (ints.len() * width) as u32;
    let mut bytes = b"RIFF".to_vec();
    bytes.extend((4 + 8 + fmt_size + 8 + data_size).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(fmt_size.to_le_bytes());
    bytes.extend(format.to_le_bytes());
    bytes.extend(channels.to_le_bytes());
    bytes.extend(rate.to_le_bytes());
    bytes.extend((rate * u32::from(channels) * width as u32).to_le_bytes());
    bytes.extend((channels * width as u16).to_le_bytes());
    bytes.extend(bits.to_le_bytes());
    if let Some(sub_format) = sub_format.filter(|_| extensible) {
        bytes.extend(22_u16.to_le_bytes());
        bytes.extend(bits.to_le_bytes());
        bytes.extend(0_u32.to_le_bytes());
        bytes.extend(sub_format.to_le_bytes());
        bytes.extend([0; 14]);
    }
    bytes.extend(b"data");
    bytes.extend(data_size.to_le_bytes());
    let float = format == 3 || sub_format == Some(3);
    for value in ints {
        if float {
            bytes.extend((value as f32 / 32768.0).to_le_bytes());
        } else if bits == 16 {
            bytes.extend((value as i16).to_le_bytes());
        } else {
            bytes.extend((value * 65536).to_le_bytes());
        }
    }
    bytes
}

pub fn floats(value: &Value) -> Vec<f32> {
    value
        .as_array()
        .expect("numbers")
        .iter()
        .map(|v| v.as_f64().expect("a number") as f32)
        .collect()
}
