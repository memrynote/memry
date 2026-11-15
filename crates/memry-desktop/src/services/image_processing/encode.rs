//! The operations of Electron's image-processing worker (`image-processing/operations.ts`) on
//! `memry_media`'s bounded decode, encoded with `image`'s pure-Rust encoders.
//!
//! Known differences from sharp: thumbnails are lossless WebP (`image` has no lossy WebP encoder;
//! Kaan's R3 on #3542), so the format and the size match and the file is larger; an EXIF-rotated
//! image's thumbnail and inbox thumbnail come out upright, where sharp without `.rotate()` keeps the
//! stored orientation; SVG gets no thumbnail (no rasteriser is linked); the resize is Lanczos3
//! where sharp reduces with its own kernel, so pixels differ and sizes do not; and an image the
//! decode refuses (over 30 MiB, a JPEG without its end marker) has no inbox metadata, where sharp
//! still read its header.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::codecs::webp::WebPEncoder;
use image::imageops::{self, FilterType};
use image::{ExtendedColorType, ImageEncoder, ImageFormat, RgbaImage};
use memry_media::{MAX_IMAGE_BYTES, decode_rgba};

use super::{ImageError, InboxImage, Thumbnail, ViewImage};

/// `MAX_THUMBNAIL_DIMENSION` (`operations.ts:16`).
pub(super) const THUMBNAIL_EDGE: u32 = 200;
/// `MAX_INBOX_THUMBNAIL_DIMENSION` (`operations.ts:17`).
const INBOX_EDGE: u32 = 400;
const INBOX_JPEG_QUALITY: u8 = 80;
/// A larger PNG goes out as JPEG, which keeps one agent image near a megabyte (`operations.ts:18-20`).
const VIEW_IMAGE_PNG_MAX_BYTES: usize = 1024 * 1024;
const VIEW_IMAGE_JPEG_QUALITY: u8 = 85;

/// `generatePdfPlaceholder` (`operations.ts:162-184`), rendered once by
/// `apps/desktop-tauri/scripts/generate-pdf-badge.mjs`.
pub(super) const PDF_BADGE: &[u8] = include_bytes!("../../../assets/pdf-badge.webp");
pub(super) const PDF_BADGE_SIZE: (u32, u32) = (160, 200);

/// Reads at most one byte past the decode's cap, so a larger file is refused by the decode without
/// being read whole.
pub(super) fn read_bounded(path: &Path) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// `generateImageThumbnail` (`operations.ts:144-160`): the long edge at most 200, as WebP.
pub(super) fn thumbnail(bytes: &[u8]) -> Result<Thumbnail, ImageError> {
    let (_, image) = decode_rgba(bytes)?;
    webp(&fit_inside(&image, THUMBNAIL_EDGE))
}

/// The WebP of an image, sized as it is (the video frame ffmpeg already scaled).
pub(super) fn webp(image: &RgbaImage) -> Result<Thumbnail, ImageError> {
    let mut data = Vec::new();
    let (width, height) = image.dimensions();
    WebPEncoder::new_lossless(&mut data)
        .encode(image.as_raw(), width, height, ExtendedColorType::Rgba8)
        .map_err(encode_error)?;
    Ok(Thumbnail {
        data,
        width,
        height,
    })
}

/// `processInboxImageFile` (`operations.ts:40-74`): the stored size and metadata, and a JPEG at
/// most 400 px on its long edge. A thumbnail that fails to encode is logged and left out.
pub(super) fn inbox_image(bytes: &[u8]) -> Result<InboxImage, ImageError> {
    let (info, image) = decode_rgba(bytes)?;
    let thumbnail_jpeg = jpeg(
        &fit_inside(&image, INBOX_EDGE),
        [0, 0, 0],
        INBOX_JPEG_QUALITY,
    )
    .inspect_err(|error| tracing::warn!(%error, "inbox image thumbnail generation failed"))
    .ok();
    Ok(InboxImage {
        format: sharp_format(info.format),
        width: info.width,
        height: info.height,
        has_exif: info.has_exif || info.has_icc,
        thumbnail_jpeg,
    })
}

