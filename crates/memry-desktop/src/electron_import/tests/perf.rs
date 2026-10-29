//! The readers on synthetic stores of the sizes the migration must handle. Each reads its store
//! in one LevelDB scan; the tests check what comes out at that size and print the time. The 5 s
//! (2000 documents) and 1 s (5 MB localStorage) budgets are measured by hand in a release build
//! (`cargo test -p memry-desktop --release electron_import::tests::perf -- --nocapture`): a
//! wall-clock bound in CI fails on a loaded runner, not on slow code.

use std::time::Instant;

use rusty_leveldb::{DB, Options};

use super::*;
use crate::electron_import::{LocalStorageSnapshot, YStoreReader};

#[test]
fn ystore_2000_documents_load() {
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
}

#[test]
fn local_storage_5_mb_reads() {
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
}
