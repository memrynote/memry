//! Atomic writes on a real directory (`file-ops.ts` `atomicWrite`).

use std::cell::Cell;
use std::io;
use std::time::Duration;

use memry_desktop::vault::fs_atomic::{
    atomic_write, atomic_write_with, is_transient, with_transient_retry,
};

fn dir_entries(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn a_write_creates_parents_replaces_an_existing_file_and_leaves_no_temp() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("a/b/note.md");
    atomic_write(&target, b"first").unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"first");
    atomic_write(&target, b"second, longer").unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"second, longer");
    assert_eq!(dir_entries(&dir.path().join("a/b")), ["note.md"]);
}

#[cfg(unix)]
#[test]
fn the_written_file_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("note.md");
    atomic_write(&target, b"x").unwrap();
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn a_failed_write_reports_the_path_and_errno_and_leaves_the_target_and_no_temp() {
    let dir = tempfile::tempdir().unwrap();
    // The target is a directory: the rename over it fails after the temp file was written.
    let target = dir.path().join("note.md");
    std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("keep"), "x").unwrap();
    let err = atomic_write_with(&target, b"new", &[]).unwrap_err();
    assert_eq!(err.path, target);
    assert!(err.source.raw_os_error().is_some());
    assert_eq!(
        dir_entries(dir.path()),
        ["note.md"],
        "no temp file may remain"
    );
    assert_eq!(std::fs::read(target.join("keep")).unwrap(), b"x");
}

#[test]
fn a_transient_failure_is_retried_with_the_delays_and_then_once_more() {
    let delays = [Duration::ZERO; 3];
    let calls = Cell::new(0);
    let result = with_transient_retry(&delays, || {
        calls.set(calls.get() + 1);
        if calls.get() < 3 {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        } else {
            Ok(calls.get())
        }
    });
    assert_eq!(result.unwrap(), 3);

    calls.set(0);
    let result: io::Result<()> = with_transient_retry(&delays, || {
        calls.set(calls.get() + 1);
        Err(io::Error::from(io::ErrorKind::PermissionDenied))
    });
    assert!(result.is_err());
    assert_eq!(calls.get(), 4, "three retries and one last attempt");

    calls.set(0);
    let result: io::Result<()> = with_transient_retry(&delays, || {
        calls.set(calls.get() + 1);
        Err(io::Error::from(io::ErrorKind::NotFound))
    });
    assert!(result.is_err());
    assert_eq!(calls.get(), 1, "a non-transient error is not retried");
}

#[test]
fn sharing_violations_are_transient() {
    assert!(is_transient(&io::Error::from(
        io::ErrorKind::PermissionDenied
    )));
    assert!(is_transient(&io::Error::from(io::ErrorKind::ResourceBusy)));
    assert!(!is_transient(&io::Error::from(io::ErrorKind::NotFound)));
    assert_eq!(
        is_transient(&io::Error::from_raw_os_error(32)),
        cfg!(windows)
    );
    assert_eq!(
        is_transient(&io::Error::from_raw_os_error(33)),
        cfg!(windows)
    );
}

#[cfg(windows)]
#[test]
fn a_save_over_a_file_held_open_for_reading_succeeds() {
    // std opens with FILE_SHARE_DELETE, as an antivirus-style reader that allows renames does.
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("note.md");
    std::fs::write(&target, "old").unwrap();
    let _held = std::fs::File::open(&target).unwrap();
    atomic_write(&target, b"new").unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"new");
}
