use std::fs;

use super::*;

fn staging() -> (tempfile::TempDir, DropStaging) {
    let dir = tempfile::tempdir().expect("temp dir");
    let staging = DropStaging::new(dir.path().join("drop-staging"));
    (dir, staging)
}

fn stage(staging: &DropStaging, name: &str, bytes: &[u8]) -> (String, PathBuf) {
    let id = staging.begin(name, bytes.len() as u64).expect("begin");
    for (index, chunk) in bytes.chunks(4).enumerate() {
        staging
            .write_chunk(&id, (index * 4) as u64, chunk)
            .expect("chunk");
    }
    let path = staging.finish(&id).expect("finish");
    (id, path)
}

#[test]
fn a_staged_file_holds_the_bytes_in_order_under_its_own_directory() {
    let (_dir, staging) = staging();
    let (id, path) = stage(&staging, "notes.md", b"hello staged world");
    assert_eq!(fs::read(&path).expect("read"), b"hello staged world");
    assert_eq!(path, staging.root().join(&id).join("notes.md"));
}

#[test]
fn an_empty_file_stages() {
    let (_dir, staging) = staging();
    let (_, path) = stage(&staging, "empty.txt", b"");
    assert_eq!(fs::metadata(path).expect("meta").len(), 0);
}

#[test]
fn a_chunk_that_does_not_continue_the_file_is_refused() {
    let (_dir, staging) = staging();
    let id = staging.begin("a.txt", 8).expect("begin");
    staging.write_chunk(&id, 0, b"abcd").expect("first");
    for offset in [0, 2, 8] {
        assert!(matches!(
            staging.write_chunk(&id, offset, b"x"),
            Err(StageError::OutOfOrder)
        ));
    }
    staging.write_chunk(&id, 4, b"efgh").expect("second");
    assert_eq!(
        fs::read(staging.finish(&id).expect("finish")).expect("read"),
        b"abcdefgh"
    );
}

#[test]
fn a_chunk_past_the_declared_size_is_refused() {
    let (_dir, staging) = staging();
    let id = staging.begin("a.txt", 3).expect("begin");
    assert!(matches!(
        staging.write_chunk(&id, 0, b"abcd"),
        Err(StageError::Overrun)
    ));
    assert!(matches!(
        staging
            .write_chunk(&id, 0, &[0u8; 2])
            .and_then(|()| staging.write_chunk(&id, 2, b"xy")),
        Err(StageError::Overrun)
    ));
}

#[test]
fn an_incomplete_file_does_not_finish() {
    let (_dir, staging) = staging();
    let id = staging.begin("a.txt", 4).expect("begin");
    staging.write_chunk(&id, 0, b"ab").expect("chunk");
    assert!(matches!(staging.finish(&id), Err(StageError::Incomplete)));
    // It stays open: the rest can still arrive.
    staging.write_chunk(&id, 2, b"cd").expect("rest");
    staging.finish(&id).expect("finish");
}

#[test]
fn a_file_over_the_cap_is_refused_before_anything_is_created() {
    let (_dir, staging) = staging();
    assert!(matches!(
        staging.begin("big.bin", MAX_FILE_BYTES + 1),
        Err(StageError::TooLarge)
    ));
    assert!(!staging.root().exists());
    staging
        .begin("edge.bin", MAX_FILE_BYTES)
        .expect("the cap itself");
}

#[test]
fn unknown_and_finished_ids_take_no_chunks() {
    let (_dir, staging) = staging();
    assert!(matches!(
        staging.write_chunk("nope", 0, b"x"),
        Err(StageError::UnknownId)
    ));
    let (id, _) = stage(&staging, "a.txt", b"abc");
    assert!(matches!(
        staging.write_chunk(&id, 3, b"x"),
        Err(StageError::UnknownId)
    ));
}

#[test]
fn open_transfers_are_capped_and_a_finished_one_frees_its_slot() {
    let (_dir, staging) = staging();
    let ids: Vec<String> = (0..MAX_OPEN)
        .map(|n| staging.begin(&format!("{n}.txt"), 1).expect("begin"))
        .collect();
    assert!(matches!(
        staging.begin("x.txt", 1),
        Err(StageError::TooManyOpen)
    ));
    staging.write_chunk(&ids[0], 0, b"a").expect("chunk");
    staging.finish(&ids[0]).expect("finish");
    staging.begin("x.txt", 1).expect("a slot is free again");
}

#[test]
fn an_abandoned_transfer_is_reclaimed_with_its_directory() {
    let (_dir, staging) = staging();
    let stale = staging.begin("stale.txt", 1).expect("begin");
    lock(&staging.open)[&stale].lock().expect("lock").touched =
        Instant::now().checked_sub(IDLE_LIMIT).expect("past");
    staging.begin("fresh.txt", 1).expect("begin");
    assert!(!staging.root().join(&stale).exists());
    assert!(matches!(
        staging.write_chunk(&stale, 0, b"x"),
        Err(StageError::UnknownId)
    ));
}

#[test]
fn release_removes_finished_and_open_copies_and_ignores_names_it_did_not_issue() {
    let (dir, staging) = staging();
    let (done, done_path) = stage(&staging, "a.txt", b"abc");
    let open = staging.begin("b.txt", 5).expect("begin");
    let outside = dir.path().join("keep");
    fs::create_dir_all(&outside).expect("outside");
    fs::write(outside.join("file"), b"keep").expect("write");

    staging
        .release(&[
            done.clone(),
            open.clone(),
            "../keep".to_owned(),
            "..".to_owned(),
            outside.to_string_lossy().into_owned(),
            "unknown".to_owned(),
            "0".repeat(32),
        ])
        .expect("release");

    assert!(!done_path.exists());
    assert!(!staging.root().join(&open).exists());
    assert!(outside.join("file").exists());
    assert!(matches!(
        staging.write_chunk(&open, 0, b"x"),
        Err(StageError::UnknownId)
    ));
}

