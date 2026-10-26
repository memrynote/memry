use std::fs;
use std::time::Duration;

use super::*;
use crate::electron_import::tests::{macos_fixture, synthetic};

#[test]
fn copy_skips_lock_and_subdirectories() {
    let src = tempfile::tempdir().unwrap();
    fs::write(src.path().join("LOCK"), "").unwrap();
    fs::write(src.path().join("CURRENT"), "x").unwrap();
    fs::create_dir(src.path().join("sub")).unwrap();
    let dst = tempfile::tempdir().unwrap();
    copy_leveldb_dir(src.path(), dst.path(), 1024).unwrap();
    let names: Vec<_> = fs::read_dir(dst.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, ["CURRENT"]);
}

#[test]
fn opening_never_changes_the_source_directory() {
    let dir = tempfile::tempdir().unwrap();
    synthetic::write_store(dir.path(), 2, 10);
    let before = crate::electron_import::tests::tree_snapshot(dir.path());
    let (_keep, scratch) = crate::electron_import::tests::test_scratch();
    let mut db = ScratchDb::open(&scratch, dir.path()).unwrap();
    assert_eq!(db.scan_prefix(&[]).unwrap().len(), 20);
    drop(db);
    assert_eq!(crate::electron_import::tests::tree_snapshot(dir.path()), before);
}

#[test]
fn a_missing_or_empty_directory_is_an_error_not_an_empty_store() {
    let dir = tempfile::tempdir().unwrap();
    let (_keep, scratch) = crate::electron_import::tests::test_scratch();
    assert!(ScratchDb::open(&scratch, &dir.path().join("absent")).is_err());
    assert!(ScratchDb::open(&scratch, dir.path()).is_err());
}

#[test]
fn a_free_lock_file_passes_the_probe() {
    let f = macos_fixture("new");
    fs::write(f.profile.local_storage_dir().join("LOCK"), "").unwrap();
    ProfileLock::probe(&f.profile).unwrap();
}

#[cfg(unix)]
#[test]
fn a_lock_held_by_another_process_blocks_every_reader() {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    let f = macos_fixture("new");
    let lock = f.profile.local_storage_dir().join("LOCK");
    fs::write(&lock, "").unwrap();
    // LevelDB holds an fcntl write lock for its lifetime; python's lockf is the same primitive.
    let mut holder = Command::new("python3")
        .args([
            "-c",
            "import fcntl,sys,time\nf=open(sys.argv[1],'r+')\nfcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nprint('locked',flush=True)\ntime.sleep(60)",
        ])
        .arg(&lock)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(holder.stdout.as_mut().unwrap()).read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "locked");
    let probe = ProfileLock::probe(&f.profile);
    let reader = crate::electron_import::LocalStorageSnapshot::read(&f.profile, "file://", &f.scratch);
    holder.kill().unwrap();
    holder.wait().unwrap();
    assert!(matches!(probe, Err(ImportError::ProfileInUse(_))));
    assert!(matches!(reader, Err(ImportError::ProfileInUse(_))));
    ProfileLock::probe(&f.profile).unwrap();
}

#[cfg(windows)]
#[test]
fn a_lock_held_by_leveldb_style_exclusive_open_blocks_the_probe() {
    use std::os::windows::fs::OpenOptionsExt;

    let f = macos_fixture("new");
    let lock = f.profile.local_storage_dir().join("LOCK");
    fs::write(&lock, "").unwrap();
    let held = fs::OpenOptions::new().read(true).write(true).share_mode(0).open(&lock).unwrap();
    assert!(matches!(ProfileLock::probe(&f.profile), Err(ImportError::ProfileInUse(_))));
    drop(held);
    ProfileLock::probe(&f.profile).unwrap();
}

fn flip(path: &std::path::Path, offset: usize) {
    let mut bytes = fs::read(path).unwrap();
    bytes[offset] ^= 0x01;
    fs::write(path, bytes).unwrap();
}

#[test]
fn a_corrupt_write_ahead_log_is_an_error_not_a_smaller_store() {
    use crate::electron_import::YStoreReader;
    let f = macos_fixture("new");
    let dir = f.profile.crdt_store_root().join(crate::electron_import::profile::vault_dir_name(&f.expected.vault_uuid));
    let log = dir.join("000003.log");
    let len = fs::read(&log).unwrap().len();
    assert!(len > 2000);
    let clean = fs::read(&log).unwrap();
    for offset in (0..len).step_by(len / 40 + 1) {
        fs::write(&log, &clean).unwrap();
        flip(&log, offset);
        let result = YStoreReader::open_dir(&dir, &f.scratch);
        assert!(matches!(result, Err(ImportError::LevelDb(_))), "offset {offset}");
    }
    fs::write(&log, &clean).unwrap();
    assert!(YStoreReader::open_dir(&dir, &f.scratch).unwrap().is_some());
}

