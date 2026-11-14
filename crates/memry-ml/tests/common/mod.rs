//! Shared by the image vector tests: which inputs are a known divergence from Electron's decode.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::{ImageDecoder, ImageFormat, ImageReader};
use memry_ml::image_prep::is_cmyk_jpeg;

pub fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The divergence class of an input, read from its bytes so the vector file cannot widen it:
/// JPEG decoding (zune-jpeg against libjpeg-turbo), ICC conversion (moxcms against Little CMS),
/// or both. A CMYK or YCCK JPEG (`is_cmyk_jpeg`) is its own class, `cmyk` or `cmyk+icc`: zune-jpeg
/// converts it naively and the profile is dropped, where libvips converts through a profile.
/// `None` is an input the Rust decodes bit for bit like Electron. Any embedded profile counts as
/// `icc`, including one `to_srgb` drops (grey, CMYK, unreadable).
pub fn divergence(bytes: &[u8]) -> Option<&'static str> {
    let format = image::guess_format(bytes).ok()?;
    let has_profile = ImageReader::with_format(Cursor::new(bytes), format)
        .into_decoder()
        .ok()
        .and_then(|mut decoder| decoder.icc_profile().ok().flatten())
        .is_some();
    match (format, has_profile) {
        (ImageFormat::Jpeg, true) if is_cmyk_jpeg(bytes) => Some("cmyk+icc"),
        (ImageFormat::Jpeg, false) if is_cmyk_jpeg(bytes) => Some("cmyk"),
        (ImageFormat::Jpeg, true) => Some("jpeg+icc"),
        (ImageFormat::Jpeg, false) => Some("jpeg"),
        (_, true) => Some("icc"),
        (_, false) => None,
    }
}