/// `prepareViewImage` (`operations.ts:76-121`): upright, the long edge at most `max_edge`, as PNG,
/// or as JPEG on white when the PNG would pass 1 MiB. An animated image gives its first frame.
pub(super) fn view_image(bytes: &[u8], max_edge: u32) -> Result<ViewImage, ImageError> {
    if max_edge == 0 {
        return Err(ImageError::Encode("the view image edge is 0".to_owned()));
    }
    let (_, image) = decode_rgba(bytes)?;
    let resized = fit_inside(&image, max_edge);
    let (width, height) = resized.dimensions();
    let png = png(&resized)?;
    let (data, mime_type) = if png.len() <= VIEW_IMAGE_PNG_MAX_BYTES {
        (png, "image/png")
    } else {
        let jpeg = jpeg(&resized, [255, 255, 255], VIEW_IMAGE_JPEG_QUALITY)?;
        (jpeg, "image/jpeg")
    };
    Ok(ViewImage {
        data,
        mime_type,
        width,
        height,
        // The upright size, as `operations.ts:90-92` turns the stored one.
        source_width: image.width(),
        source_height: image.height(),
    })
}

/// sharp's `resize(edge, edge, { fit: 'inside', withoutEnlargement: true })`: the long side becomes
/// `edge` and the short side is rounded, at least 1 (sharp 0.35.4, measured in
/// `tests/image_processing.rs`).
pub(super) fn fit_size(width: u32, height: u32, edge: u32) -> (u32, u32) {
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

fn fit_inside(image: &RgbaImage, edge: u32) -> RgbaImage {
    let (width, height) = fit_size(image.width(), image.height(), edge);
    if (width, height) == image.dimensions() {
        return image.clone();
    }
    imageops::resize(image, width, height, FilterType::Lanczos3)
}

fn png(image: &RgbaImage) -> Result<Vec<u8>, ImageError> {
    let mut data = Vec::new();
    let (width, height) = image.dimensions();
    let encoder = PngEncoder::new(&mut data);
    if image.pixels().all(|pixel| pixel[3] == 255) {
        let rgb = flatten(image, [0, 0, 0]);
        encoder.write_image(&rgb, width, height, ExtendedColorType::Rgb8)
    } else {
        encoder.write_image(image.as_raw(), width, height, ExtendedColorType::Rgba8)
    }
    .map_err(encode_error)?;
    Ok(data)
}

/// JPEG has no alpha: libvips flattens on black unless told otherwise, `prepareViewImage` on white.
fn jpeg(image: &RgbaImage, background: [u8; 3], quality: u8) -> Result<Vec<u8>, ImageError> {
    let mut data = Vec::new();
    let (width, height) = image.dimensions();
    JpegEncoder::new_with_quality(&mut data, quality)
        .encode(
            &flatten(image, background),
            width,
            height,
            ExtendedColorType::Rgb8,
        )
        .map_err(encode_error)?;
    Ok(data)
}

/// RGB samples of `image` composited over `background`.
fn flatten(image: &RgbaImage, background: [u8; 3]) -> Vec<u8> {
    let mut rgb = Vec::with_capacity(image.as_raw().len() / 4 * 3);
    for pixel in image.pixels() {
        let alpha = u32::from(pixel[3]);
        for (sample, back) in pixel.0[..3].iter().zip(background) {
            let mixed = u32::from(*sample) * alpha + u32::from(back) * (255 - alpha);
            rgb.push(((mixed + 127) / 255) as u8);
        }
    }
    rgb
}

/// sharp's `metadata().format` name.
fn sharp_format(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpeg",
        ImageFormat::Gif => "gif",
        ImageFormat::WebP => "webp",
        _ => "unknown",
    }
}

fn encode_error(error: image::ImageError) -> ImageError {
    ImageError::Encode(error.to_string())
}
