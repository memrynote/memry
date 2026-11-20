//! Bounded decoding of untrusted vault images, in pure Rust: sharp's decode as Electron's
//! embedding worker and image-processing worker run it (sharp 0.35 on libvips 8.18): the first
//! frame, the EXIF orientation applied and an embedded ICC profile converted to sRGB.
//!
//! The bytes are untrusted vault files and the decode runs inside the app. Every limit is checked
//! from the headers before the pixel buffer is allocated, and a malformed file is a `DecodeError`,
//! never a panic. The checked peak counts the pixel buffers: the frame, the decoder's scratch beside
//! it (a progressive JPEG's coefficients, `scratch` for WebP and GIF) and the pipeline's copies
//! after it. A lossless WebP's Huffman tables, which grow with the file, not the image, are held
//! by image-webp's memory limit (`webp`) to what the frame and scratch leave: they are freed before
//! the pipeline's copies are made.

use std::io::Cursor;

use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{
    ColorType, DynamicImage, GenericImageView, ImageDecoder, ImageFormat, ImageReader, Limits,
    RgbImage, RgbaImage,
};
use zune_jpeg::zune_core::options::DecoderOptions;
use zune_jpeg::{ImageInfo as JpegInfo, JpegDecoder};

mod scratch;
mod webp;

/// Larger files are refused: the embedding projector's `MAX_IMAGE_BYTES`, which skips them before
/// reading.
pub const MAX_IMAGE_BYTES: usize = 30 * 1024 * 1024;

/// sharp's default `limitInputPixels` (0x3FFF squared): larger images fail to decode there.
const MAX_INPUT_PIXELS: u64 = 0x3FFF * 0x3FFF;

/// Ceiling on the pixel buffers one decode holds at once, from the decoder's frame to the last
/// copy: the frame plus the decoder's scratch while decoding (`scratch::decoder_scratch`, a
/// progressive JPEG's coefficients), then whichever copies the pipeline keeps beside it
/// (`decode_peak`, `fit_peak`). sharp has none below its pixel limit, so this refuses images
/// Electron would decode (bytes a pixel at the peak, then the megapixels refused above):
/// - `decode`: RGBA 7 (76.7), quarter-turned RGBA 8 (67), quarter-turned RGB 6 (89), Rgb16 9
///   (59.7), Rgba16 11 (48.8); `decode_fit`: RGBA 4 (134), GIF 5 (107).
/// - Both: lossless opaque WebP 7.875 (68); lossy WebP with a lossless-coded alpha plane, cwebp's
///   default, 11.375 (47.2); animated WebP, opaque or alpha, 11 or 12 (48.8 or 44.7); GIF whose
///   first frame is offset, 9 (59.6); GIF whose first frame is larger than the screen, the screen's
///   4 plus 5 a frame pixel.
/// - `decode` of a progressive JPEG: 9 (59.7), its coefficients charged at 2 bytes a pixel per
///   component, where sharp decodes up to its 268 megapixels. A 4:2:0 frame, whose chroma
///   zune-jpeg holds at a quarter, is charged about twice the coefficients it holds.
///
/// `Limits::max_alloc` caps each allocation on its own and not every decoder checks it before
/// allocating, so the sum is checked from the headers. Up to four decodes run at once in the app
/// (`memry-desktop`'s image pool).
const MAX_DECODE_ALLOC: u64 = 512 * 1024 * 1024;

/// Pixels `to_srgb` converts per pass: it copies this much, not the image.
const ICC_CHUNK_PIXELS: usize = 16 * 1024;

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

/// An image fitted for display: upright, at most `edge` on its long side, in 8-bit sRGB.
#[derive(Debug, Clone)]
pub struct Fitted {
    pub info: ImageInfo,
    /// The upright size before the fit.
    pub width: u32,
    pub height: u32,
    /// `ImageRgb8` for an image stored without alpha, otherwise `ImageRgba8`.
    pub image: DynamicImage,
}

/// One decoded frame as stored (the orientation not applied), before its colour profile is.
struct Frame {
    info: ImageInfo,
    image: DynamicImage,
    icc: Option<Vec<u8>>,
}

/// What the headers say about the frame, for the peak a pipeline reaches after the decode.
struct Header {
    width: u32,
    height: u32,
    color: ColorType,
    /// The frame buffer's bytes.
    frame: u64,
    orientation: Orientation,
}

