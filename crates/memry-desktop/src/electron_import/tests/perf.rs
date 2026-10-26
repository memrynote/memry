//! The 5 s (2000 documents) and 1 s (5 MB localStorage) budgets are measured with `--release`
//! and quoted in the PR; the asserts here are 6x and 10x looser so a loaded debug CI runner does
//! not fail them, and still catch a pathological regression.
//!
//! Reader performance on synthetic stores of the sizes the migration must handle
//! (`cargo test -p memry-desktop --release electron_import::tests::perf -- --nocapture`).

use std::time::Instant;

use rusty_leveldb::{DB, Options};

use super::*;
use crate::electron_import::{LocalStorageSnapshot, YStoreReader};

#[test]
fn ystore_2000_documents_load_within_budget() {
    let dir = tempfile::tempdir().unwrap();
    synthetic::write_store(dir.path(), 2000, 3);
    let start = Instant::now();
    let (_keep, scratch) = test_scratch();
    let store = YStoreReader::open_dir(dir.path(), &scratch)
        .unwrap()
        .unwrap();
    let names = store.doc_names();
    let updates: usize = names.iter().map(|n| store.updates(n).len()).sum();
    let elapsed = start.elapsed();
    println!("perf: ystore 2000 docs / {updates} updates in {elapsed:?}");
    assert_eq!((names.len(), updates), (2000, 6000));
    assert!(elapsed.as_secs_f64() < 30.0, "{elapsed:?}");
}

#[test]
fn local_storage_5_mb_reads_within_budget() {
    let f = macos_fixture("new");
    let dir = f.profile.local_storage_dir();
    let mut db = DB::open(&dir, Options::default()).unwrap();
    let value = [&[1_u8][..], &vec![b'x'; 5000]].concat();
    for i in 0..1000 {
        let mut key = b"_file://\0\x01".to_vec();
        key.extend(format!("perf-{i:04}").bytes());
        db.put(&key, &value).unwrap();
    }
    db.flush().unwrap();
    drop(db);
    let start = Instant::now();
    let snapshot = LocalStorageSnapshot::read(&f.profile, "file://", &f.scratch)
        .unwrap()
        .unwrap();
    let elapsed = start.elapsed();
    println!(
        "perf: localStorage {} entries in {elapsed:?}",
        snapshot.entries.len()
    );
    assert_eq!(snapshot.entries.len(), 1004);
    assert!(elapsed.as_secs_f64() < 10.0, "{elapsed:?}");
}
