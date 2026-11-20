//! The plain `.traineddata` Tesseract reads, unpacked from the gzip packs. tesseract.js read the
//! packs gzipped; native Tesseract does not. Each entry's marker records the sha256 of the pack it
//! came from and of the unpacked bytes: a pack that changes is unpacked again, and an entry whose
//! bytes changed on disk is unpacked again the first time a run uses it. A marker without the
//! unpacked sha256 (written by builds before #3542 FIX-LOWS-25) is a miss: the entry is unpacked
//! once more and the marker rewritten, and those builds unpack again on seeing a new marker.

use std::collections::HashSet;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};

use super::OcrLanguage;

/// The folder of the unpacked data under the app data dir.
pub const CACHE_DIR: &str = "ocr-cache";

/// Far above the largest unpacked language (a few MiB): a pack that unpacks past it is refused.
const MAX_UNPACKED: u64 = 64 * 1024 * 1024;

/// The entries this run hashed or wrote, with their marker: each is hashed once per run.
static CHECKED: Mutex<Option<HashSet<(PathBuf, String)>>> = Mutex::new(None);

fn checked(entry: &(PathBuf, String)) -> bool {
    let checked = CHECKED.lock().unwrap_or_else(PoisonError::into_inner);
    checked.as_ref().is_some_and(|set| set.contains(entry))
}

fn mark_checked(entry: (PathBuf, String)) {
    CHECKED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get_or_insert_default()
        .insert(entry);
}

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
    if let Ok(seen) = std::fs::read_to_string(&marker)
        && seen
            .split_once('\n')
            .is_some_and(|(pack, _)| pack == sha256)
    {
        let entry = (target.clone(), seen);
        if checked(&entry) && target.is_file() {
            return Ok(());
        }
        let unpacked_sha = entry.1.split_once('\n').map(|(_, unpacked)| unpacked);
        if std::fs::read(&target)
            .is_ok_and(|bytes| Some(hex::encode(Sha256::digest(&bytes)).as_str()) == unpacked_sha)
        {
            mark_checked(entry);
            return Ok(());
        }
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
    let seen = format!("{sha256}\n{}", hex::encode(Sha256::digest(&unpacked)));
    replace(cache, lang, &target, &unpacked)?;
    replace(cache, lang, &marker, seen.as_bytes())?;
    mark_checked((target, seen));
    Ok(())
}

/// Writes `bytes` to a `.part` file in `cache`, then moves it over `target`.
fn replace(cache: &Path, lang: OcrLanguage, target: &Path, bytes: &[u8]) -> io::Result<()> {
    let temp = cache.join(format!("{}.{}.part", lang.code(), uuid::Uuid::new_v4()));
    let written = std::fs::write(&temp, bytes).and_then(|()| std::fs::rename(&temp, target));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
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
    fn an_entry_an_earlier_run_left_is_unpacked_again_when_its_bytes_changed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let earlier = dir.path().join("earlier");
        let (source, sha) = pack(dir.path(), "deu data");
        unpack(&earlier, OcrLanguage::Deu, &source, &sha).expect("unpack");
        // This run has not seen the copy: its bytes changed on disk, its marker did not.
        let cache = dir.path().join(CACHE_DIR);
        std::fs::create_dir_all(&cache).expect("cache dir");
        for name in names(&earlier) {
            std::fs::copy(earlier.join(&name), cache.join(&name)).expect("copy");
        }
        std::fs::write(cache.join("deu.traineddata"), "deu dat4").expect("damage");

        unpack(&cache, OcrLanguage::Deu, &source, &sha).expect("unpack");

        assert_eq!(
            std::fs::read_to_string(cache.join("deu.traineddata")).expect("unpacked"),
            "deu data"
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
