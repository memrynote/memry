//! The plain `.traineddata` Tesseract reads, unpacked from the gzip packs. tesseract.js read the
//! packs gzipped; native Tesseract does not. Each entry records the sha256 of the pack it came
//! from, so a pack that changes is unpacked again and an unchanged one is never unpacked twice.

use std::io::{self, Read};
use std::path::Path;

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};

use super::OcrLanguage;

/// The folder of the unpacked data under the app data dir.
pub const CACHE_DIR: &str = "ocr-cache";

/// Far above the largest unpacked language (a few MiB): a pack that unpacks past it is refused.
const MAX_UNPACKED: u64 = 64 * 1024 * 1024;

/// Unpacks the gzip pack at `source`, which must hash to `sha256`, to
/// `<cache>/<lang>.traineddata`, unless the cache already holds the unpacking of those bytes.
/// Blocking file work.
pub fn unpack(cache: &Path, lang: OcrLanguage, source: &Path, sha256: &str) -> io::Result<()> {
    let target = cache.join(lang.file_name());
    let marker = cache.join(format!("{}.source-sha256", lang.code()));
    if target.is_file() && std::fs::read_to_string(&marker).is_ok_and(|seen| seen == sha256) {
        return Ok(());
    }
    let packed = std::fs::read(source)?;
    if hex::encode(Sha256::digest(&packed)) != sha256 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("the {} pack does not match its pin", lang.code()),
        ));
    }
    let mut unpacked = Vec::new();
    GzDecoder::new(packed.as_slice())
        .take(MAX_UNPACKED + 1)
        .read_to_end(&mut unpacked)?;
    if unpacked.len() as u64 > MAX_UNPACKED {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("the {} pack unpacks past {MAX_UNPACKED} bytes", lang.code()),
        ));
    }
    std::fs::create_dir_all(cache)?;
    let temp = cache.join(format!("{}.{}.part", lang.code(), uuid::Uuid::new_v4()));
    let written = std::fs::write(&temp, &unpacked).and_then(|()| std::fs::rename(&temp, &target));
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    std::fs::write(marker, sha256)
}
