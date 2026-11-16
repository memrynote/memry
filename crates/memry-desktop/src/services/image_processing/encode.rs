//! The operations of Electron's image-processing worker (`image-processing/operations.ts`) on
//! `memry_media`'s bounded decode, encoded with `image`'s pure-Rust encoders.
//!
//! Known differences from sharp: thumbnails are lossless WebP (`image` has no lossy WebP encoder;
//! Kaan's R3 on #3542), so the format and the size match and the file is larger; an EXIF-rotated
//! image's thumbnail and inbox thumbnail come out upright, where sharp without `.rotate()` keeps the
//! stored orientation; SVG gets no thumbnail (no rasteriser is linked); the resize is an area
//! average to twice the size, then Lanczos3, and runs before the colour profile applies
//! (`memry_media::decode_fit`), where sharp converts first and reduces with its own kernel, so
//! pixels differ and sizes do not; and an image the
//! decode refuses (over 30 MiB, a JPEG without its end marker) has no inbox metadata, where sharp
//! still read its header.

use std::borrow::Cow;
use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::path::Path;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::codecs::webp::WebPEncoder;
use image::{DynamicImage, ExtendedColorType, ImageEncoder, ImageFormat};
use memry_media::{MAX_IMAGE_BYTES, decode_fit};

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

/// Reads a regular file, at most one byte past the decode's cap, so a larger file is refused by
/// the decode without being read whole. Anything else (a FIFO, a device, a directory) is refused
/// from the open handle before a read, as Electron's `readImage` checks `isFile()`
/// (`agent/mcp/tools/file-view.ts:163`): reading a FIFO blocks until a writer comes, and would hold
/// a worker until then. The open itself does not block on a FIFO (`O_NONBLOCK`, which a regular
/// file ignores); a read from a stalled network mount still can.
pub(super) fn read_bounded(path: &Path) -> io::Result<Vec<u8>> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file: File = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// `generateImageThumbnail` (`operations.ts:144-160`): the long edge at most 200, as WebP.
pub(super) fn thumbnail(bytes: &[u8]) -> Result<Thumbnail, ImageError> {
    webp(&decode_fit(bytes, THUMBNAIL_EDGE)?.image)
}

/// The WebP of an 8-bit RGB or RGBA image, sized as it is.
fn webp(image: &DynamicImage) -> Result<Thumbnail, ImageError> {
    let mut data = Vec::new();
    let (width, height) = (image.width(), image.height());
    WebPEncoder::new_lossless(&mut data)
        .encode(image.as_bytes(), width, height, image.color().into())
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
    let fitted = decode_fit(bytes, INBOX_EDGE)?;
    let info = fitted.info;
    let thumbnail_jpeg = jpeg(&fitted.image, [0, 0, 0], INBOX_JPEG_QUALITY)
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
    let fitted = decode_fit(bytes, max_edge)?;
    let (width, height) = (fitted.image.width(), fitted.image.height());
    let png = png(&fitted.image)?;
    let (data, mime_type) = if png.len() <= VIEW_IMAGE_PNG_MAX_BYTES {
        (png, "image/png")
    } else {
        let jpeg = jpeg(&fitted.image, [255, 255, 255], VIEW_IMAGE_JPEG_QUALITY)?;
        (jpeg, "image/jpeg")
    };
    Ok(ViewImage {
        data,
        mime_type,
        width,
        height,
        // The upright size, as `operations.ts:90-92` turns the stored one.
        source_width: fitted.width,
        source_height: fitted.height,
    })
}

/// An opaque image as RGB, one with alpha as RGBA.
fn png(image: &DynamicImage) -> Result<Vec<u8>, ImageError> {
    let mut data = Vec::new();
    let (width, height) = (image.width(), image.height());
    let encoder = PngEncoder::new(&mut data);
    let opaque = image
        .as_rgba8()
        .is_none_or(|rgba| rgba.pixels().all(|pixel| pixel[3] == 255));
    if opaque {
        let rgb = flatten(image, [0, 0, 0]);
        encoder.write_image(&rgb, width, height, ExtendedColorType::Rgb8)
    } else {
        encoder.write_image(image.as_bytes(), width, height, image.color().into())
    }
    .map_err(encode_error)?;
    Ok(data)
}

/// JPEG has no alpha: libvips flattens on black unless told otherwise, `prepareViewImage` on white.
fn jpeg(image: &DynamicImage, background: [u8; 3], quality: u8) -> Result<Vec<u8>, ImageError> {
    let mut data = Vec::new();
    let (width, height) = (image.width(), image.height());
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

/// RGB samples of `image` composited over `background`; an RGB image's own.
fn flatten(image: &DynamicImage, background: [u8; 3]) -> Cow<'_, [u8]> {
    let Some(rgba) = image.as_rgba8() else {
        return Cow::Borrowed(image.as_bytes());
    };
    let mut rgb = Vec::with_capacity(rgba.as_raw().len() / 4 * 3);
    for pixel in rgba.pixels() {
        let alpha = u32::from(pixel[3]);
        for (sample, back) in pixel.0[..3].iter().zip(background) {
            let mixed = u32::from(*sample) * alpha + u32::from(back) * (255 - alpha);
            rgb.push(((mixed + 127) / 255) as u8);
        }
    }
    Cow::Owned(rgb)
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
