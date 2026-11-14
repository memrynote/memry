//! Image preprocessing of Electron's embedding worker: `RawImage.fromBlob` (sharp 0.35 on libvips
//! 8.18), `RawImage.rgb()` and transformers.js 4.3.1's `Gemma4ImageProcessor` (aspect-preserving
//! bicubic resize, rescale by 1/255, 16x16 patches), so the vision encoder sees the same pixels.
//!
//! The bytes are untrusted vault files. Every limit is checked before the pixel buffer is
//! allocated, and a malformed file is an `MlError::Input`, never a panic.

use std::io::Cursor;

use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use zune_jpeg::zune_core::options::DecoderOptions;
use zune_jpeg::{ImageInfo, JpegDecoder};

use crate::MlError;

/// Larger files are refused: the projector's `MAX_IMAGE_BYTES`, which skips them before reading.
pub const MAX_IMAGE_BYTES: usize = 30 * 1024 * 1024;

/// sharp's default `limitInputPixels` (0x3FFF squared): larger images fail to decode there.
const MAX_INPUT_PIXELS: u64 = 0x3FFF * 0x3FFF;

/// Ceiling on what one decode holds at its peak: the frame buffer, plus the coefficients of a
/// progressive JPEG. sharp has none below its pixel limit; this refuses an RGBA image above 128
/// megapixels, which Electron would still decode. `Limits::max_alloc` caps each allocation on its
/// own and not every decoder checks it before allocating, so `decode` checks the sum from the
/// headers. The buffers after the decode (the RGB copy, the copy `to_srgb` converts from, the
/// resize's padded input) are each at most the frame buffer's size.
const MAX_DECODE_ALLOC: u64 = 512 * 1024 * 1024;

/// Larger colour profiles are refused. A PNG stores its profile deflated, so a few kilobytes can
/// unpack to the whole allocation cap; JPEG and WebP store it as is, within `MAX_IMAGE_BYTES`.
pub(crate) const MAX_ICC_BYTES: usize = 10 * 1024 * 1024;

/// `patch_size`, `pooling_kernel_size` and the patch width of `preprocessor_config.json`.
const PATCH_SIZE: usize = 16;
const POOLING_KERNEL: usize = 3;
pub(crate) const PATCH_DIM: usize = PATCH_SIZE * PATCH_SIZE * 3;

/// The soft-token budgets the worker uses are 140 and 280; this bounds the pixel tensor of a
/// caller's budget (1120 tokens: 10080 patches, 31 MB of f32).
pub const MAX_SOFT_TOKENS: usize = 1120;

/// An 8-bit RGB image, rows top to bottom, `width * height * 3` bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rgb8 {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

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

/// `RawImage.fromBlob(...).rgb()` then `Gemma4ImageProcessor` with `max_soft_tokens`.
pub fn prepare(bytes: &[u8], max_soft_tokens: usize) -> Result<PixelTensor, MlError> {
    check_soft_tokens(max_soft_tokens)?;
    pixel_tensor(decode(bytes)?, max_soft_tokens)
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

/// `RawImage.fromBlob` then `.rgb()`: sharp decodes the first frame, applies the EXIF
/// orientation, converts an embedded ICC profile to sRGB and writes 8-bit samples; transformers.js
/// then drops alpha.
///
/// Known differences from sharp besides the JPEG and ICC levels (test-vectors README): TIFF, AVIF,
/// HEIF and the other formats libvips reads are refused (a vault image is PNG, JPEG, GIF or WebP);
/// zune-jpeg runs with `strict_mode` off as `image` sets it, so of libjpeg's warnings only the
/// missing end marker is refused; a grey or CMYK profile is dropped where libvips converts through
/// it; a CMYK or YCCK JPEG (`is_cmyk_jpeg`) is converted to RGB by zune-jpeg's naive formula and
/// its profile dropped, where libvips converts through the embedded or its built-in CMYK profile
/// (Kaan, 2026-11-14: accepted; up to 46 levels and cosine 0.977 to 0.986, held to 0.97 by the
/// `cmyk` and `cmyk+icc` vectors); and a 16-bit image is cut to 8 bits before its profile applies, where
/// libvips converts at 16 bits.
pub fn decode(bytes: &[u8]) -> Result<Rgb8, MlError> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(input(format!(
            "image is {} bytes, over the {MAX_IMAGE_BYTES}-byte limit",
            bytes.len()
        )));
    }
    let format = image::guess_format(bytes).map_err(|_| input("unsupported image format"))?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP
    ) {
        return Err(input(format!("unsupported image format {format:?}")));
    }
    let coefficients = match format {
        ImageFormat::Jpeg => jpeg_coefficient_bytes(bytes)?,
        ImageFormat::Png => {
            check_png_profile(bytes)?;
            0
        }
        _ => 0,
    };
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);
    let decode_error = |error: image::ImageError| input(format!("cannot decode image: {error}"));
    let mut decoder = reader.into_decoder().map_err(decode_error)?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 {
        return Err(input("image has no pixels"));
    }
    if u64::from(width) * u64::from(height) > MAX_INPUT_PIXELS {
        return Err(input("Input image exceeds pixel limit".to_owned()));
    }
    // The decoders do not all check `Limits::max_alloc` before allocating the frame buffer, and a
    // progressive JPEG holds its coefficients besides it.
    let peak = decoder.total_bytes().saturating_add(coefficients);
    if peak > MAX_DECODE_ALLOC {
        return Err(input(format!(
            "image needs {peak} bytes to decode, over the {MAX_DECODE_ALLOC}-byte limit"
        )));
    }
    let orientation = decoder.orientation().map_err(decode_error)?;
    let icc = decoder.icc_profile().map_err(decode_error)?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(decode_error)?;
    if let (ImageFormat::Gif, DynamicImage::ImageRgba8(buffer)) = (format, &mut image) {
        // libnsgif writes a transparent pixel as zero in all four channels.
        for pixel in buffer.pixels_mut().filter(|pixel| pixel[3] == 0) {
            pixel.0 = [0; 4];
        }
    }
    image.apply_orientation(orientation);
    to_rgb8(image, icc.as_deref())
}

