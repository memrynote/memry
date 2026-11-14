use memry_test_kit::{assert_output_bounded, assert_steps_at_most, output_bound, proptest_config};
use proptest::prelude::*;

use super::*;

/// A PCM16 WAV file of `frames` frames per channel at `rate`, samples counting up from 1.
fn pcm16(channels: u16, rate: u32, frames: usize) -> Vec<u8> {
    let data: Vec<u8> = (0..frames * usize::from(channels))
        .flat_map(|i| (i as i16).wrapping_add(1).to_le_bytes())
        .collect();
    let mut bytes = b"RIFF".to_vec();
    bytes.extend(((36 + data.len()) as u32).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16_u32.to_le_bytes());
    bytes.extend(1_u16.to_le_bytes());
    bytes.extend(channels.to_le_bytes());
    bytes.extend(rate.to_le_bytes());
    bytes.extend(rate.wrapping_mul(u32::from(channels) * 2).to_le_bytes());
    bytes.extend((channels * 2).to_le_bytes());
    bytes.extend(16_u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend((data.len() as u32).to_le_bytes());
    bytes.extend(data);
    bytes
}

const HEADER: usize = 44;

#[test]
fn the_output_stops_at_the_cap_before_it_is_allocated() {
    // At 16 kHz and resampled, the decoder returns exactly Electron's first `cap` samples.
    for rate in [16_000, 44_100, 8_000] {
        let bytes = pcm16(1, rate, 4_000);
        let full = decode_wav_capped(&bytes, usize::MAX).expect("decode");
        let capped = decode_wav_capped(&bytes, 100).expect("decode");
        assert_eq!(capped.len(), 100, "rate {rate}");
        assert_eq!(capped, full[..100], "rate {rate}");
        assert!(capped.capacity() <= 100, "rate {rate}");
    }
    // 120 windows of 30 s: the first 60 min, as Electron's 12 windows of 300 s.
    assert_eq!(MAX_DECODED_SAMPLES, 12 * 300 * 16_000);
}

/// A file over the limit is refused before its header is read, like `image_prep`'s images.
#[test]
fn files_over_the_byte_limit_are_refused() {
    let mut bytes = pcm16(1, 16_000, 10);
    bytes.resize(MAX_AUDIO_BYTES + 1, 0);
    let error = decode_wav(&bytes).expect_err("over the limit");
    assert_eq!(
        error.to_string(),
        format!(
            "audio file is {} bytes, over the {MAX_AUDIO_BYTES}-byte limit",
            MAX_AUDIO_BYTES + 1
        )
    );
    bytes.truncate(MAX_AUDIO_BYTES);
    assert_eq!(decode_wav(&bytes).expect("at the limit").len(), 10);
}

#[test]
fn a_data_size_past_the_file_reads_only_the_bytes_present() {
    let mut bytes = pcm16(1, 16_000, 10);
    bytes[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
    let samples = decode_wav(&bytes).expect("decode");
    assert_eq!(samples.len(), 10);
    assert!(samples.capacity() <= 10);
}

#[test]
fn sample_rates_under_4_khz_are_refused() {
    let error = decode_wav(&pcm16(1, 3_999, 10)).expect_err("3999 Hz");
    assert_eq!(error.to_string(), "sample rate 3999 Hz is under 4000 Hz");
    assert_eq!(decode_wav(&pcm16(1, 4_000, 10)).expect("4 kHz").len(), 40);
}

/// Every step reads a chunk header or one sample; at 4 kHz mono each frame is read for at most
/// four outputs, twice each.
#[test]
fn decoding_is_linear_in_the_input() {
    for (channels, rate) in [(1, 4_000), (2, 16_000), (6, 44_100)] {
        let bytes = pcm16(channels, rate, 20_000);
        assert_steps_at_most("decode", decode_steps, 5 * bytes.len() + 10, || {
            decode_wav(&bytes).expect("decode");
        });
    }
    // A file of empty chunks is walked once.
    let mut chunks = b"RIFF\0\0\0\0WAVE".to_vec();
    for _ in 0..10_000 {
        chunks.extend(b"JUNK\0\0\0\0");
    }
    assert_steps_at_most("chunk walk", decode_steps, chunks.len() / 8 + 10, || {
        decode_wav(&chunks).expect_err("no fmt");
    });
}

#[test]
fn the_worst_output_ratio_is_within_the_kit_bound() {
    let bytes = pcm16(1, MIN_SAMPLE_RATE, 50_000);
    let samples = decode_wav(&bytes).expect("decode");
    assert_eq!(samples.len(), 200_000);
    assert_output_bounded("4 kHz pcm16", bytes.len(), samples.len() * 4);
}

#[test]
fn features_of_a_window_too_short_for_one_frame_are_an_error() {
    let error = audio_features(&[0.5; 32]).expect_err("32 samples");
    assert_eq!(
        error.to_string(),
        "32 samples are too short for one audio frame"
    );
    assert!(audio_features(&[]).is_err());
    let features = audio_features(&[0.5; 129]).expect("129 samples pad to 256");
    assert_eq!((features.frames, mask_soft_tokens(&features)), (1, 0));
    assert_eq!(audio_soft_tokens(129).expect("129"), 0);
    assert!(audio_soft_tokens(32).is_err());
    assert!(features.values.iter().all(|&v| v == 0.0));
}

/// Soft tokens the processor counts from the mask: every 4th frame that is valid.
fn mask_soft_tokens(features: &AudioFeatures) -> usize {
    features
        .mask
        .iter()
        .step_by(4)
        .filter(|&&valid| valid)
        .count()
}

/// A full window is the extractor's 480,000 samples, every frame valid: the 754 ids (750 soft
/// tokens) transformers.js gives 30 s.
#[test]
fn a_full_window_is_30_s_of_valid_frames() {
    let full = audio_features(&vec![0.25_f32; WINDOW_SAMPLES]).expect("30 s");
    assert_eq!((full.frames, mask_soft_tokens(&full)), (2_999, 750));
    assert!(full.mask.iter().all(|&valid| valid));
    assert_eq!(audio_soft_tokens(WINDOW_SAMPLES).expect("30 s"), 750);
}

/// The ids are counted from the length; the count equals the features' mask at every length.
#[test]
fn soft_tokens_from_the_length_equal_the_mask() {
    for samples in (129..2_000).chain([16_000, 16_197, 40_000, WINDOW_SAMPLES - 1]) {
        let features = audio_features(&vec![0.1_f32; samples]).expect("features");
        assert_eq!(
            audio_soft_tokens(samples).expect("count"),
            mask_soft_tokens(&features),
            "{samples} samples"
        );
    }
}

/// A window is at most [`WINDOW_SAMPLES`], so its features are bounded: one longer is refused
/// before anything is allocated, and its ids are refused alike.
#[test]
fn a_window_longer_than_30_s_is_refused() {
    let error = audio_features(&vec![0.0; WINDOW_SAMPLES + 1]).expect_err("30 s + 1");
    assert_eq!(
        error.to_string(),
        "480001 samples are longer than one 30 s window"
    );
    assert!(audio_soft_tokens(WINDOW_SAMPLES + 1).is_err());
}

/// 30 s windows cover the whole file up to [`MAX_WINDOWS`]: a 10 min recording is 20 windows.
#[test]
fn windows_cover_the_file_in_30_s_steps() {
    let ten_minutes = vec![0.0_f32; 600 * 16_000];
    let windows = audio_windows(&ten_minutes);
    assert_eq!(windows.len(), 20);
    assert!(windows.iter().all(|window| window.len() == WINDOW_SAMPLES));
    let past_the_cap = vec![0.0_f32; MAX_DECODED_SAMPLES + 16_000];
    assert_eq!(audio_windows(&past_the_cap).len(), MAX_WINDOWS);
}

#[test]
fn non_finite_samples_give_non_finite_features_not_a_panic() {
    let mut window = vec![0.25_f32; 16_000];
    window[100] = f32::NAN;
    window[200] = f32::INFINITY;
    let features = audio_features(&window).expect("features");
    assert!(features.values.iter().any(|v| !v.is_finite()));
}

/// The headers a malformed or hostile file can carry: any format, channel count, rate, width and
/// chunk size over a real file, then truncated anywhere.
fn mutated_wav() -> impl Strategy<Value = Vec<u8>> {
    (
        1_u16..5,
        prop::sample::select(vec![4_000_u32, 8_000, 16_000, 44_100, 1, 0, u32::MAX]),
        0_usize..300,
        prop::collection::vec((0_usize..HEADER, any::<u8>()), 0..6),
        any::<prop::sample::Index>(),
    )
        .prop_map(|(channels, rate, frames, edits, cut)| {
            let mut bytes = pcm16(channels, rate, frames);
            for (at, value) in edits {
                bytes[at] = value;
            }
            let keep = cut.index(bytes.len() + 1);
            bytes.truncate(keep.max(bytes.len().min(HEADER / 2)));
            bytes
        })
}

proptest! {
    #![proptest_config(proptest_config(512))]

    #[test]
    fn arbitrary_bytes_decode_or_fail_without_panic(tail in prop::collection::vec(any::<u8>(), 0..512)) {
        // A valid RIFF/WAVE header, so the bytes reach the chunk walk and the sample reader.
        let mut bytes = b"RIFF\0\0\0\0WAVE".to_vec();
        bytes.extend(tail);
        if let Ok(samples) = decode_wav(&bytes) {
            prop_assert!(samples.len() * 4 <= output_bound(bytes.len()));
        }
    }

    #[test]
    fn mutated_headers_decode_or_fail_without_panic(bytes in mutated_wav()) {
        if let Ok(samples) = decode_wav(&bytes) {
            prop_assert!(samples.len() * 4 <= output_bound(bytes.len()));
            if let Ok(features) = audio_features(&samples) {
                prop_assert_eq!(features.values.len(), features.frames * MEL_BINS);
            }
        }
    }
}
