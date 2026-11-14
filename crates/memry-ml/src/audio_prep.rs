//! Audio input of the audio encoder, as Electron prepares it: `decodeWavForEmbedding` and
//! `splitAudioWindows`/`embedAudio` of `apps/desktop/src/main/lib/audio-embedding.ts`, then the
//! log-mel features of transformers.js's `Gemma4AudioFeatureExtractor` that the worker's
//! `processor(null, null, audio)` computes for one window.
//!
//! A WAV file is untrusted vault data. The decoder reads only inside the slice, allocates its output
//! once, sized from the bytes present (never from a header's claims), and stops at
//! [`MAX_DECODED_SAMPLES`]; malformed input is an error, never a panic.

use std::cell::Cell;
use std::sync::OnceLock;

use crate::MlError;

/// `EMBEDDING_AUDIO_SAMPLE_RATE`: the encoder takes 16 kHz mono.
pub const SAMPLE_RATE: u32 = 16_000;

/// Samples of one embedded window (`EMBEDDING_AUDIO_WINDOW_SECONDS`, 300 s).
pub const WINDOW_SAMPLES: usize = 300 * SAMPLE_RATE as usize;

/// `EMBEDDING_AUDIO_MAX_WINDOWS`: the rest of a longer recording is not indexed.
pub const MAX_WINDOWS: usize = 12;

/// `MIN_AUDIO_SECONDS`: shorter recordings, and shorter tails after the first window, are skipped.
pub const MIN_SAMPLES: usize = SAMPLE_RATE as usize;

/// Decoded samples past this are never embedded (`MAX_WINDOWS` windows), so they are not decoded.
pub const MAX_DECODED_SAMPLES: usize = MAX_WINDOWS * WINDOW_SAMPLES;

/// Lowest sample rate the decoder accepts. Electron decodes any rate; below 4 kHz a file of a few
/// bytes would claim hours of 16 kHz output, so the native decoder refuses it (no recorder writes
/// one). At 4 kHz the output is at most 8 times the input (`memry-test-kit` `output_bound`).
pub const MIN_SAMPLE_RATE: u32 = 4_000;

/// The extractor's `max_length`: it embeds the first 30 s of each window and drops the rest.
const MAX_FEATURE_SAMPLES: usize = 480_000;
const PAD_TO_MULTIPLE: usize = 128;
const FRAME_LENGTH: usize = 320;
const HOP_LENGTH: usize = 160;
const FFT_LENGTH: usize = 512;
const FREQUENCY_BINS: usize = FFT_LENGTH / 2 + 1;
const MEL_FLOOR: f64 = 0.001;

/// Width of one feature frame (`feature_size`).
pub const MEL_BINS: usize = 128;

thread_local! {
    static DECODE_STEPS: Cell<usize> = const { Cell::new(0) };
}

fn step() {
    DECODE_STEPS.with(|steps| steps.set(steps.get() + 1));
}

