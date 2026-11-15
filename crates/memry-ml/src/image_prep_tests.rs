//! Untrusted-input guards of `image_prep`'s tensor half (crates/AGENTS.md, Untrusted-input tests).
//! The decode's own guards live with it in `memry-media`.

use base64::Engine as _;
use memry_test_kit::{assert_steps_at_most, on_small_stack, proptest_config};
use proptest::prelude::*;

use super::*;

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
fn the_resize_interpolates_each_output_pixel_once() {
    let image = memry_media::decode(&fixture("png rgb @140")).expect("decode");
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
