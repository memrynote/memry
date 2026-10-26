use std::fs;

use super::*;
use crate::electron_import::tests::macos_fixture;

fn with_checksum(words: &str) -> String {
    format!(
        "{words}{CHECKSUM_PREFIX}{}\n",
        hex::encode(Md5::digest(words.as_bytes()))
    )
}

#[test]
fn reads_the_chromium_written_dictionary() {
    let f = macos_fixture("new");
    let dict = CustomDictionary::read(&f.profile).unwrap().unwrap();
    assert!(dict.checksum_ok);
    assert!(!dict.from_backup);
    let mut words = dict.words.clone();
    words.sort();
    assert_eq!(words, ["memryfixtureword", "naïve", "zettelkasten"]);
}

#[test]
fn bad_checksum_falls_back_to_the_backup() {
    let f = macos_fixture("new");
    let path = f.profile.dictionary_path();
    fs::write(
        &path,
        "tampered\nchecksum_v1 = 00000000000000000000000000000000\n",
    )
    .unwrap();
    let dict = CustomDictionary::read(&f.profile).unwrap().unwrap();
    assert!(dict.checksum_ok && dict.from_backup);
    // Chromium's backup is the file as it was before the last write.
    assert_eq!(dict.words, ["memryfixtureword", "zettelkasten"]);
}

#[test]
fn both_bad_returns_the_primary_unverified() {
    let f = macos_fixture("new");
    let path = f.profile.dictionary_path();
    fs::write(&path, "tampered\nchecksum_v1 = 00\n").unwrap();
    let mut backup = path.clone().into_os_string();
    backup.push(".backup");
    fs::write(backup, "x\n").unwrap();
    let dict = CustomDictionary::read(&f.profile).unwrap().unwrap();
    assert!(!dict.checksum_ok && !dict.from_backup);
    assert_eq!(dict.words, ["tampered"]);
}

#[test]
fn missing_files_are_none() {
    let f = macos_fixture("new");
    fs::remove_file(f.profile.dictionary_path()).unwrap();
    let mut backup = f.profile.dictionary_path().into_os_string();
    backup.push(".backup");
    fs::remove_file(backup).unwrap();
    assert!(CustomDictionary::read(&f.profile).unwrap().is_none());
}

#[test]
fn parse_handles_crlf_blank_lines_and_no_checksum() {
    let parsed = CustomDictionary::parse(&with_checksum("a\nb\n"));
    assert!(parsed.checksum_ok);
    assert_eq!(parsed.words, ["a", "b"]);
    let none = CustomDictionary::parse("a\nb\n");
    assert!(!none.checksum_ok);
    assert_eq!(none.words, ["a", "b"]);
}
