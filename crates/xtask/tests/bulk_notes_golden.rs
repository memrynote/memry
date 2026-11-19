//! The bench corpus is a contract: `xtask::bulk_notes` written through the vault file tier gives
//! the same bytes, file for file, as the TypeScript generator written through its own writer.
//! `golden/bulk-notes.json` holds the sha256 the TypeScript side recorded
//! (`golden/record-bulk-notes.ts`); never edit it by hand.

use std::path::Path;

use sha2::{Digest, Sha256};
use xtask::{bulk_notes, seed};

fn recorded(seed: u64, count: u64, first: u64) -> Vec<String> {
    let golden: serde_json::Value = serde_json::from_str(include_str!("golden/bulk-notes.json"))
        .expect("bulk-notes.json is JSON");
    let case = golden["cases"]
        .as_array()
        .expect("a list of cases")
        .iter()
        .find(|case| case["seed"] == seed && case["count"] == count && case["first"] == first)
        .expect("the case is recorded");
    case["files"]
        .as_array()
        .expect("a list of files")
        .iter()
        .map(|line| line.as_str().expect("a sha256sum line").to_owned())
        .collect()
}

fn sha256sum(vault: &Path, rel: &str) -> String {
    let bytes = std::fs::read(vault.join(rel)).expect("the note was written");
    format!("{}  {rel}", hex::encode(Sha256::digest(bytes)))
}

/// Generates `count` notes from `seed`, writes the first `first` and compares every file.
fn assert_matches_typescript(seed: u32, count: usize, first: usize) {
    let expected = recorded(seed.into(), count as u64, first as u64);
    let vault = bulk_notes::generate(count, seed);
    let notes = &vault.notes[..first];
    let dir = tempfile::tempdir().expect("a scratch vault");
    seed::write_notes(dir.path(), notes).expect("the notes are written");
    let actual: Vec<String> = notes
        .iter()
        .map(|note| sha256sum(dir.path(), &note.path))
        .collect();
    assert_eq!(actual.len(), expected.len(), "files of seed {seed}");
    for (index, (actual, expected)) in actual.iter().zip(&expected).enumerate() {
        assert_eq!(
            actual, expected,
            "file {index} of seed {seed}, count {count}"
        );
    }
}

#[test]
fn bulk_notes_golden_seed_42_count_1000() {
    assert_matches_typescript(42, 1000, 1000);
}

#[test]
fn bulk_notes_golden_seed_7_count_50() {
    assert_matches_typescript(7, 50, 50);
}

#[test]
fn bulk_notes_golden_seed_42_count_10000_first_100() {
    assert_matches_typescript(42, 10_000, 100);
}
