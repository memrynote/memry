//! Untrusted-input guards of `image_prep` (crates/AGENTS.md, Untrusted-input tests). Each cap
//! test asserts the cap's own message, so it fails when the cap is removed and a later check
//! catches the input instead.

use base64::Engine as _;
use memry_test_kit::{assert_steps_at_most, on_small_stack, proptest_config};
use proptest::prelude::*;

use super::*;

/// A PNG declaring `width` x `height` RGBA at 8 bits whose image data is empty.
fn png_header(width: u32, height: u32) -> Vec<u8> {
    let mut ihdr = Vec::new();
    ihdr.extend(width.to_be_bytes());
    ihdr.extend(height.to_be_bytes());
    ihdr.extend([8, 6, 0, 0, 0]);
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    for (kind, data) in [
        (b"IHDR", ihdr),
        (b"IDAT", Vec::new()),
        (b"IEND", Vec::new()),
    ] {
        png.extend(png_chunk(kind, &data));
    }
    png
}

fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let body = [kind.as_slice(), data].concat();
    let mut chunk = u32::try_from(data.len())
        .expect("small")
        .to_be_bytes()
        .to_vec();
    chunk.extend(&body);
    chunk.extend(crc32(&body).to_be_bytes());
    chunk
}

/// A valid PNG with an `iCCP` chunk, after `IHDR`, whose zlib stream unpacks to `profile`.
fn png_with_profile(profile: &[u8]) -> Vec<u8> {
    let png = fixture("png rgb @140");
    let mut iccp = b"icc\0\0".to_vec();
    iccp.extend(fdeflate::compress_to_vec(profile));
    [&png[..33], &png_chunk(b"iCCP", &iccp), &png[33..]].concat()
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0_u32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xEDB8_8320 & (crc & 1).wrapping_neg());
        }
    }
    !crc
}