/// Chunks and samples the decoder visited on this thread, for the complexity test.
#[doc(hidden)]
pub fn decode_steps() -> usize {
    DECODE_STEPS.with(Cell::get)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sample {
    Pcm16,
    Pcm32,
    Float32,
}

impl Sample {
    fn width(self) -> usize {
        match self {
            Self::Pcm16 => 2,
            Self::Pcm32 | Self::Float32 => 4,
        }
    }

    fn read(self, bytes: &[u8], at: usize) -> f64 {
        let word = |n: usize| -> [u8; 4] {
            let mut out = [0; 4];
            out[..n].copy_from_slice(&bytes[at..at + n]);
            out
        };
        match self {
            Self::Pcm16 => f64::from(i16::from_le_bytes([bytes[at], bytes[at + 1]])) / 32768.0,
            Self::Pcm32 => f64::from(i32::from_le_bytes(word(4))) / 2_147_483_648.0,
            Self::Float32 => f64::from(f32::from_le_bytes(word(4))),
        }
    }
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// `decodeWavForEmbedding`: a PCM16, PCM32 or float32 WAV file as 16 kHz mono, channels averaged
/// and other rates resampled linearly. Electron returns null where this returns
/// [`MlError::Input`]. The output stops at [`MAX_DECODED_SAMPLES`].
pub fn decode_wav(bytes: &[u8]) -> Result<Vec<f32>, MlError> {
    decode_wav_capped(bytes, MAX_DECODED_SAMPLES)
}

fn unsupported() -> MlError {
    MlError::Input("not a PCM16, PCM32 or float32 WAV file".into())
}

pub(crate) fn decode_wav_capped(bytes: &[u8], max_samples: usize) -> Result<Vec<f32>, MlError> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(unsupported());
    }
    let len = bytes.len() as u64;
    let (mut format, mut channels, mut rate, mut bits) = (0_u16, 0_u16, 0_u32, 0_u16);
    let mut data = None;
    let mut offset = 12_u64;
    while offset + 8 <= len {
        step();
        let at = offset as usize;
        let size = u64::from(u32_at(bytes, at + 4));
        let body = offset + 8;
        let id = &bytes[at..at + 4];
        if id == b"fmt " && body + 16 <= len {
            let body = body as usize;
            format = u16_at(bytes, body);
            channels = u16_at(bytes, body + 2);
            rate = u32_at(bytes, body + 4);
            bits = u16_at(bytes, body + 14);
            // WAVE_FORMAT_EXTENSIBLE carries the real format in its sub-format GUID.
            if format == 0xFFFE && body as u64 + 26 <= len {
                format = u16_at(bytes, body + 24);
            }
        } else if id == b"data" {
            data = Some((body as usize, (body + size).min(len) as usize));
            break;
        }
        offset = body + size + size % 2;
    }

    let sample = match (format, bits) {
        (1, 16) => Sample::Pcm16,
        (1, 32) => Sample::Pcm32,
        (3, 32) => Sample::Float32,
        _ => return Err(unsupported()),
    };
    let Some((start, end)) = data else {
        return Err(unsupported());
    };
    if channels == 0 || rate == 0 {
        return Err(unsupported());
    }
    if rate < MIN_SAMPLE_RATE {
        return Err(MlError::Input(format!(
            "sample rate {rate} Hz is under {MIN_SAMPLE_RATE} Hz"
        )));
    }

    let channels = usize::from(channels);
    let frame_bytes = sample.width() * channels;
    let frames = (end - start) / frame_bytes;
    let mono = |frame: usize| -> f32 {
        let mut sum = 0.0;
        for channel in 0..channels {
            step();
            sum += sample.read(bytes, start + (frame * channels + channel) * sample.width());
        }
        (sum / channels as f64) as f32
    };

    if rate == SAMPLE_RATE {
        return Ok((0..frames.min(max_samples)).map(mono).collect());
    }
    // `Math.floor((frames * 16000) / sampleRate)`: frames < 2^32, so the f64 product is exact.
    let out_len = ((frames as f64 * f64::from(SAMPLE_RATE)) / f64::from(rate)).floor() as usize;
    let step_size = f64::from(rate) / f64::from(SAMPLE_RATE);
    let mut out = Vec::with_capacity(out_len.min(max_samples));
    for i in 0..out_len.min(max_samples) {
        let position = i as f64 * step_size;
        let left = (position.floor() as usize).min(frames - 1);
        let right = (left + 1).min(frames - 1);
        let (l, r) = (f64::from(mono(left)), f64::from(mono(right)));
        out.push((l + (r - l) * (position - left as f64)) as f32);
    }
    Ok(out)
}

