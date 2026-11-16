//! Image preprocessing of Electron's embedding worker: `RawImage.fromBlob` (sharp 0.35 on libvips
//! 8.18), `RawImage.rgb()` and transformers.js 4.3.1's `Gemma4ImageProcessor` (aspect-preserving
//! bicubic resize, rescale by 1/255, 16x16 patches), so the vision encoder sees the same pixels.
//!
//! The decode (sharp's half) is `memry_media::decode`, which checks every limit of the untrusted
//! bytes before it allocates; this module is the tensor half.

/// The largest image file decoded (owned by `memry_media`), re-exported for the worker's
/// `EmbedImage` frame cap, which must equal it (`memry-ml-worker` asserts so).
pub use memry_media::MAX_IMAGE_BYTES;
use memry_media::Rgb8;

use crate::MlError;

/// `patch_size`, `pooling_kernel_size` and the patch width of `preprocessor_config.json`.
const PATCH_SIZE: usize = 16;
const POOLING_KERNEL: usize = 3;
pub(crate) const PATCH_DIM: usize = PATCH_SIZE * PATCH_SIZE * 3;

/// The soft-token budgets the worker uses are 140 and 280; this bounds the pixel tensor of a
/// caller's budget (1120 tokens: 10080 patches, 31 MB of f32).
pub const MAX_SOFT_TOKENS: usize = 1120;

/// The vision encoder's inputs for one image: `pixel_values` `[max_patches, 768]` and
/// `pixel_position_ids` `[max_patches, 2]`, padded with zeros and -1 past the real patches.
#[derive(Debug, Clone, PartialEq)]
pub struct PixelTensor {
    pub max_patches: usize,
    pub pixel_values: Vec<f32>,
    pub position_ids: Vec<i64>,
    pub num_soft_tokens: usize,
    /// The resized image the patches were cut from.
    pub resized: Rgb8,
}

fn input(message: impl Into<String>) -> MlError {
    MlError::Input(message.into())
}

/// `RawImage.fromBlob(...).rgb()` (`memry_media::decode`) then `Gemma4ImageProcessor` with
/// `max_soft_tokens`.
pub fn prepare(bytes: &[u8], max_soft_tokens: usize) -> Result<PixelTensor, MlError> {
    check_soft_tokens(max_soft_tokens)?;
    let image = memry_media::decode(bytes).map_err(|error| input(error.to_string()))?;
    pixel_tensor(image, max_soft_tokens)
}

fn check_soft_tokens(max_soft_tokens: usize) -> Result<(), MlError> {
    if (1..=MAX_SOFT_TOKENS).contains(&max_soft_tokens) {
        return Ok(());
    }
    Err(input(format!(
        "soft tokens must be 1 to {MAX_SOFT_TOKENS}, got {max_soft_tokens}"
    )))
}

/// `Gemma4ImageProcessor` on a decoded image: the aspect-preserving resize, then the patches.
pub fn pixel_tensor(image: Rgb8, max_soft_tokens: usize) -> Result<PixelTensor, MlError> {
    check_soft_tokens(max_soft_tokens)?;
    let max_patches = max_soft_tokens * POOLING_KERNEL * POOLING_KERNEL;
    let (height, width) = target_size(image.height, image.width, max_patches)?;
    let resized = if (height, width) == (image.height, image.width) {
        image
    } else {
        resize_bicubic(&image, width, height)
    };
    Ok(patchify(resized, max_patches))
}

/// `get_aspect_ratio_preserving_size`: `[height, width]`, multiples of 48 holding at most
/// `max_patches` 16x16 patches, in the same f64 operations as the JavaScript.
pub(crate) fn target_size(
    height: usize,
    width: usize,
    max_patches: usize,
) -> Result<(usize, usize), MlError> {
    let (h, w) = (height as f64, width as f64);
    let target_px = (max_patches * PATCH_SIZE * PATCH_SIZE) as f64;
    let factor = (target_px / (h * w)).sqrt();
    let side = (POOLING_KERNEL * PATCH_SIZE) as f64;
    let mut target_h = ((factor * h) / side).floor() * side;
    let mut target_w = ((factor * w) / side).floor() * side;
    if target_h == 0.0 && target_w == 0.0 {
        return Err(input(
            "Attempting to resize to a 0 x 0 image. Resized height should be divisible by \
             `pooling_kernel_size * patch_size`=48.",
        ));
    }
    let max_side = (max_patches / (POOLING_KERNEL * POOLING_KERNEL)) as f64 * side;
    if target_h == 0.0 {
        target_h = side;
        target_w = ((w / h).floor() * side).min(max_side);
    } else if target_w == 0.0 {
        target_w = side;
        target_h = ((h / w).floor() * side).min(max_side);
    }
    Ok((target_h as usize, target_w as usize))
}

/// libvips Catmull-Rom weights in 12-bit fixed point for 65 sub-pixel offsets
/// (`vips_interpolate_bicubic_class_init`): computed in f64, scaled and truncated.
fn bicubic_table() -> [[i32; 4]; 65] {
    let mut table = [[0_i32; 4]; 65];
    for (step, weights) in table.iter_mut().enumerate() {
        let x = f64::from(step as f32 / 64.0);
        let cr1 = 1.0 - x;
        let cr2 = -0.5 * x;
        let cr3 = cr1 * cr2;
        let cone = cr1 * cr3;
        let cfou = x * cr3;
        let cr4 = cfou - cone;
        let ctwo = cr1 - cone + cr4;
        let cthr = x - cfou - cr4;
        for (weight, value) in weights.iter_mut().zip([cone, ctwo, cthr, cfou]) {
            *weight = (value * 4096.0) as i32;
        }
    }
    table
}