impl Header {
    fn pixels(&self) -> u64 {
        u64::from(self.width) * u64::from(self.height)
    }

    /// Already 8-bit RGB or RGBA, so no copy converts it.
    fn is_rgb8(&self) -> bool {
        matches!(self.color, ColorType::Rgb8 | ColorType::Rgba8)
    }
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
    let Frame {
        info,
        mut image,
        icc,
    } = read_frame(bytes, decode_peak)?;
    image.apply_orientation(info.orientation);
    to_rgb8(image, icc.as_deref())
}

/// `decode`'s peak after the decode: a quarter turn's copy beside the frame, then the RGB copy
/// beside the turned frame (an RGB frame hands its buffer over).
fn decode_peak(header: &Header) -> u64 {
    let turned = if transposes(header.orientation) {
        header.frame
    } else {
        0
    };
    let rgb = if header.color == ColorType::Rgb8 {
        0
    } else {
        header.pixels() * 3
    };
    header.frame + turned.max(rgb)
}

/// sharp's `resize(edge, edge, { fit: 'inside', withoutEnlargement: true })` after the decode,
/// as the thumbnail, inbox and view image operations run it, keeping alpha. The work runs small:
/// an image over twice `edge` is first reduced to twice `edge` by an area average, then Lanczos3
/// takes it to the fitted size, and only then is it turned upright, cut to 8 bits (a 16-bit
/// sample keeps its high byte, as libvips casts) and converted by its profile. sharp converts the
/// profile before it resizes, so pixels differ by the order; sizes do not.
pub fn decode_fit(bytes: &[u8], edge: u32) -> Result<Fitted, DecodeError> {
    let Frame {
        info,
        mut image,
        icc,
    } = read_frame(bytes, |header| fit_peak(header, edge))?;
    let target = fit_size(info.width, info.height, edge);
    if let Some((width, height)) = prefilter_size(info.width, info.height, edge) {
        image = image.thumbnail_exact(width, height);
    }
    if image.dimensions() != target {
        image = image.resize_exact(target.0, target.1, FilterType::Lanczos3);
    }
    image.apply_orientation(info.orientation);
    let image = to_rgb8_keeping_alpha(image, icc.as_deref())?;
    let (width, height) = if transposes(info.orientation) {
        (info.height, info.width)
    } else {
        (info.width, info.height)
    };
    Ok(Fitted {
        info,
        width,
        height,
        image,
    })
}

/// A quarter turn: the upright size is the stored one turned, and the turn builds a new buffer
/// (the other orientations turn in place).
fn transposes(orientation: Orientation) -> bool {
    matches!(
        orientation,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    )
}

/// `decode_fit`'s peak after the decode, phase by phase: the prefilter's output beside the frame;
/// Lanczos3's `Rgba<f32>` pass (source width by fitted height) and its output beside its source;
/// a quarter turn's copy; the 8-bit copy. Each is a few megabytes for a thumbnail; with a large
/// `edge` and no resize they are the frame's size.
fn fit_peak(header: &Header, edge: u32) -> u64 {
    let area = |(width, height): (u32, u32)| u64::from(width) * u64::from(height);
    let pixel = u64::from(header.color.bytes_per_pixel());
    let stored = (header.width, header.height);
    let target = fit_size(header.width, header.height, edge);
    let mut peak = header.frame;
    let (source, source_bytes) = match prefilter_size(header.width, header.height, edge) {
        Some(size) => {
            peak = peak.max(header.frame + area(size) * pixel);
            (size, area(size) * pixel)
        }
        None => (stored, header.frame),
    };
    let out = if source == target {
        source_bytes
    } else {
        let out = area(target) * pixel;
        let pass = u64::from(source.0) * u64::from(target.1) * 16;
        peak = peak.max(source_bytes + pass + out);
        out
    };
    let turned = if transposes(header.orientation) {
        out
    } else {
        0
    };
    let rgba = if header.is_rgb8() {
        0
    } else {
        area(target) * 4
    };
    peak.max(out + turned).max(out + rgba)
}

