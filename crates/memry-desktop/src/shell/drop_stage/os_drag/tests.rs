use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::super::{DropStaging, StageError};
use super::{OS_DROP_TTL, file_uri_path};

fn staging() -> (tempfile::TempDir, DropStaging) {
    let dir = tempfile::tempdir().expect("temp dir");
    let staging = DropStaging::new(dir.path().join("drop-staging"));
    (dir, staging)
}

fn source(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> (PathBuf, String) {
    let path = dir.path().join(name);
    fs::write(&path, bytes).expect("write source");
    let uri = url::Url::from_file_path(&path)
        .expect("file uri")
        .to_string();
    (path, uri)
}

/// A drag from outside the app, offering `uris`, dropped at `at`.
fn drop_os(staging: &DropStaging, drag: u64, uris: &[&str], at: Instant) {
    staging.os_drag_offered(drag, uris);
    staging.os_drag_dropped(drag, at);
}

fn nothing_staged(staging: &DropStaging) -> bool {
    fs::read_dir(staging.root()).map_or(true, |mut entries| entries.next().is_none())
}

#[test]
fn files_of_a_dropped_os_drag_are_read_back_and_staged_as_copies() {
    let (dir, staging) = staging();
    let big: Vec<u8> = (0..3 * 1024 * 1024 + 17).map(|i| (i % 251) as u8).collect();
    let (note, note_uri) = source(&dir, "my note.md", b"dropped from the file manager");
    let (_, big_uri) = source(&dir, "scan.pdf", &big);
    let now = Instant::now();
    drop_os(
        &staging,
        1,
        &[&note_uri, "https://example.org/x", &big_uri],
        now,
    );

    // What the page reads back: the drag's files, in order, without the web link.
    let uris = staging.os_drop_uris(now).expect("dropped");
    assert_eq!(uris, [note_uri.clone(), big_uri.clone()]);
    let staged = staging.stage_os_drop(&uris, now).expect("stage the drop");

    let (note_id, note_copy) = &staged[0];
    assert_eq!(note_copy, &staging.root().join(note_id).join("my note.md"));
    assert_eq!(
        fs::read(note_copy).expect("read"),
        b"dropped from the file manager"
    );
    assert_eq!(fs::read(&staged[1].1).expect("read"), big);
    // A copy: the original stays where it was.
    assert!(note.exists());
}

#[test]
fn a_drag_that_was_only_offered_is_neither_read_nor_staged() {
    // The pointer crossed the window with a file and left, or the drop was cancelled.
    let (dir, staging) = staging();
    let (_, uri) = source(&dir, "hovered.md", b"a");
    let now = Instant::now();
    staging.os_drag_offered(1, &[uri.as_str()]);

    assert!(matches!(
        staging.os_drop_uris(now),
        Err(StageError::NotDropped)
    ));
    assert!(matches!(
        staging.stage_os_drop(&[uri], now),
        Err(StageError::NotDropped)
    ));
    assert!(nothing_staged(&staging));
}

#[test]
fn a_drop_is_usable_only_within_the_ttl() {
    let (dir, staging) = staging();
    let (_, uri) = source(&dir, "late.md", b"a");
    let dropped = Instant::now();
    drop_os(&staging, 1, &[&uri], dropped);
    let late = dropped + OS_DROP_TTL + Duration::from_millis(1);

    assert!(matches!(
        staging.os_drop_uris(late),
        Err(StageError::NotDropped)
    ));
    assert!(matches!(
        staging.stage_os_drop(&[uri], late),
        Err(StageError::NotDropped)
    ));
}

#[test]
fn a_uri_outside_the_drop_stages_nothing() {
    let (dir, staging) = staging();
    let (_, dropped) = source(&dir, "dropped.md", b"a");
    let (_, other) = source(&dir, "secret.md", b"b");
    let now = Instant::now();
    drop_os(&staging, 1, &[&dropped], now);

    assert!(matches!(
        staging.stage_os_drop(&[dropped, other], now),
        Err(StageError::NotDropped)
    ));
    assert!(nothing_staged(&staging));
}

#[test]
fn a_drop_is_used_up_by_one_staging() {
    let (dir, staging) = staging();
    let (_, uri) = source(&dir, "once.md", b"a");
    let now = Instant::now();
    drop_os(&staging, 1, &[&uri], now);

    staging
        .stage_os_drop(std::slice::from_ref(&uri), now)
        .expect("first use");
    assert!(matches!(
        staging.os_drop_uris(now),
        Err(StageError::NotDropped)
    ));
    assert!(matches!(
        staging.stage_os_drop(&[uri], now),
        Err(StageError::NotDropped)
    ));
}

#[test]
fn only_the_recorded_drag_is_marked_dropped_and_a_drop_freezes_its_files() {
    let (dir, staging) = staging();
    let (_, first) = source(&dir, "first.md", b"1");
    let (_, second) = source(&dir, "second.md", b"2");
    let now = Instant::now();

    // A new drag replaces the record; a drop of the old one marks nothing.
    staging.os_drag_offered(1, &[first.as_str()]);
    staging.os_drag_offered(2, &[second.as_str()]);
    staging.os_drag_dropped(1, now);
    assert!(matches!(
        staging.os_drop_uris(now),
        Err(StageError::NotDropped)
    ));

    // Data offered after the drop does not change what was dropped.
    staging.os_drag_dropped(2, now);
    staging.os_drag_offered(2, &[first.as_str()]);
    assert_eq!(staging.os_drop_uris(now).expect("dropped"), [second]);
}

#[test]
fn a_drag_the_app_started_clears_the_record() {
    // A page drags its own `file://` link: the shell forgets the earlier OS drop.
    let (dir, staging) = staging();
    let (_, uri) = source(&dir, "earlier.md", b"a");
    let now = Instant::now();
    drop_os(&staging, 1, &[&uri], now);

    staging.os_drag_cleared();

    assert!(matches!(
        staging.stage_os_drop(&[uri], now),
        Err(StageError::NotDropped)
    ));
}

#[test]
fn a_dropped_folder_is_refused_and_the_copies_before_it_are_released() {
    let (dir, staging) = staging();
    let (_, note) = source(&dir, "note.md", b"n");
    let folder = dir.path().join("photos");
    fs::create_dir(&folder).expect("folder");
    let folder_uri = url::Url::from_file_path(&folder).expect("uri").to_string();
    let now = Instant::now();
    drop_os(&staging, 1, &[&note, &folder_uri], now);

    let refused = staging.stage_os_drop(&[note, folder_uri], now);

    assert!(matches!(refused, Err(StageError::NotAFile)));
    assert!(nothing_staged(&staging));
}

#[cfg(unix)]
#[test]
fn a_dropped_fifo_is_refused_without_waiting_for_a_writer() {
    let (dir, staging) = staging();
    let fifo = dir.path().join("pipe.md");
    let path = std::ffi::CString::new(fifo.to_str().expect("utf-8")).expect("c path");
    // SAFETY: `path` is a valid NUL-terminated string that outlives the call.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    let uri = url::Url::from_file_path(&fifo).expect("uri").to_string();
    let now = Instant::now();
    drop_os(&staging, 1, &[&uri], now);

    assert!(matches!(
        staging.stage_os_drop(&[uri], now),
        Err(StageError::NotAFile)
    ));
}

#[test]
fn only_local_file_uris_name_a_path() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("a b#c.md");
    let uri = url::Url::from_file_path(&path).expect("uri").to_string();
    assert_eq!(file_uri_path(&uri), Some(path));
    assert_eq!(file_uri_path(&format!("{uri}\r")), file_uri_path(&uri));
    for other in [
        "https://example.org/a.md",
        "memry-file://local/a.md",
        "not a uri",
        "",
    ] {
        assert_eq!(file_uri_path(other), None, "{other}");
    }
}