#[cfg(test)]
thread_local! {
    static INTERPOLATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Output pixels the last resizes on this thread interpolated.
#[cfg(test)]
pub(crate) fn interpolations() -> usize {
    INTERPOLATIONS.with(std::cell::Cell::get)
}

/// `RawImage.resize(width, height, { resample: 3 })` in Node: sharp's `affine` with the scale
/// matrix and libvips' bicubic interpolator over a black border, in libvips' fixed-point
/// arithmetic (`resample/affine.c`, `bicubic.cpp`). The output is `width x height` because the
/// affine's output area rounds `W * (width / W)`.
pub(crate) fn resize_bicubic(src: &Rgb8, width: usize, height: usize) -> Rgb8 {
    const OFFSET: usize = 2; // window_offset + 1 border pixels on the left and top
    let table = bicubic_table();
    let sx = width as f64 / src.width as f64;
    let sy = height as f64 / src.height as f64;
    let det = sx * sy;
    let inverse = 1.0 / det;
    let (ia, id) = (inverse * sy, inverse * sx);
    let padded_w = src.width + 5;
    let padded_h = src.height + 5;
    // Embedded input: the image at (2, 2) inside a black border of 2 left/top and 3 right/bottom.
    let mut padded = vec![0_u8; padded_w * padded_h * 3];
    for y in 0..src.height {
        let row = (y + OFFSET) * padded_w + OFFSET;
        padded[row * 3..(row + src.width) * 3]
            .copy_from_slice(&src.data[y * src.width * 3..(y + 1) * src.width * 3]);
    }
    let mut out = Vec::with_capacity(width * height * 3);
    for y in 0..height {
        // libvips adds the border displacement and the window offset one at a time.
        let iy = (id * y as f64 + 1.0) + 1.0;
        let mut ix = 2.0;
        for _ in 0..width {
            interpolate(&padded, padded_w, &table, ix, iy, &mut out);
            ix += ia;
        }
    }
    #[cfg(test)]
    INTERPOLATIONS.with(|count| count.set(count.get() + width * height));
    Rgb8 {
        width,
        height,
        data: out,
    }
}

/// `vips_interpolate_bicubic_interpolate` on uchar: the 4x4 neighbourhood up and left of
/// (`x`, `y`), rows then columns, each rounded in 12-bit fixed point.
fn interpolate(
    padded: &[u8],
    padded_w: usize,
    table: &[[i32; 4]; 65],
    x: f64,
    y: f64,
    out: &mut Vec<u8>,
) {
    let mask = |v: f64| ((((v * 64.0 * 2.0) as i32) & 127) + 1) >> 1;
    let cx = &table[mask(x) as usize];
    let cy = &table[mask(y) as usize];
    let (left, top) = (x as usize - 1, y as usize - 1);
    let round = |v: i32| (v + 2048) >> 12;
    for band in 0..3 {
        let mut rows = [0_i32; 4];
        for (dy, row) in rows.iter_mut().enumerate() {
            let base = ((top + dy) * padded_w + left) * 3 + band;
            *row = round(
                (0..4)
                    .map(|dx| cx[dx] * i32::from(padded[base + dx * 3]))
                    .sum(),
            );
        }
        let value = round((0..4).map(|i| cy[i] * rows[i]).sum());
        out.push(value.clamp(0, 255) as u8);
    }
}

/// `patchify` after the rescale: patches in row-major patch order, each `(dy, dx, c)`, values
/// `sample * (1/255)` in f32 as `Float32Array` stores them; positions are `[column, row]`.
fn patchify(image: Rgb8, max_patches: usize) -> PixelTensor {
    let rescale = 0.003_921_568_627_450_98_f64;
    let patches_h = image.height / PATCH_SIZE;
    let patches_w = image.width / PATCH_SIZE;
    let mut pixel_values = vec![0.0_f32; max_patches * PATCH_DIM];
    let mut position_ids = vec![-1_i64; max_patches * 2];
    let mut out = 0;
    for ph in 0..patches_h {
        for pw in 0..patches_w {
            for dy in 0..PATCH_SIZE {
                let start = ((ph * PATCH_SIZE + dy) * image.width + pw * PATCH_SIZE) * 3;
                for &sample in &image.data[start..start + PATCH_SIZE * 3] {
                    pixel_values[out] = (f64::from(f32::from(sample)) * rescale) as f32;
                    out += 1;
                }
            }
        }
    }
    let mut index = 0;
    for row in 0..patches_h {
        for col in 0..patches_w {
            position_ids[index] = col as i64;
            position_ids[index + 1] = row as i64;
            index += 2;
        }
    }
    PixelTensor {
        max_patches,
        pixel_values,
        position_ids,
        num_soft_tokens: patches_h * patches_w / (POOLING_KERNEL * POOLING_KERNEL),
        resized: image,
    }
}

#[cfg(test)]
#[path = "image_prep_tests.rs"]
mod tests;
