//! Atomic writes on a real directory (`file-ops.ts` `atomicWrite`).

use std::cell::Cell;
use std::io;
use std::time::Duration;

#[cfg(windows)]
use memry_desktop::vault::fs_atomic::atomic_write_checked;
use memry_desktop::vault::fs_atomic::{
    atomic_write, atomic_write_with, is_transient, rename_no_replace, with_transient_retry,
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

/// A rename onto anything there (a file, a folder, empty or not) fails with `AlreadyExists` and
/// leaves both as they were, and a folder never moves into itself; a case-only rename and a
/// rename to a free name go through, for a file and a folder.
#[test]
fn a_rename_never_replaces_what_is_there() {
    let dir = tempfile::tempdir().unwrap();
    let p = |rel: &str| dir.path().join(rel);
    std::fs::write(p("a.md"), "a").unwrap();
    std::fs::write(p("b.md"), "b").unwrap();
    std::fs::create_dir_all(p("folder/sub")).unwrap();
    std::fs::create_dir(p("empty")).unwrap();
    for (from, to) in [
        ("a.md", "b.md"),
        ("a.md", "empty"),
        ("folder", "empty"),
        ("folder", "b.md"),
        ("empty", "folder"),
    ] {
        let error = rename_no_replace(&p(from), &p(to)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists, "{from} -> {to}");
    }
    assert!(rename_no_replace(&p("folder"), &p("folder/sub/inner")).is_err());
    assert_eq!(dir_entries(dir.path()), ["a.md", "b.md", "empty", "folder"]);
    assert_eq!(std::fs::read(p("a.md")).unwrap(), b"a");
    assert_eq!(std::fs::read(p("b.md")).unwrap(), b"b");
    assert_eq!(dir_entries(&p("folder")), ["sub"]);
    assert!(dir_entries(&p("empty")).is_empty());

    rename_no_replace(&p("a.md"), &p("A.md")).unwrap();
    rename_no_replace(&p("folder"), &p("Folder")).unwrap();
    rename_no_replace(&p("Folder"), &p("moved")).unwrap();
    assert_eq!(dir_entries(dir.path()), ["A.md", "b.md", "empty", "moved"]);
    assert_eq!(std::fs::read(p("A.md")).unwrap(), b"a");
    assert_eq!(dir_entries(&p("moved")), ["sub"]);
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

/// Opens `path` for reading with a share mode that refuses `DELETE`, as a scanner or sync client
/// that does not allow renames does: a rename over the file is denied while this handle lives.
#[cfg(windows)]
fn hold_without_share_delete(path: &std::path::Path) -> std::fs::File {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ_WRITE: u32 = 0x1 | 0x2;
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ_WRITE)
        .open(path)
        .unwrap()
}

#[cfg(windows)]
#[test]
fn a_save_over_a_file_held_open_for_reading_succeeds() {
    // std opens with FILE_SHARE_DELETE, as an antivirus-style reader that allows renames does.
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("note.md");
    std::fs::write(&target, "old").unwrap();
    let _held = std::fs::File::open(&target).unwrap();
    // The reader never lets go, so a failure here is not a lock window that closes: it is the
    // replace itself. A runner can hold the file for longer than the default 650 ms schedule
    // (this test failed once on windows-2022 with a persistent access denied and no other
    // process of ours involved), so the budget is 50 attempts, not the production four.
    let delays = [Duration::from_millis(100); 50];
    atomic_write_with(&target, b"new", &delays).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"new");
}

#[cfg(windows)]
#[test]
fn a_lock_that_forbids_renames_is_retried_until_it_lifts() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("note.md");
    std::fs::write(&target, "old").unwrap();
    let mut lock = Some(hold_without_share_delete(&target));
    let mut attempts = 0;
    // The check runs once per attempt, right before the rename: the lock lifts before the third.
    let mut before_commit = || {
        attempts += 1;
        if attempts == 3 {
            lock.take();
        }
        Ok(())
    };
    atomic_write_checked(&target, b"new", &[Duration::ZERO; 3], &mut before_commit).unwrap();
    assert_eq!(attempts, 3, "two denied attempts, then the save");
    assert_eq!(std::fs::read(&target).unwrap(), b"new");
    assert_eq!(dir_entries(dir.path()), ["note.md"]);
}

#[cfg(windows)]
#[test]
fn a_lock_that_never_lifts_fails_after_the_attempts_and_leaves_the_note_and_no_temp() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("note.md");
    std::fs::write(&target, "old").unwrap();
    let _lock = hold_without_share_delete(&target);
    let mut attempts = 0;
    let mut before_commit = || {
        attempts += 1;
        Ok(())
    };
    let err = atomic_write_checked(&target, b"new", &[Duration::ZERO; 3], &mut before_commit)
        .unwrap_err();
    assert!(is_transient(&err.source), "{:?}", err.source);
    assert_eq!(err.path, target);
    assert_eq!(attempts, 4, "three retries and one last attempt");
    assert_eq!(std::fs::read(&target).unwrap(), b"old");
    assert_eq!(dir_entries(dir.path()), ["note.md"]);
}
