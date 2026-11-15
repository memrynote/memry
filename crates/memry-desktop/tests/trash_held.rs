//! The Recycle Bin takes a folder a virus scanner or a cloud-sync client holds for a moment
//! (#4668): the shell aborts the delete while a file inside is open without `FILE_SHARE_DELETE`,
//! and `move_to_trash` tries again until the hold is gone.

use std::fs;
use std::os::windows::fs::OpenOptionsExt;
use std::thread;
use std::time::Duration;

use memry_desktop::vault::trash::move_to_trash;

/// The way most programs open a file: nothing may delete or rename it while they hold it.
const FILE_SHARE_READ: u32 = 1;

#[test]
fn a_folder_held_for_a_moment_still_goes_to_the_trash() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("Work");
    fs::create_dir(&folder).unwrap();
    let note = folder.join("a.md");
    fs::write(&note, "a").unwrap();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(&note)
        .unwrap();
    // Let go after the first attempts, before the last one (50 + 150 + 450 ms of waits).
    let release = thread::spawn(move || {
        thread::sleep(Duration::from_millis(100));
        drop(held);
    });

    move_to_trash(&folder).unwrap();

    release.join().unwrap();
    assert!(!folder.exists());
}