/// The windows `embedAudio` embeds: none for a recording under one second, else consecutive
/// [`WINDOW_SAMPLES`] windows, at most [`MAX_WINDOWS`], without a tail under one second.
pub fn audio_windows(samples: &[f32]) -> Vec<&[f32]> {
    if samples.len() < MIN_SAMPLES {
        return Vec::new();
    }
    let mut windows = Vec::new();
    for window in samples.chunks(WINDOW_SAMPLES).take(MAX_WINDOWS) {
        if !windows.is_empty() && window.len() < MIN_SAMPLES {
            break;
        }
        windows.push(window);
    }
    windows
}

/// Log-mel features of one window: `frames` rows of [`MEL_BINS`] values, zero where `mask` is
/// false (a frame that reaches past the samples).
#[derive(Debug, Clone, PartialEq)]
pub struct AudioFeatures {
    pub frames: usize,
    pub values: Vec<f32>,
    pub mask: Vec<bool>,
}

impl AudioFeatures {
    /// Soft tokens the encoder emits: it keeps every 4th frame (two stride-2 convolutions), and the
    /// processor counts the valid ones (`_process_audio`).
    pub fn soft_tokens(&self) -> usize {
        self.mask.iter().step_by(4).filter(|&&valid| valid).count()
    }
}

/// `Gemma4AudioFeatureExtractor` with the model's `preprocessor_config.json`: the first 30 s,
/// zero-padded to a multiple of 128 samples, 160 zeros in front (semicausal), 320-sample frames
/// every 160 samples under a periodic Hann window, a 512-point power spectrum, its square root, the
/// HTK mel filters (0 to 8 kHz, no normalisation), `ln(mel + 0.001)`.
pub fn audio_features(window: &[f32]) -> Result<AudioFeatures, MlError> {
    let original = window.len();
    let audio = &window[..original.min(MAX_FEATURE_SAMPLES)];
    let padded = audio.len().div_ceil(PAD_TO_MULTIPLE) * PAD_TO_MULTIPLE;
    let pad_left = FRAME_LENGTH / 2;
    // Python's `unfold(size=frame_length + 1, step=hop_length)` over the semicausal padding.
    let span = padded + pad_left;
    if span < FRAME_LENGTH + 1 {
        return Err(MlError::Input(format!(
            "{original} samples are too short for one audio frame"
        )));
    }
    let frames = (span - (FRAME_LENGTH + 1)) / HOP_LENGTH + 1;
    let sample = |index: usize| -> f64 {
        index
            .checked_sub(pad_left)
            .and_then(|i| audio.get(i))
            .map_or(0.0, |&value| f64::from(value))
    };

    let tables = tables();
    let mut values = vec![0.0_f32; frames * MEL_BINS];
    let mut mask = vec![false; frames];
    let mut buffer = [(0.0_f64, 0.0_f64); FFT_LENGTH];
    let mut magnitudes = [0.0_f32; FREQUENCY_BINS];
    for (frame, row) in values.as_chunks_mut::<MEL_BINS>().0.iter_mut().enumerate() {
        let offset = frame * HOP_LENGTH;
        for (j, slot) in buffer.iter_mut().enumerate() {
            *slot = if j < FRAME_LENGTH {
                (sample(offset + j) * tables.window[j], 0.0)
            } else {
                (0.0, 0.0)
            };
        }
        fft(&mut buffer, &tables.twiddles);
        for (bin, magnitude) in magnitudes.iter_mut().enumerate() {
            let (re, im) = buffer[bin];
            // The power lands in a Float32Array, then `**= 0.5`.
            let power = (re * re + im * im) as f32;
            *magnitude = f64::from(power).sqrt() as f32;
        }
        // A frame is real audio only when every sample of its unfold span is.
        let valid = offset + FRAME_LENGTH < pad_left + original;
        mask[frame] = valid;
        if !valid {
            continue;
        }
        for (value, filter) in row.iter_mut().zip(&tables.mel) {
            let mel: f64 = filter
                .weights
                .iter()
                .zip(&magnitudes[filter.first..])
                .map(|(&w, &m)| f64::from(w) * f64::from(m))
                .sum();
            let floored = (f64::from(mel as f32) + MEL_FLOOR) as f32;
            *value = f64::from(floored).ln() as f32;
        }
    }
    Ok(AudioFeatures {
        frames,
        values,
        mask,
    })
}