#[test]
fn a_corrupt_manifest_is_an_error() {
    let f = macos_fixture("new");
    let manifest = f.profile.local_storage_dir().join("MANIFEST-000001");
    flip(&manifest, 8);
    let result = crate::electron_import::LocalStorageSnapshot::read(&f.profile, "file://", &f.scratch);
    assert!(matches!(result, Err(ImportError::LevelDb(_))));
}

#[test]
fn a_torn_log_tail_still_opens_with_the_entries_before_it() {
    let f = macos_fixture("new");
    let log = f.profile.local_storage_dir().join("000003.log");
    let bytes = fs::read(&log).unwrap();
    fs::write(&log, &bytes[..bytes.len() - 5]).unwrap();
    assert!(crate::electron_import::LocalStorageSnapshot::read(&f.profile, "file://", &f.scratch).unwrap().is_some());
}

#[test]
fn scratch_copies_live_under_the_given_root_and_are_removed_on_drop() {
    let f = macos_fixture("new");
    let root = f._dir.path().join("scratch");
    let db = ScratchDb::open(&f.scratch, &f.profile.local_storage_dir()).unwrap();
    let during = fs::read_dir(&root).unwrap().count();
    drop(db);
    assert_eq!(during, 1);
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
}

#[test]
fn stale_scratch_directories_are_swept_and_fresh_ones_kept() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("scratch");
    fs::create_dir_all(root.join("electron-import-old")).unwrap();
    fs::create_dir_all(root.join("electron-import-new")).unwrap();
    fs::create_dir_all(root.join("unrelated")).unwrap();
    let old = fs::File::open(root.join("electron-import-old")).unwrap();
    old.set_modified(std::time::SystemTime::now() - Duration::from_secs(2 * 60 * 60)).unwrap();
    Scratch::new(&root).unwrap();
    assert!(!root.join("electron-import-old").exists());
    assert!(root.join("electron-import-new").exists());
    assert!(root.join("unrelated").exists());
}

#[test]
fn a_store_over_the_copy_limit_is_refused() {
    let f = macos_fixture("new");
    let tiny = f.scratch.clone().with_max_bytes(100);
    let result = crate::electron_import::LocalStorageSnapshot::read(&f.profile, "file://", &tiny);
    assert!(matches!(result, Err(ImportError::LevelDb(_))));
}

#[test]
fn a_flipped_byte_in_the_live_log_fails_the_open() {
    let dir = tempfile::tempdir().unwrap();
    synthetic::write_store(dir.path(), 2, 10);
    let (_keep, scratch) = crate::electron_import::tests::test_scratch();
    let log = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "log"))
        .unwrap();
    let mut bytes = fs::read(&log).unwrap();
    if bytes.len() > 20 {
        bytes[12] ^= 0x10;
        fs::write(&log, bytes).unwrap();
        assert!(ScratchDb::open(&scratch, dir.path()).is_err());
    }
}

#[test]
fn a_log_the_manifest_retired_is_not_verified() {
    let dir = tempfile::tempdir().unwrap();
    synthetic::write_store(dir.path(), 2, 10);
    fs::write(dir.path().join("000001.log"), b"junk of a log a flush retired").unwrap();
    let (_keep, scratch) = crate::electron_import::tests::test_scratch();
    let mut db = ScratchDb::open(&scratch, dir.path()).unwrap();
    assert_eq!(db.scan_prefix(&[]).unwrap().len(), 20);
    assert!(db.torn_tails().is_empty());
}

#[test]
fn a_torn_log_tail_opens_and_is_reported_with_its_file_and_size() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut db = rusty_leveldb::DB::open(dir.path(), rusty_leveldb::Options::default()).unwrap();
        db.put(b"a", b"1").unwrap();
        db.put(b"b", &[7; 200]).unwrap();
        // The log is only closed by drop, which leaves it unflushed: that is the live-log shape.
    }
    let log = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "log"))
        .max()
        .unwrap();
    let bytes = fs::read(&log).unwrap();
    fs::write(&log, &bytes[..bytes.len() - 10]).unwrap();
    let (_keep, scratch) = crate::electron_import::tests::test_scratch();
    let db = ScratchDb::open(&scratch, dir.path()).unwrap();
    let torn = db.torn_tails();
    assert_eq!(torn.len(), 1, "{torn:?}");
    assert_eq!(torn[0].file, log.file_name().unwrap().to_string_lossy());
    assert!(torn[0].dropped_bytes > 0);
}
