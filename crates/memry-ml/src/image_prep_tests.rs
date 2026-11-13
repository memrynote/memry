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
        let chunk = [kind.as_slice(), &data].concat();
        png.extend(u32::try_from(data.len()).expect("small").to_be_bytes());
        png.extend(&chunk);
        png.extend(crc32(&chunk).to_be_bytes());
    }
    png
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

const VALID: [&str; 5] = [
    "png rgba @140",
    "jpeg progressive @140",
    "webp lossy @140",
    "gif animated @140",
    "png 16-bit @140",
];

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
}