/// The area-average reduction `decode_fit` runs first on an image over twice `edge`.
fn prefilter_size(width: u32, height: u32, edge: u32) -> Option<(u32, u32)> {
    (u64::from(width.max(height)) > 2 * u64::from(edge)).then(|| fit_size(width, height, edge * 2))
}

/// sharp's `fit: 'inside'` without enlargement: the long side becomes `edge` and the short side
/// is rounded, at least 1 (sharp 0.35.4, measured in `memry-desktop`'s `image_processing` tests).
/// The same either way round, so it sizes a stored frame as it sizes the upright one.
pub fn fit_size(width: u32, height: u32, edge: u32) -> (u32, u32) {
    if width <= edge && height <= edge {
        return (width, height);
    }
    let scale = |side: u32, long: u32| {
        ((f64::from(side) * f64::from(edge) / f64::from(long)).round() as u32).max(1)
    };
    if width >= height {
        (edge, scale(height, width))
    } else {
        (scale(width, height), edge)
    }
}

/// Every limit, the pipeline's peak after the decode (`after`) included, then the first frame.
fn read_frame(bytes: &[u8], after: impl FnOnce(&Header) -> u64) -> Result<Frame, DecodeError> {
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
        ImageFormat::WebP => {
            scratch::check_webp(bytes)?;
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
    let exif = decoder.exif_metadata().map_err(decode_error)?;
    let orientation = exif
        .as_deref()
        .and_then(Orientation::from_exif_chunk)
        .unwrap_or(Orientation::NoTransforms);
    // The decoders do not all check `Limits::max_alloc` before allocating the frame buffer, and
    // none checks the sum of it and the scratch it holds beside it.
    let header = Header {
        width,
        height,
        color: decoder.color_type(),
        frame: decoder.total_bytes(),
        orientation,
    };
    let scratch = coefficients + scratch::decoder_scratch(format, bytes, width, height);
    let decoding = header.frame.saturating_add(scratch);
    let peak = decoding.max(after(&header));
    if peak > MAX_DECODE_ALLOC {
        return Err(input(format!(
            "image needs {peak} bytes to decode, over the {MAX_DECODE_ALLOC}-byte limit"
        )));
    }
    let icc = decoder.icc_profile().map_err(decode_error)?;
    let info = ImageInfo {
        format,
        width,
        height,
        orientation,
        has_exif: exif.is_some(),
        has_icc: icc.is_some(),
    };
    let mut image = if format == ImageFormat::WebP {
        drop(decoder);
        webp::decode(bytes, &header, MAX_DECODE_ALLOC - decoding)?
    } else {
        DynamicImage::from_decoder(decoder).map_err(decode_error)?
    };
    if let (ImageFormat::Gif, DynamicImage::ImageRgba8(buffer)) = (format, &mut image) {
        // libnsgif writes a transparent pixel as zero in all four channels.
        for pixel in buffer.pixels_mut().filter(|pixel| pixel[3] == 0) {
            pixel.0 = [0; 4];
        }
    }
    Ok(Frame { info, image, icc })
}

/// Reads a JPEG's headers to its first scan, as `image` has zune-jpeg read them. Refuses one that
/// no end-of-image marker closes: entropy-coded data stuffs every 0xFF with a zero byte, so the
/// first `FF D9` after the first scan header is the marker, and an EXIF thumbnail's own markers sit
/// inside an APP segment before it. sharp fails on libjpeg's warning there; zune-jpeg would decode
/// the rest as grey.
///
/// Returns the bytes of the coefficient buffers zune-jpeg holds for a progressive frame
/// (`mcu_prog.rs`): per component, one `i16` per pixel of the MCU grid. The grid pads each side to
/// a multiple of 8 times the largest sampling factor (at most 4, so at most 31 pixels), and a
/// factor of 3 pads to 24, which no multiple of 32 bounds, so each side is charged 31 over. A
/// subsampled component is charged in full. A baseline frame decodes row by row and holds none.
fn jpeg_coefficient_bytes(bytes: &[u8]) -> Result<u64, DecodeError> {
    let (info, scan) = jpeg_headers(bytes)?;
    if !bytes[scan..].windows(2).any(|pair| pair == [0xFF, 0xD9]) {
        return Err(input("VipsJpeg: premature end of JPEG image"));
    }
    if !info.sof.is_progressive() {
        return Ok(0);
    }
    let pad = |side: u16| u64::from(side) + 31;
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
        DynamicImage::ImageRgba8(buffer) => widen(buffer.as_raw(), 4, false, |v| v),
        DynamicImage::ImageLuma8(buffer) => widen(buffer.as_raw(), 1, false, |v| v),
        DynamicImage::ImageRgb16(buffer) => widen(buffer.as_raw(), 3, false, shift16),
        DynamicImage::ImageRgba16(buffer) => widen(buffer.as_raw(), 4, false, shift16),
        DynamicImage::ImageLuma16(buffer) => widen(buffer.as_raw(), 1, false, shift16),
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

/// `decode_fit`'s 8-bit sRGB samples: RGB, or RGBA for an image with alpha. A grey value goes to
/// all three channels.
fn to_rgb8_keeping_alpha(
    image: DynamicImage,
    icc: Option<&[u8]>,
) -> Result<DynamicImage, DecodeError> {
    let (width, height) = image.dimensions();
    let alpha = image.color().has_alpha();
    let mut samples = match image {
        DynamicImage::ImageRgb8(buffer) => buffer.into_raw(),
        DynamicImage::ImageRgba8(buffer) => buffer.into_raw(),
        DynamicImage::ImageLuma8(buffer) => widen(buffer.as_raw(), 1, alpha, |v| v),
        DynamicImage::ImageLumaA8(buffer) => widen(buffer.as_raw(), 2, alpha, |v| v),
        DynamicImage::ImageRgb16(buffer) => widen(buffer.as_raw(), 3, alpha, shift16),
        DynamicImage::ImageRgba16(buffer) => widen(buffer.as_raw(), 4, alpha, shift16),
        DynamicImage::ImageLuma16(buffer) => widen(buffer.as_raw(), 1, alpha, shift16),
        DynamicImage::ImageLumaA16(buffer) => widen(buffer.as_raw(), 2, alpha, shift16),
        other => {
            return Err(input(format!(
                "unsupported pixel format {:?}",
                other.color()
            )));
        }
    };
    if let Some(profile) = icc {
        let layout = if alpha {
            moxcms::Layout::Rgba
        } else {
            moxcms::Layout::Rgb
        };
        to_srgb(&mut samples, profile, layout);
    }
    let image = if alpha {
        RgbaImage::from_raw(width, height, samples).map(DynamicImage::ImageRgba8)
    } else {
        RgbImage::from_raw(width, height, samples).map(DynamicImage::ImageRgb8)
    };
    image.ok_or_else(|| input("pixel buffer does not match the image size"))
}

/// 8-bit RGB, or RGBA with `alpha`, from samples of `channels` (1 or 2 grey, 3 or 4 colour, the
/// last one alpha when even or 4).
fn widen<T: Copy>(samples: &[T], channels: usize, alpha: bool, to_u8: impl Fn(T) -> u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() / channels * if alpha { 4 } else { 3 });
    for pixel in samples.chunks_exact(channels) {
        if channels < 3 {
            out.extend([to_u8(pixel[0]); 3]);
        } else {
            out.extend(pixel[..3].iter().map(|&v| to_u8(v)));
        }
        if alpha {
            out.push(to_u8(pixel[channels - 1]));
        }
    }
    out
}

/// sharp's `icc_transform` to sRGB with the perceptual intent, on `Rgb` or `Rgba` samples (alpha
/// is kept), in place through a buffer of `ICC_CHUNK_PIXELS`. libvips runs Little CMS; this runs moxcms, pure Rust (Kaan, 2026-11-13), whose output
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
    let channels = if layout == moxcms::Layout::Rgba { 4 } else { 3 };
    if !data.len().is_multiple_of(channels) {
        return dropped(&"samples are not whole pixels");
    }
    // moxcms fails only on lane sizes, and every chunk has whole pixels, so a failure comes on the
    // first chunk, before any pixel changed.
    let mut src = Vec::with_capacity(ICC_CHUNK_PIXELS * channels);
    for chunk in data.chunks_mut(ICC_CHUNK_PIXELS * channels) {
        src.clear();
        src.extend_from_slice(chunk);
        if let Err(error) = transform.transform(&src, chunk) {
            chunk.copy_from_slice(&src);
            return dropped(&error);
        }
    }
}

#[cfg(test)]
mod tests;
