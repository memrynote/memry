//! WebP decodes through image-webp directly: `image`'s WebP codec keeps image-webp's default
//! memory limit (image 0.25.10, `codecs/webp/decoder.rs`), and that limit is what bounds a lossless
//! image's Huffman tables, which the decoder builds for every group the stream names, used or
//! not (`[patch.crates-io]` in `crates/Cargo.toml`).

use std::io::Cursor;

use image::error::DecodingError;
use image::{ColorType, DynamicImage, ImageError, ImageFormat, RgbImage, RgbaImage};

use crate::{DecodeError, Header, input};

/// Decodes the first frame of `bytes`, which `header` describes, allowing the decoder
/// `memory_limit` bytes beyond the frame and scratch `read_frame` counted.
pub(crate) fn decode(
    bytes: &[u8],
    header: &Header,
    memory_limit: u64,
) -> Result<DynamicImage, DecodeError> {
    // The messages `image` gives for the same errors (`ImageError::from_webp_decode`).
    let decode_error = |error: image_webp::DecodingError| {
        let error = match error {
            image_webp::DecodingError::IoError(error) => ImageError::IoError(error),
            error => ImageError::Decoding(DecodingError::new(ImageFormat::WebP.into(), error)),
        };
        input(format!("cannot decode image: {error}"))
    };
    let mut decoder = image_webp::WebPDecoder::new(Cursor::new(bytes)).map_err(decode_error)?;
    decoder.set_memory_limit(usize::try_from(memory_limit).unwrap_or(usize::MAX));
    // `read_frame` checked the frame under `MAX_DECODE_ALLOC`, which fits a `usize` on every target.
    let mut buffer = vec![0; header.frame as usize];
    decoder.read_image(&mut buffer).map_err(decode_error)?;
    let (width, height) = (header.width, header.height);
    let image = if header.color == ColorType::Rgba8 {
        RgbaImage::from_raw(width, height, buffer).map(DynamicImage::ImageRgba8)
    } else {
        RgbImage::from_raw(width, height, buffer).map(DynamicImage::ImageRgb8)
    };
    image.ok_or_else(|| input("WebP frame does not match its size"))
}
