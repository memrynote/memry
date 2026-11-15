//! Bounded decoding of untrusted vault images, in pure Rust: sharp's decode as Electron's
//! embedding worker and image-processing worker run it (sharp 0.35 on libvips 8.18): the first
//! frame, the EXIF orientation applied and an embedded ICC profile converted to sRGB.
//!
//! The bytes are untrusted vault files. Every limit is checked before the pixel buffer is
//! allocated, and a malformed file is a `DecodeError`, never a panic.

use std::io::Cursor;

use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits, RgbaImage};
use zune_jpeg::zune_core::options::DecoderOptions;
use zune_jpeg::{ImageInfo as JpegInfo, JpegDecoder};

/// Larger files are refused: the embedding projector's `MAX_IMAGE_BYTES`, which skips them before
/// reading.
pub const MAX_IMAGE_BYTES: usize = 30 * 1024 * 1024;

/// sharp's default `limitInputPixels` (0x3FFF squared): larger images fail to decode there.
const MAX_INPUT_PIXELS: u64 = 0x3FFF * 0x3FFF;

/// Ceiling on what one decode holds at its peak: the frame buffer, plus the coefficients of a
/// progressive JPEG. sharp has none below its pixel limit; this refuses an RGBA image above 128
/// megapixels, which Electron would still decode. `Limits::max_alloc` caps each allocation on its
/// own and not every decoder checks it before allocating, so `decode` checks the sum from the
/// headers. The buffers after the decode (the RGB or RGBA copy, the copy `to_srgb` converts from)
/// are each at most the frame buffer's size.
const MAX_DECODE_ALLOC: u64 = 512 * 1024 * 1024;

/// Larger colour profiles are refused. A PNG stores its profile deflated, so a few kilobytes can
/// unpack to the whole allocation cap; JPEG and WebP store it as is, within `MAX_IMAGE_BYTES`.
pub const MAX_ICC_BYTES: usize = 10 * 1024 * 1024;

/// Why an image was not decoded. The message is sharp's where Electron surfaces one.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct DecodeError(String);

fn input(message: impl Into<String>) -> DecodeError {
    DecodeError(message.into())
}

/// An 8-bit RGB image, rows top to bottom, `width * height * 3` bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rgb8 {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

/// What sharp's `metadata()` reports of an image: the format, the stored size (before the EXIF
/// orientation turns it) and whether it carries EXIF or a colour profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageInfo {
    pub format: ImageFormat,
    pub width: u32,
    pub height: u32,
    pub orientation: Orientation,
    pub has_exif: bool,
    pub has_icc: bool,
}

/// One decoded frame, upright, before its colour profile is applied.
struct Frame {
    info: ImageInfo,
    image: DynamicImage,
    icc: Option<Vec<u8>>,
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
pub fn decode(bytes: &[u8]) -> Result<Rgb8, DecodeError> {
    let frame = read_frame(bytes)?;
    to_rgb8(frame.image, frame.icc.as_deref())
}

/// `decode` keeping alpha: sharp's pipeline before a resize, as the thumbnail, inbox and view
/// image operations run it. A 16-bit image is scaled to 8 bits before its profile applies.
pub fn decode_rgba(bytes: &[u8]) -> Result<(ImageInfo, RgbaImage), DecodeError> {
    let Frame { info, image, icc } = read_frame(bytes)?;
    let mut rgba = image.into_rgba8();
    if let Some(profile) = icc {
        to_srgb(rgba.as_mut(), &profile, moxcms::Layout::Rgba);
    }
    Ok((info, rgba))
}

/// Every limit, then the first frame, upright.
fn read_frame(bytes: &[u8]) -> Result<Frame, DecodeError> {
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
    let exif = decoder.exif_metadata().map_err(decode_error)?;
    let orientation = exif
        .as_deref()
        .and_then(Orientation::from_exif_chunk)
        .unwrap_or(Orientation::NoTransforms);
    let icc = decoder.icc_profile().map_err(decode_error)?;
    let info = ImageInfo {
        format,
        width,
        height,
        orientation,
        has_exif: exif.is_some(),
        has_icc: icc.is_some(),
    };
    let mut image = DynamicImage::from_decoder(decoder).map_err(decode_error)?;
    if let (ImageFormat::Gif, DynamicImage::ImageRgba8(buffer)) = (format, &mut image) {
        // libnsgif writes a transparent pixel as zero in all four channels.
        for pixel in buffer.pixels_mut().filter(|pixel| pixel[3] == 0) {
            pixel.0 = [0; 4];
        }
    }
    image.apply_orientation(orientation);
    Ok(Frame { info, image, icc })
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
fn jpeg_coefficient_bytes(bytes: &[u8]) -> Result<u64, DecodeError> {
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
fn jpeg_headers(bytes: &[u8]) -> Result<(JpegInfo, usize), DecodeError> {
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
fn check_png_profile(bytes: &[u8]) -> Result<(), DecodeError> {
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
fn to_rgb8(image: DynamicImage, icc: Option<&[u8]>) -> Result<Rgb8, DecodeError> {
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
        to_srgb(&mut data, profile, moxcms::Layout::Rgb);
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

/// sharp's `icc_transform` to sRGB with the perceptual intent, on `Rgb` or `Rgba` samples (alpha
/// is kept). libvips runs Little CMS; this runs moxcms, pure Rust (Kaan, 2026-11-13), whose output
/// differs by a level or two in a channel (`maxLevelDiff` of `pixel-tensors.json`). A profile
/// moxcms cannot read is ignored, as sharp ignores an invalid one; so is one that is not RGB, which
/// libvips would apply (`decode`). Each dropped profile is logged.
fn to_srgb(data: &mut [u8], profile: &[u8], layout: moxcms::Layout) {
    use moxcms::{ColorProfile, DataColorSpace, RenderingIntent, TransformOptions};
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
    let transform =
        match source.create_transform_8bit(layout, &ColorProfile::new_srgb(), layout, options) {
            Ok(transform) => transform,
            Err(error) => return dropped(&error),
        };
    let src = data.to_vec();
    if let Err(error) = transform.transform(&src, data) {
        data.copy_from_slice(&src);
        dropped(&error);
    }
}

#[cfg(test)]
mod tests;
