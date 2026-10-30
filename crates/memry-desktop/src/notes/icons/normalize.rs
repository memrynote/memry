//! What an added icon is stored as (`normalizeIcon` of `custom-icon-handlers.ts`): a raster image
//! decoded and re-encoded as PNG with its longest edge at most [`MAX_EDGE_PX`], or a sanitized SVG.
//! The re-encode keeps every icon a few KB, which is what lets its bytes ride in the sync record,
//! and drops whatever metadata the source file carried.
//!
//! The bytes are untrusted (a dropped file, a downloaded link), so decoding is bounded: a 2 MiB
//! PNG can declare an image of gigabytes. [`decode_limits`] refuses any image whose decoded pixels
//! need more than [`MAX_DECODED_BYTES`] before anything that large is allocated. Electron's
//! `nativeImage` had no such bound.

use std::io::Cursor;

use image::imageops::FilterType;
use image::{ImageFormat, ImageReader, Limits};

use crate::vault::svg::sanitize_svg_bytes;

use super::CustomIconError;

/// `CUSTOM_ICON_MAX_INPUT_BYTES`: the most bytes an icon may have before normalization.
pub const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;

/// `CUSTOM_ICON_MAX_EDGE_PX`: the longest edge kept after downscaling a raster icon.
pub const MAX_EDGE_PX: u32 = 128;

/// The most memory a decoded image may take: a 5000 x 5000 RGBA photo, or a 6500 x 6500 RGB one.
pub const MAX_DECODED_BYTES: u64 = 128 * 1024 * 1024;

const MAX_DIMENSION_PX: u32 = 16_384;

/// The raster formats of `CUSTOM_ICON_INPUT_EXTENSIONS`, told apart by their bytes.
const RASTER_FORMATS: [ImageFormat; 4] = [
    ImageFormat::Png,
    ImageFormat::Jpeg,
    ImageFormat::Gif,
    ImageFormat::WebP,
];

/// The input extensions an icon may be added with (`CUSTOM_ICON_INPUT_EXTENSIONS`).
pub const INPUT_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

/// An icon as it is stored: `ext` is `png` or `svg`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Normalized {
    pub bytes: Vec<u8>,
    pub ext: &'static str,
}

fn decode_limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION_PX);
    limits.max_image_height = Some(MAX_DIMENSION_PX);
    limits.max_alloc = Some(MAX_DECODED_BYTES);
    limits
}

/// Normalizes the bytes of an icon added as `ext`. The format of a raster image is read from its
/// bytes, as `nativeImage` did; `ext` only says whether they are an SVG.
pub fn normalize(bytes: &[u8], ext: &str) -> Result<Normalized, CustomIconError> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
        return Err(CustomIconError::TooLarge);
    }
    let ext = ext.to_ascii_lowercase();
    if !INPUT_EXTENSIONS.contains(&ext.as_str()) {
        return Err(CustomIconError::Unreadable);
    }
    if ext == "svg" {
        // Over the cap is impossible below 2 MiB of input; nothing usable is a corrupt icon.
        let bytes = sanitize_svg_bytes(bytes).map_err(|_| CustomIconError::Unreadable)?;
        return Ok(Normalized { bytes, ext: "svg" });
    }

    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| CustomIconError::Unreadable)?;
    if !reader.format().is_some_and(|f| RASTER_FORMATS.contains(&f)) {
        return Err(CustomIconError::Unreadable);
    }
    reader.limits(decode_limits());
    let image = reader.decode().map_err(|error| {
        tracing::warn!(
            scope = "CustomIcons",
            "an icon image could not be decoded: {error}"
        );
        CustomIconError::Unreadable
    })?;
    let image = if image.width().max(image.height()) > MAX_EDGE_PX {
        image.resize(MAX_EDGE_PX, MAX_EDGE_PX, FilterType::Lanczos3)
    } else {
        image
    };
    let mut png = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .map_err(|error| {
            tracing::warn!(
                scope = "CustomIcons",
                "an icon could not be encoded as PNG: {error}"
            );
            CustomIconError::Unreadable
        })?;
    Ok(Normalized {
        bytes: png,
        ext: "png",
    })
}
