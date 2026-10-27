//! The djb2 content hash equals Electron's `generateContentHash`, case by case
//! (`fixtures/content-hash.json`, produced by `fixtures/gen-vault-vectors.mjs`).

use memry_desktop::vault::hash::{ContentHasher, content_hash, hash_reader};
use serde_json::Value;

fn load() -> Value {
    let text = include_str!("fixtures/content-hash.json");
    serde_json::from_str(text).expect("vector file")
}

fn units(case: &Value) -> Vec<u16> {
    case["units"]
        .as_array()
        .expect("units")
        .iter()
        .map(|u| u.as_u64().expect("unit") as u16)
        .collect()
}

#[test]
fn every_case_hashes_to_the_value_electron_produced() {
    let vectors = load();
    let cases = vectors["cases"].as_array().expect("cases");
    assert!(cases.len() >= 12);
    for case in cases {
        let mut hasher = ContentHasher::new();
        hasher.update_utf16(&units(case));
        assert_eq!(
            hasher.digest(),
            case["hash"].as_str().expect("hash"),
            "{}",
            case["name"]
        );
        // The same text through the &str API, where a Rust string can hold it.
        if let Ok(text) = String::from_utf16(&units(case)) {
            assert_eq!(content_hash(&text), case["hash"].as_str().unwrap());
        }
    }
}

#[test]
fn three_megabytes_in_64k_chunks_and_as_a_stream_match() {
    let vectors = load();
    let big = &vectors["big"];
    let text: String = (0..big["length"].as_u64().unwrap())
        .map(|i| char::from(32 + (i % 90) as u8))
        .collect();
    let expected = big["hash"].as_str().unwrap();

    let mut hasher = ContentHasher::new();
    for chunk in text
        .as_bytes()
        .chunks(big["chunk"].as_u64().unwrap() as usize)
    {
        hasher.update(std::str::from_utf8(chunk).unwrap());
    }
    assert_eq!(hasher.digest(), expected);
    assert_eq!(content_hash(&text), expected);
    let (streamed, bytes) = hash_reader(text.as_bytes()).unwrap();
    assert_eq!((streamed.as_str(), bytes), (expected, text.len() as u64));
}

/// A reader that returns one byte per call cuts every multi-byte character, so a hash
/// that lost the carried bytes would differ.
struct OneByte<'a>(&'a [u8]);
impl std::io::Read for OneByte<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self.0.split_first() {
            Some((first, rest)) if !buf.is_empty() => {
                buf[0] = *first;
                self.0 = rest;
                Ok(1)
            }
            _ => Ok(0),
        }
    }
}

#[test]
fn a_character_cut_by_a_chunk_boundary_hashes_like_the_whole_text() {
    let text = "caf\u{e9} \u{65e5}\u{672c} \u{1F680} \u{FEFF}end";
    assert_eq!(
        hash_reader(OneByte(text.as_bytes())).unwrap().0,
        content_hash(text)
    );
}

#[test]
fn invalid_utf8_hashes_as_replacement_characters_like_node() {
    let bytes = [b'a', 0xff, b'b', 0xe2, 0x82, b'c', 0xf0, 0x9f];
    let lossy = String::from_utf8_lossy(&bytes);
    assert_eq!(hash_reader(&bytes[..]).unwrap().0, content_hash(&lossy));
    assert_eq!(
        hash_reader(OneByte(&bytes)).unwrap().0,
        content_hash(&lossy)
    );
}

mod splits {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig { cases: 2000, ..ProptestConfig::default() })]

        /// Any way of cutting a byte stream hashes like the whole text decoded at once.
        #[test]
        fn any_split_of_any_bytes_hashes_like_the_lossy_whole(
            bytes in prop::collection::vec(any::<u8>(), 0..600),
            cut in 1usize..9,
        ) {
            struct Chunks<'a>(&'a [u8], usize);
            impl std::io::Read for Chunks<'_> {
                fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                    let n = self.0.len().min(self.1).min(buf.len());
                    buf[..n].copy_from_slice(&self.0[..n]);
                    self.0 = &self.0[n..];
                    Ok(n)
                }
            }
            let expected = content_hash(&String::from_utf8_lossy(&bytes));
            prop_assert_eq!(hash_reader(Chunks(&bytes, cut)).unwrap().0, expected);
        }
    }
}
