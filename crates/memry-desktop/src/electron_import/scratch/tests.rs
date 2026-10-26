use std::fs;

use super::*;
use crate::electron_import::tests::{macos_fixture, synthetic};

#[test]
fn copy_skips_lock_and_subdirectories() {
    let src = tempfile::tempdir().unwrap();
    fs::write(src.path().join("LOCK"), "").unwrap();
    fs::write(src.path().join("CURRENT"), "x").unwrap();
    fs::create_dir(src.path().join("sub")).unwrap();
    let dst = tempfile::tempdir().unwrap();
    copy_leveldb_dir(src.path(), dst.path()).unwrap();
    let names: Vec<_> = fs::read_dir(dst.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, ["CURRENT"]);
}

#[test]
fn opening_never_changes_the_source_directory() {
    let dir = tempfile::tempdir().unwrap();
    synthetic::write_store(dir.path(), 2, 10);
    let before = crate::electron_import::tests::tree_snapshot(dir.path());
    let mut db = ScratchDb::open(dir.path()).unwrap();
    assert_eq!(db.scan_prefix(&[]).unwrap().len(), 20);
    drop(db);
    assert_eq!(crate::electron_import::tests::tree_snapshot(dir.path()), before);
}

#[test]
fn a_missing_or_empty_directory_is_an_error_not_an_empty_store() {
    let dir = tempfile::tempdir().unwrap();
    assert!(ScratchDb::open(&dir.path().join("absent")).is_err());
    assert!(ScratchDb::open(dir.path()).is_err());
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
    let reader = crate::electron_import::LocalStorageSnapshot::read(&f.profile, "file://");
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