#[test]
fn sweep_removes_only_directories_older_than_the_limit() {
    let (_dir, staging) = staging();
    let (old, _) = stage(&staging, "old.txt", b"o");
    let (fresh, _) = stage(&staging, "new.txt", b"n");
    fs::write(staging.root().join("loose-file"), b"x").expect("loose");

    let later = SystemTime::now() + Duration::from_secs(2 * 24 * 60 * 60);
    assert_eq!(staging.sweep(later, STALE_AFTER).expect("sweep"), 2);
    assert!(
        staging.root().join("loose-file").exists(),
        "only directories go"
    );

    let (kept, _) = stage(&staging, "kept.txt", b"k");
    assert_eq!(
        staging
            .sweep(SystemTime::now(), STALE_AFTER)
            .expect("sweep"),
        0
    );
    assert!(staging.root().join(&kept).exists());
    assert!(!staging.root().join(&old).exists() && !staging.root().join(&fresh).exists());
}

#[test]
fn sweep_of_a_root_that_does_not_exist_is_a_no_op() {
    let (_dir, staging) = staging();
    assert_eq!(
        staging
            .sweep(SystemTime::now(), STALE_AFTER)
            .expect("sweep"),
        0
    );
}

#[test]
fn names_cannot_leave_their_directory_and_are_creatable_everywhere() {
    let cases = [
        ("../../etc/passwd", "....etcpasswd"),
        ("a/b\\c.txt", "abc.txt"),
        ("tab\tname\n.md", "tabname.md"),
        ("what?.md", "what_.md"),
        ("c:file|x.png", "c_file_x.png"),
        ("trailing. . ", "trailing"),
        ("..", "file"),
        ("", "file"),
        ("   ", "file"),
        ("CON", "_CON"),
        ("nul.txt", "_nul.txt"),
        ("Com1.tar.gz", "_Com1.tar.gz"),
        ("console.txt", "console.txt"),
        (".hidden", ".hidden"),
        ("Résumé 日本語.md", "Résumé 日本語.md"),
    ];
    for (input, expected) in cases {
        assert_eq!(sanitize_file_name(input), expected, "{input:?}");
    }
}

#[test]
fn a_long_name_keeps_its_extension_and_a_char_boundary() {
    let long = format!("{}.pdf", "é".repeat(300));
    let name = sanitize_file_name(&long);
    assert!(name.len() <= 200, "{}", name.len());
    assert!(name.ends_with(".pdf"));
    assert!(name.starts_with('é'));

    let no_extension = sanitize_file_name(&"x".repeat(500));
    assert_eq!(no_extension.len(), 200);

    let huge_extension = sanitize_file_name(&format!("a.{}", "e".repeat(400)));
    assert!(huge_extension.len() <= 200);
}

fn source(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> (PathBuf, String) {
    let path = dir.path().join(name);
    fs::write(&path, bytes).expect("write source");
    let uri = url::Url::from_file_path(&path)
        .expect("file uri")
        .to_string();
    (path, uri)
}

#[test]
fn files_of_the_offered_os_drag_stage_as_copies_by_their_uri() {
    let (dir, staging) = staging();
    let big: Vec<u8> = (0..3 * 1024 * 1024 + 17).map(|i| (i % 251) as u8).collect();
    let (note, note_uri) = source(&dir, "my note.md", b"dropped from the file manager");
    let (_, big_uri) = source(&dir, "scan.pdf", &big);
    staging.offer_os_drag(&[note_uri.as_str(), "https://example.org/x", big_uri.as_str()]);

    let staged = staging
        .stage_os_drop(&[note_uri, big_uri])
        .expect("stage the drop");

    assert_eq!(staged.len(), 2);
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
fn a_uri_outside_the_offered_drag_stages_nothing() {
    let (dir, staging) = staging();
    let (_, dropped) = source(&dir, "dropped.md", b"a");
    let (_, other) = source(&dir, "secret.md", b"b");
    staging.offer_os_drag(&[dropped.as_str()]);

    assert!(matches!(
        staging.stage_os_drop(&[dropped, other]),
        Err(StageError::NotDropped)
    ));
    assert!(fs::read_dir(staging.root()).map_or(true, |mut entries| entries.next().is_none()));
}

#[test]
fn an_offered_drag_is_used_up_by_one_drop_and_replaced_by_the_next() {
    let (dir, staging) = staging();
    let (_, first) = source(&dir, "first.md", b"1");
    let (_, second) = source(&dir, "second.md", b"2");
    staging.offer_os_drag(&[first.as_str()]);
    staging.offer_os_drag(&[second.as_str()]);
    assert!(matches!(
        staging.stage_os_drop(std::slice::from_ref(&first)),
        Err(StageError::NotDropped)
    ));

    staging.offer_os_drag(&[second.as_str()]);
    staging
        .stage_os_drop(std::slice::from_ref(&second))
        .expect("first use");
    assert!(matches!(
        staging.stage_os_drop(&[second]),
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
    staging.offer_os_drag(&[note.as_str(), folder_uri.as_str()]);

    let refused = staging.stage_os_drop(&[note, folder_uri]);

    // Unix opens a directory and reads its metadata; Windows refuses to open it.
    assert!(matches!(
        refused,
        Err(StageError::NotAFile | StageError::Io(_))
    ));
    assert!(fs::read_dir(staging.root()).map_or(true, |mut entries| entries.next().is_none()));
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