/// Reads a JPEG's headers to its first scan, as `image` has zune-jpeg read them. Refuses one that
/// no end-of-image marker closes: entropy-coded data stuffs every 0xFF with a zero byte, so the
/// first `FF D9` after the first scan header is the marker, and an EXIF thumbnail's own markers sit
/// inside an APP segment before it. sharp fails on libjpeg's warning there; zune-jpeg would decode
/// the rest as grey.
///
/// Returns the bytes of the coefficient buffers zune-jpeg holds for a progressive frame
/// (`mcu_prog.rs`): per component, one `i16` per pixel of the MCU grid, which sampling factors of
/// up to 4 pad to a multiple of 32. A baseline frame decodes row by row and holds none.
fn jpeg_coefficient_bytes(bytes: &[u8]) -> Result<u64, MlError> {
    let (info, scan) = jpeg_headers(bytes)?;
    if !bytes[scan..].windows(2).any(|pair| pair == [0xFF, 0xD9]) {
        return Err(input("VipsJpeg: premature end of JPEG image"));
    }
    if !info.sof.is_progressive() {
        return Ok(0);
    }
    let pad = |side: u16| u64::from(side).next_multiple_of(32);
    Ok(u64::from(info.components) * 2 * pad(info.width) * pad(info.height))
}

/// Whether a JPEG is CMYK or YCCK (four components). `decode` converts one with zune-jpeg's naive
/// formula, not through a profile as libvips does (an accepted divergence, see `decode`).
pub fn is_cmyk_jpeg(bytes: &[u8]) -> bool {
    jpeg_headers(bytes).is_ok_and(|(info, _)| info.components == 4)
}

/// The frame of a JPEG and the offset its first scan's data starts at.
fn jpeg_headers(bytes: &[u8]) -> Result<(ImageInfo, usize), MlError> {
    let options = DecoderOptions::default()
        .set_strict_mode(false)
        .set_max_width(usize::MAX)
        .set_max_height(usize::MAX);
    let mut stream = Cursor::new(bytes);
    let info = {
        let mut decoder = JpegDecoder::new_with_options(&mut stream, options);
        decoder
            .decode_headers()
            .map_err(|error| input(format!("cannot decode image: {error}")))?;
        decoder
            .info()
            .ok_or_else(|| input("JPEG has no frame header"))?
    };
    let scan = usize::try_from(stream.position()).unwrap_or(bytes.len());
    Ok((info, scan.min(bytes.len())))
}

/// Refuses a PNG whose `iCCP` profile unpacks past `MAX_ICC_BYTES`. The `png` crate inflates the
/// profile while reading the header, up to the whole allocation cap, and drops one it cannot
/// read; a few kilobytes of zlib can unpack to hundreds of megabytes.
fn check_png_profile(bytes: &[u8]) -> Result<(), MlError> {
    let mut at = 8;
    while let Some(header) = bytes.get(at..at + 8) {
        let length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        let data = bytes.get(at + 8..).unwrap_or_default();
        let data = &data[..length.min(data.len())];
        match &header[4..] {
            b"IDAT" => break,
            b"iCCP" => {
                // Keyword, NUL, compression method, then the zlib stream.
                let Some(name_end) = data.iter().position(|&byte| byte == 0) else {
                    break;
                };
                let stream = data.get(name_end + 2..).unwrap_or_default();
                if let Err(fdeflate::BoundedDecompressionError::OutputTooLarge { .. }) =
                    fdeflate::decompress_to_vec_bounded(stream, MAX_ICC_BYTES)
                {
                    return Err(input(format!(
                        "colour profile unpacks to more than {MAX_ICC_BYTES} bytes"
                    )));
                }
                // The `png` crate skips a second one without unpacking it.
                break;
            }
            _ => {}
        }
        at += 12 + length;
    }
    Ok(())
}

