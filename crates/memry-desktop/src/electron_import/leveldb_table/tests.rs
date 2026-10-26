use std::fs;

use rusty_leveldb::{DB, Options};

use super::*;
use crate::electron_import::tests::{synthetic, test_scratch, tree_snapshot};
use crate::electron_import::{ImportError, scratch::ScratchDb};

/// A store compacted into tables: more than the 4 MB write buffer, so LevelDB flushes `.ldb`
/// files and the log restarts.
fn compacted_store(dir: &std::path::Path) {
    fs::create_dir_all(dir).unwrap();
    let mut db = DB::open(dir, Options::default()).unwrap();
    for i in 0..6000_u32 {
        db.put(format!("key-{i:06}").as_bytes(), &[(i % 251) as u8; 1024])
            .unwrap();
    }
    db.flush().unwrap();
}

fn tables(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut found: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "ldb" || e == "sst"))
        .collect();
    found.sort();
    found
}

#[test]
fn a_compacted_store_with_tables_verifies_and_opens() {
    let dir = tempfile::tempdir().unwrap();
    compacted_store(dir.path());
    let files = tables(dir.path());
    assert!(
        !files.is_empty(),
        "the store never compacted past the write buffer"
    );
    for file in &files {
        verify(&fs::read(file).unwrap()).unwrap();
    }
    let (_keep, scratch) = test_scratch();
    let mut db = ScratchDb::open(&scratch, dir.path()).unwrap();
    assert_eq!(db.scan_prefix(b"key-").unwrap().len(), 6000);
}

#[test]
fn a_bit_flip_in_any_table_block_fails_the_open_instead_of_dropping_rows() {
    let dir = tempfile::tempdir().unwrap();
    compacted_store(dir.path());
    let table = tables(dir.path()).remove(0);
    let original = fs::read(&table).unwrap();
    let before = tree_snapshot(dir.path());
    let (_keep, scratch) = test_scratch();
    // The first data block, the middle of the file and the index region before the footer.
    for at in [10, original.len() / 2, original.len() - 60] {
        let mut bad = original.clone();
        bad[at] ^= 0x01;
        fs::write(&table, &bad).unwrap();
        let err = ScratchDb::open(&scratch, dir.path()).err();
        assert!(
            matches!(err, Some(ImportError::LevelDb(_))),
            "flip at {at}: {err:?}"
        );
    }
    fs::write(&table, &original).unwrap();
    assert_eq!(tree_snapshot(dir.path()), before);
}

#[test]
fn a_damaged_footer_or_a_missing_live_table_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    compacted_store(dir.path());
    let table = tables(dir.path()).remove(0);
    let original = fs::read(&table).unwrap();
    let (_keep, scratch) = test_scratch();
    let mut bad = original.clone();
    let last = bad.len() - 1;
    bad[last] ^= 0xff;
    fs::write(&table, &bad).unwrap();
    assert!(ScratchDb::open(&scratch, dir.path()).is_err());
    fs::write(&table, &original[..20]).unwrap();
    assert!(ScratchDb::open(&scratch, dir.path()).is_err());
    fs::remove_file(&table).unwrap();
    assert!(ScratchDb::open(&scratch, dir.path()).is_err());
}

#[test]
fn a_table_the_manifest_no_longer_names_is_not_verified() {
    let dir = tempfile::tempdir().unwrap();
    synthetic::write_store(dir.path(), 2, 10);
    fs::write(
        dir.path().join("000999.ldb"),
        b"leftover of an interrupted compaction",
    )
    .unwrap();
    let (_keep, scratch) = test_scratch();
    let mut db = ScratchDb::open(&scratch, dir.path()).unwrap();
    assert_eq!(db.scan_prefix(&[]).unwrap().len(), 20);
}
