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
    unpack_within(cache, lang, source, sha256, MAX_UNPACKED)
}

fn unpack_within(
    cache: &Path,
    lang: OcrLanguage,
    source: &Path,
    sha256: &str,
    max_unpacked: u64,
) -> io::Result<()> {
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
        .take(max_unpacked + 1)
        .read_to_end(&mut unpacked)?;
    if unpacked.len() as u64 > max_unpacked {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("the {} pack unpacks past {max_unpacked} bytes", lang.code()),
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

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn pack(dir: &Path, text: &str) -> (std::path::PathBuf, String) {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(text.as_bytes()).expect("gzip");
        let packed = encoder.finish().expect("gzip");
        let source = dir.join("deu.traineddata.gz");
        std::fs::write(&source, &packed).expect("write pack");
        (source, hex::encode(Sha256::digest(&packed)))
    }

    fn names(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir).map_or_else(
            |_| Vec::new(),
            |entries| {
                entries
                    .map(|entry| {
                        entry
                            .expect("entry")
                            .file_name()
                            .to_string_lossy()
                            .into_owned()
                    })
                    .collect()
            },
        )
    }

    #[test]
    fn a_pack_that_unpacks_past_the_cap_is_refused_and_leaves_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cache = dir.path().join(CACHE_DIR);
        let (source, sha) = pack(dir.path(), &"a".repeat(17));

        let error =
            unpack_within(&cache, OcrLanguage::Deu, &source, &sha, 16).expect_err("refused");

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(names(&cache).is_empty(), "cache holds {:?}", names(&cache));
        unpack_within(&cache, OcrLanguage::Deu, &source, &sha, 17).expect("at the cap");
        assert_eq!(
            std::fs::read_to_string(cache.join("deu.traineddata")).expect("unpacked"),
            "a".repeat(17)
        );
    }

    #[test]
    fn a_pack_whose_sha256_differs_from_its_pin_is_refused_and_leaves_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cache = dir.path().join(CACHE_DIR);
        let (source, _) = pack(dir.path(), "deu data");
        let other = hex::encode(Sha256::digest(b"another pack"));

        let error = unpack(&cache, OcrLanguage::Deu, &source, &other).expect_err("refused");

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(names(&cache).is_empty(), "cache holds {:?}", names(&cache));
    }
}