/// One mel filter: its non-zero weights (f32, as the extractor's filter tensor) from bin `first`.
struct MelFilter {
    first: usize,
    weights: Vec<f32>,
}

struct Tables {
    window: [f64; FRAME_LENGTH],
    twiddles: Vec<(f64, f64)>,
    mel: Vec<MelFilter>,
}

fn tables() -> &'static Tables {
    static TABLES: OnceLock<Tables> = OnceLock::new();
    TABLES.get_or_init(|| {
        // `window_function(320, 'hann')`: a 321-point Hann window without its last point.
        let mut window = [0.0; FRAME_LENGTH];
        let factor = 2.0 * std::f64::consts::PI / FRAME_LENGTH as f64;
        for (i, value) in window.iter_mut().enumerate() {
            *value = 0.5 - 0.5 * (i as f64 * factor).cos();
        }
        let twiddles = (0..FFT_LENGTH / 2)
            .map(|k| {
                let angle = -2.0 * std::f64::consts::PI * k as f64 / FFT_LENGTH as f64;
                (angle.cos(), angle.sin())
            })
            .collect();
        Tables {
            window,
            twiddles,
            mel: mel_filters(),
        }
    })
}

/// `mel_filter_bank(257, 128, 0, 8000, 16000, null, 'htk')`: triangles between mel-spaced edges,
/// evaluated at the FFT bin frequencies, each weight rounded to f32.
fn mel_filters() -> Vec<MelFilter> {
    let hz_to_mel = |hz: f64| 2595.0 * (1.0 + hz / 700.0).log10();
    let mel_to_hz = |mel: f64| 700.0 * (10.0_f64.powf(mel / 2595.0) - 1.0);
    let (low, high) = (hz_to_mel(0.0), hz_to_mel(8000.0));
    let edge_step = (high - low) / (MEL_BINS + 1) as f64;
    let edges: Vec<f64> = (0..MEL_BINS + 2)
        .map(|i| mel_to_hz(low + edge_step * i as f64))
        .collect();
    let bin_step = 8000.0 / (FREQUENCY_BINS - 1) as f64;
    (0..MEL_BINS)
        .map(|m| {
            let weights: Vec<f32> = (0..FREQUENCY_BINS)
                .map(|bin| {
                    let hz = bin_step * bin as f64;
                    let down = -(edges[m] - hz) / (edges[m + 1] - edges[m]);
                    let up = (edges[m + 2] - hz) / (edges[m + 2] - edges[m + 1]);
                    down.min(up).max(0.0) as f32
                })
                .collect();
            let first = weights.iter().position(|&w| w != 0.0).unwrap_or(0);
            let last = weights.iter().rposition(|&w| w != 0.0).map_or(0, |i| i + 1);
            MelFilter {
                first,
                weights: weights[first..last.max(first)].to_vec(),
            }
        })
        .collect()
}

/// In-place radix-2 FFT of a complex buffer whose length is a power of two.
fn fft(buffer: &mut [(f64, f64)], twiddles: &[(f64, f64)]) {
    let n = buffer.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            buffer.swap(i, j);
        }
    }
    let mut size = 2;
    while size <= n {
        let stride = n / size;
        for start in (0..n).step_by(size) {
            for k in 0..size / 2 {
                let (wr, wi) = twiddles[k * stride];
                let (ar, ai) = buffer[start + k];
                let (br, bi) = buffer[start + k + size / 2];
                let (tr, ti) = (br * wr - bi * wi, br * wi + bi * wr);
                buffer[start + k] = (ar + tr, ai + ti);
                buffer[start + k + size / 2] = (ar - tr, ai - ti);
            }
        }
        size <<= 1;
    }
}

#[cfg(test)]
#[path = "audio_prep_tests.rs"]
mod tests;