/// Valid inputs of `pixel-tensors.json` by case name.
fn fixture(name: &str) -> Vec<u8> {
    static FILE: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
    let file = FILE.get_or_init(|| {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/contracts/test-vectors/pixel-tensors.json");
        serde_json::from_slice(&std::fs::read(path).expect("pixel-tensors.json")).expect("json")
    });
    let case = file["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("no case {name}"));
    base64::engine::general_purpose::STANDARD
        .decode(case["input"].as_str().expect("input"))
        .expect("base64")
}

fn message(result: Result<PixelTensor, MlError>) -> String {
    result.expect_err("refused").to_string()
}

#[test]
fn a_file_over_the_byte_limit_is_refused_before_decoding() {
    let mut bytes = fixture("png rgb @140");
    bytes.resize(MAX_IMAGE_BYTES + 1, 0);
    assert!(message(prepare(&bytes, 1)).ends_with("-byte limit"));
}

#[test]
fn an_image_over_sharps_pixel_limit_is_refused_from_its_header() {
    for (width, height) in [(0x4000, 0x3FFF), (100_000, 100_000)] {
        assert_eq!(
            message(prepare(&png_header(width, height), 1)),
            "Input image exceeds pixel limit"
        );
    }
}

#[test]
fn an_image_whose_buffer_passes_the_allocation_cap_is_refused_before_allocating() {
    // 192 megapixels: under sharp's pixel limit, 768 MB of RGBA.
    assert_eq!(
        message(prepare(&png_header(16_000, 12_000), 1)),
        "image needs 768000000 bytes to decode, over the 536870912-byte limit"
    );
}

#[test]
fn a_png_profile_that_unpacks_past_10_mib_is_refused_before_decoding() {
    let bytes = png_with_profile(&vec![0; MAX_ICC_BYTES + 1]);
    assert!(bytes.len() < 64 * 1024, "{} bytes", bytes.len());
    assert_eq!(
        message(prepare(&bytes, 1)),
        "colour profile unpacks to more than 10485760 bytes"
    );
    assert!(prepare(&png_with_profile(&vec![0; MAX_ICC_BYTES]), 1).is_ok());
}

#[test]
fn a_progressive_jpegs_coefficient_buffers_count_toward_the_allocation_cap() {
    // 10000x10000: 300 MB of RGB fits the cap, the 602 MB of coefficients a progressive
    // decode holds besides it do not.
    let mut bytes = fixture("jpeg progressive @140");
    let sof = bytes
        .windows(2)
        .position(|pair| pair == [0xFF, 0xC2])
        .expect("SOF2");
    bytes[sof + 5..sof + 9].copy_from_slice(&[0x27, 0x10, 0x27, 0x10]);
    assert_eq!(
        message(prepare(&bytes, 1)),
        "image needs 901921536 bytes to decode, over the 536870912-byte limit"
    );
}

#[test]
fn a_fill_byte_before_the_frame_header_does_not_hide_a_progressive_jpegs_coefficients() {
    // 13000x13000 progressive: 507 MB of RGB fits the cap, its coefficients do not. `FF 00` after
    // the start marker is a fill byte to zune-jpeg; a walk that reads it as a segment skips
    // 0xFFDB bytes, where this file holds a scan and an end marker.
    let progressive = fixture("jpeg progressive @140");
    let mut bytes = [&[0xFF, 0xD8, 0xFF, 0x00], &progressive[2..]].concat();
    let sof = bytes
        .windows(2)
        .position(|pair| pair == [0xFF, 0xC2])
        .expect("SOF2");
    bytes[sof + 5..sof + 9].copy_from_slice(&[0x32, 0xC8, 0x32, 0xC8]);
    bytes.resize(4 + 0xFFDB, 0);
    bytes.extend([0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9]);
    assert_eq!(
        message(prepare(&bytes, 1)),
        "image needs 1524747456 bytes to decode, over the 536870912-byte limit"
    );
}

#[test]
fn a_frame_header_shorter_than_its_length_field_is_an_error() {
    for length in [0, 1] {
        let bytes = vec![0xFF, 0xD8, 0xFF, 0xC2, 0x00, length];
        let error = on_small_stack(move || prepare(&bytes, 1).err());
        assert!(error.is_some(), "length {length} decoded");
    }
}

#[test]
fn only_the_first_png_profile_is_unpacked() {
    // The `png` crate skips a second `iCCP` without unpacking it, so the image decodes.
    let png = png_with_profile(&[0; 128]);
    let mut bomb = b"icc\0\0".to_vec();
    bomb.extend(fdeflate::compress_to_vec(&vec![0; MAX_ICC_BYTES + 1]));
    let idat = png
        .windows(4)
        .position(|kind| kind == b"IDAT")
        .expect("IDAT")
        - 4;
    let bytes = [&png[..idat], &png_chunk(b"iCCP", &bomb), &png[idat..]].concat();
    assert!(prepare(&bytes, 1).is_ok());
}

#[test]
fn a_four_component_jpeg_is_cmyk() {
    let jpeg = fixture("jpeg 4:4:4 @140");
    assert!(!is_cmyk_jpeg(&jpeg));
    // One more component in the frame header: length 17 to 20, count 3 to 4.
    let sof = jpeg
        .windows(2)
        .position(|pair| pair == [0xFF, 0xC0])
        .expect("SOF0");
    let mut cmyk = jpeg[..sof + 19].to_vec();
    cmyk[sof + 3] = 20;
    cmyk[sof + 9] = 4;
    cmyk.extend([4, 0x11, 0]);
    cmyk.extend(&jpeg[sof + 19..]);
    assert!(is_cmyk_jpeg(&cmyk));
}

#[test]
fn soft_token_budgets_outside_1_to_1120_are_refused() {
    let bytes = fixture("png rgb @140");
    for budget in [0, MAX_SOFT_TOKENS + 1] {
        assert_eq!(
            message(prepare(&bytes, budget)),
            format!("soft tokens must be 1 to 1120, got {budget}")
        );
    }
    assert!(prepare(&bytes, MAX_SOFT_TOKENS).is_ok());
}

#[test]
fn zero_size_wrong_magic_and_truncated_inputs_are_errors() {
    let png = fixture("png rgb @140");
    let jpeg = fixture("jpeg 4:2:0 @140");
    let cases: [(&str, Vec<u8>); 6] = [
        ("empty", Vec::new()),
        ("zero width", png_header(0, 8)),
        (
            "png body behind a GIF magic",
            [b"GIF89a", &png[6..]].concat(),
        ),
        ("png truncated", png[..png.len() / 2].to_vec()),
        ("jpeg truncated", jpeg[..jpeg.len() / 2].to_vec()),
        (
            "jpeg without its end marker",
            jpeg[..jpeg.len() - 2].to_vec(),
        ),
    ];
    for (name, bytes) in cases {
        let error = on_small_stack(move || prepare(&bytes, 140).err());
        assert!(error.is_some(), "{name} decoded");
    }
}

#[test]
fn the_resize_interpolates_each_output_pixel_once() {
    let image = decode(&fixture("png rgb @140")).expect("decode");
    for budget in [1, 140, 280] {
        let image = image.clone();
        on_small_stack(move || {
            let max_patches = budget * POOLING_KERNEL * POOLING_KERNEL;
            let bound = max_patches * PATCH_SIZE * PATCH_SIZE;
            assert_steps_at_most("resize", interpolations, bound, || {
                pixel_tensor(image, budget).expect("tensor");
            });
        });
    }
}

/// Each format, and the inputs whose ICC profile (`p3`) or EXIF orientation the decode reads.
const VALID: [&str; 9] = [
    "png rgba @140",
    "jpeg progressive @140",
    "webp lossy @140",
    "gif animated @140",
    "png 16-bit @140",
    "png p3 profile @140",
    "jpeg p3 profile @140",
    "webp p3 profile @140",
    "jpeg orientation 6 @140",
];

/// The Display P3 profile sharp embeds.
fn p3_profile() -> Vec<u8> {
    let bytes = fixture("png p3 profile @140");
    let reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), ImageFormat::Png);
    reader
        .into_decoder()
        .expect("decoder")
        .icc_profile()
        .expect("profile")
        .expect("p3")
}