/// The 8-bit RGB samples transformers.js keeps. sharp writes a grey image as RGB and
/// `loadImageFunction` turns it back into one channel (`convert(1)`), which `.rgb()` repeats: the
/// grey value in all three. A grey image with alpha comes out of sharp with four channels, and
/// `convert(2)` throws, so Electron embeds none.
fn to_rgb8(image: DynamicImage, icc: Option<&[u8]>) -> Result<Rgb8, MlError> {
    let (width, height) = (image.width() as usize, image.height() as usize);
    let mut data = match image {
        DynamicImage::ImageRgb8(buffer) => buffer.into_raw(),
        DynamicImage::ImageRgba8(buffer) => drop_alpha(buffer.as_raw(), 4, |v| v),
        DynamicImage::ImageLuma8(buffer) => grey_to_rgb(buffer.as_raw(), 1, |v| v),
        DynamicImage::ImageRgb16(buffer) => drop_alpha(buffer.as_raw(), 3, shift16),
        DynamicImage::ImageRgba16(buffer) => drop_alpha(buffer.as_raw(), 4, shift16),
        DynamicImage::ImageLuma16(buffer) => grey_to_rgb(buffer.as_raw(), 1, shift16),
        DynamicImage::ImageLumaA8(_) | DynamicImage::ImageLumaA16(_) => {
            return Err(input(
                "Conversion failed due to unsupported number of channels: 4",
            ));
        }
        other => {
            return Err(input(format!(
                "unsupported pixel format {:?}",
                other.color()
            )));
        }
    };
    if let Some(profile) = icc {
        to_srgb(&mut data, profile);
    }
    Ok(Rgb8 {
        width,
        height,
        data,
    })
}

/// libvips casts 16-bit samples to 8 bits by dropping the low byte.
fn shift16(value: u16) -> u8 {
    (value >> 8) as u8
}

fn drop_alpha<T: Copy>(samples: &[T], channels: usize, to_u8: impl Fn(T) -> u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() / channels * 3);
    for pixel in samples.chunks_exact(channels) {
        out.extend(pixel[..3].iter().map(|&v| to_u8(v)));
    }
    out
}

fn grey_to_rgb<T: Copy>(samples: &[T], channels: usize, to_u8: impl Fn(T) -> u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() / channels * 3);
    for pixel in samples.chunks_exact(channels) {
        let grey = to_u8(pixel[0]);
        out.extend([grey, grey, grey]);
    }
    out
}

/// sharp's `icc_transform` to sRGB with the perceptual intent. libvips runs Little CMS; this runs
/// moxcms, pure Rust (Kaan, 2026-11-13), whose output differs by a level or two in a channel
/// (`maxLevelDiff` of `pixel-tensors.json`). A profile moxcms cannot read is ignored, as sharp
/// ignores an invalid one; so is one that is not RGB, which libvips would apply (`decode`). Each
/// dropped profile is logged.
fn to_srgb(data: &mut [u8], profile: &[u8]) {
    use moxcms::{ColorProfile, DataColorSpace, Layout, RenderingIntent, TransformOptions};
    let dropped = |reason: &dyn std::fmt::Display| {
        tracing::warn!(bytes = profile.len(), %reason, "image colour profile ignored");
    };
    let source = match ColorProfile::new_from_slice(profile) {
        Ok(source) => source,
        Err(error) => return dropped(&error),
    };
    if source.color_space != DataColorSpace::Rgb {
        return dropped(&format_args!("{:?} profile", source.color_space));
    }
    let options = TransformOptions {
        rendering_intent: RenderingIntent::Perceptual,
        ..TransformOptions::default()
    };
    let transform = match source.create_transform_8bit(
        Layout::Rgb,
        &ColorProfile::new_srgb(),
        Layout::Rgb,
        options,
    ) {
        Ok(transform) => transform,
        Err(error) => return dropped(&error),
    };
    let src = data.to_vec();
    if let Err(error) = transform.transform(&src, data) {
        data.copy_from_slice(&src);
        dropped(&error);
    }
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