proptest! {
    #![proptest_config(proptest_config(256))]

    /// Any bytes, and valid images with bytes overwritten or cut, decode or fail; a tensor
    /// always has the budget's size and holds at most that many pixels.
    #[test]
    fn mutated_images_never_panic_and_tensors_stay_within_the_budget(
        which in 0..VALID.len() + 1,
        edits in proptest::collection::vec((any::<prop::sample::Index>(), any::<u8>()), 0..8),
        cut in any::<prop::sample::Index>(),
        random in proptest::collection::vec(any::<u8>(), 0..512),
        budget in 1_usize..=8,
    ) {
        let mut bytes = if which == VALID.len() { random } else { fixture(VALID[which]) };
        if !bytes.is_empty() {
            for (index, value) in &edits {
                let at = index.index(bytes.len());
                bytes[at] = *value;
            }
            if edits.len() % 2 == 1 {
                bytes.truncate(cut.index(bytes.len()) + 1);
            }
        }
        let outcome = on_small_stack(move || prepare(&bytes, budget));
        if let Ok(tensor) = outcome {
            let max_patches = budget * POOLING_KERNEL * POOLING_KERNEL;
            prop_assert_eq!(tensor.pixel_values.len(), max_patches * PATCH_DIM);
            prop_assert_eq!(tensor.position_ids.len(), max_patches * 2);
            prop_assert!(tensor.resized.width * tensor.resized.height <= max_patches * 256);
        }
    }

    /// A profile with bytes overwritten or cut converts or is ignored, never panics, and leaves
    /// the pixel count unchanged.
    #[test]
    fn mutated_profiles_never_panic(
        edits in proptest::collection::vec((any::<prop::sample::Index>(), any::<u8>()), 1..16),
        cut in any::<prop::sample::Index>(),
        pixels in proptest::collection::vec(any::<u8>(), 0..64),
    ) {
        let mut profile = p3_profile();
        for (index, value) in &edits {
            let at = index.index(profile.len());
            profile[at] = *value;
        }
        if edits.len() % 2 == 0 {
            profile.truncate(cut.index(profile.len()) + 1);
        }
        let mut data = pixels[..pixels.len() / 3 * 3].to_vec();
        let len = data.len();
        on_small_stack(move || {
            to_srgb(&mut data, &profile);
            assert_eq!(data.len(), len);
        });
    }
}
