//! `note_files` on a real SQLite file (desktop Step 12): the path identity of
//! vault files survives a close and reopen, collisions are refused without a
//! partial write, and a folder move is all or nothing.

use memry_core::api::errors::StorageError;
use memry_core::api::note_files::NoteFiles;
use memry_core::api::vault::Vault;
use memry_core::domain::note_files::NoteFileStat;

struct Fixture {
    dir: tempfile::TempDir,
    vault: Vault,
}

fn open_at(dir: &std::path::Path) -> Vault {
    Vault::open("vault-1".to_owned(), dir.display().to_string()).expect("open")
}

fn fixture() -> Fixture {
    let dir = tempfile::Builder::new()
        .prefix("memry-note-files-")
        .tempdir()
        .expect("the scratch directory");
    let vault = open_at(dir.path());
    Fixture { dir, vault }
}

fn stat(id: &str, path: &str) -> NoteFileStat {
    NoteFileStat {
        note_id: id.to_owned(),
        path: path.to_owned(),
        file_type: "markdown".to_owned(),
        mime_type: None,
        file_size: Some(10),
        content_hash: Some("00000001".to_owned()),
        indexed_at: 1,
    }
}

fn paths(files: &NoteFiles) -> Vec<(String, String)> {
    let mut all: Vec<_> = files
        .list_missing_candidates()
        .expect("list")
        .into_iter()
        .map(|f| (f.note_id, f.path))
        .collect();
    all.sort();
    all
}

#[test]
fn rows_survive_a_reopen_and_keep_local_only_across_a_stat_write() {
    let Fixture { dir, vault } = fixture();
    let files = vault.note_files();
    files.upsert_stat(stat("n1", "notes/a.md")).expect("insert");
    files.set_local_only("n1", true).expect("local only");
    let mut again = stat("n1", "notes/a.md");
    again.file_size = Some(99);
    again.content_hash = None;
    files.upsert_stat(again).expect("update");
    drop(files);
    drop(vault);

    let files = open_at(dir.path()).note_files();
    let row = files.by_path("notes/a.md").expect("read").expect("row");
    assert_eq!(row.note_id, "n1");
    assert_eq!(row.file_size, Some(99));
    assert!(row.local_only, "a stat write must not reset local_only");
    assert_eq!(row.content_hash, None, "a stat write replaces the hash");
    assert_eq!(files.local_only_count().expect("count"), 1);
    assert_eq!(files.by_id("n1").expect("read"), Some(row));
}

#[test]
fn a_path_held_by_another_note_is_refused_and_leaves_both_rows() {
    let Fixture { vault, .. } = fixture();
    let files = vault.note_files();
    files.upsert_stat(stat("n1", "a.md")).expect("insert");
    files.upsert_stat(stat("n2", "b.md")).expect("insert");

    let err = files.upsert_stat(stat("n2", "a.md")).expect_err("taken");
    assert!(matches!(err, StorageError::Invalid { .. }), "{err:?}");
    let err = files.rename_path("n2", "a.md").expect_err("taken");
    assert!(matches!(err, StorageError::Invalid { .. }), "{err:?}");
    assert_eq!(
        paths(&files),
        [("n1".into(), "a.md".into()), ("n2".into(), "b.md".into())]
    );

    // The same note arriving at a new path is not a collision with itself.
    files.upsert_stat(stat("n2", "c.md")).expect("moves");
    files.rename_path("n2", "c.md").expect("same path is fine");
    assert!(files.by_path("b.md").expect("read").is_none());
}

#[test]
fn missing_rows_report_not_found_and_remove_is_idempotent() {
    let Fixture { vault, .. } = fixture();
    let files = vault.note_files();
    for result in [
        files.set_hash("ghost", Some("x")),
        files.rename_path("ghost", "x.md"),
        files.set_local_only("ghost", true),
    ] {
        assert!(matches!(result, Err(StorageError::NotFound { .. })));
    }
    files.upsert_stat(stat("n1", "a.md")).expect("insert");
    files.set_hash("n1", Some("abcdef01")).expect("hash");
    assert_eq!(
        files.by_id("n1").unwrap().unwrap().content_hash.as_deref(),
        Some("abcdef01")
    );
    assert!(files.remove("n1").expect("remove"));
    assert!(!files.remove("n1").expect("again"));
}

#[test]
fn paths_outside_the_format_are_refused() {
    let Fixture { vault, .. } = fixture();
    let files = vault.note_files();
    for bad in [
        "",
        "/a.md",
        "a/",
        "a//b.md",
        "./a.md",
        "a/../b.md",
        "a\\b.md",
        "a\0b.md",
    ] {
        let err = files.upsert_stat(stat("n1", bad)).expect_err(bad);
        assert!(
            matches!(err, StorageError::Invalid { .. }),
            "{bad:?}: {err:?}"
        );
    }
    assert!(paths(&files).is_empty());
}

#[test]
fn nfc_and_nfd_spellings_and_case_variants_are_distinct_keys() {
    let Fixture { vault, .. } = fixture();
    let files = vault.note_files();
    files.upsert_stat(stat("n1", "caf\u{e9}.md")).expect("nfc");
    files
        .upsert_stat(stat("n2", "cafe\u{301}.md"))
        .expect("nfd");
    files.upsert_stat(stat("n3", "A.md")).expect("upper");
    files.upsert_stat(stat("n4", "a.md")).expect("lower");
    assert_eq!(paths(&files).len(), 4);
}

#[test]
fn rename_prefix_moves_a_folder_and_ignores_lookalikes() {
    let Fixture { vault, .. } = fixture();
    let files = vault.note_files();
    for (id, path) in [
        ("n1", "notes/a.md"),
        ("n2", "notes/deep/b.md"),
        ("n3", "notes-old/c.md"),
        ("n4", "notesx.md"),
        ("n5", "notes.md"),
    ] {
        files.upsert_stat(stat(id, path)).expect("insert");
    }
    assert_eq!(files.rename_prefix("notes/", "docs").expect("move"), 2);
    assert_eq!(
        paths(&files),
        [
            ("n1".into(), "docs/a.md".into()),
            ("n2".into(), "docs/deep/b.md".into()),
            ("n3".into(), "notes-old/c.md".into()),
            ("n4".into(), "notesx.md".into()),
            ("n5".into(), "notes.md".into()),
        ]
    );
}

#[test]
fn rename_prefix_with_overlapping_targets_does_not_collide_with_itself() {
    let Fixture { vault, .. } = fixture();
    let files = vault.note_files();
    // `a/b` -> `a`: a/b/b/x.md takes the path a/b/x.md that a/b/x.md leaves.
    files.upsert_stat(stat("n1", "a/b/x.md")).unwrap();
    files.upsert_stat(stat("n2", "a/b/b/x.md")).unwrap();
    assert_eq!(files.rename_prefix("a/b", "a").expect("move"), 2);
    assert_eq!(
        paths(&files),
        [
            ("n1".into(), "a/x.md".into()),
            ("n2".into(), "a/b/x.md".into())
        ]
    );
}

#[test]
fn a_colliding_rename_prefix_changes_no_row() {
    let Fixture { vault, .. } = fixture();
    let files = vault.note_files();
    files.upsert_stat(stat("n1", "src/a.md")).unwrap();
    files.upsert_stat(stat("n2", "src/z.md")).unwrap();
    files.upsert_stat(stat("n3", "dst/z.md")).unwrap();
    let before = paths(&files);
    let err = files
        .rename_prefix("src", "dst")
        .expect_err("z.md is taken");
    assert!(matches!(err, StorageError::Invalid { .. }), "{err:?}");
    assert_eq!(paths(&files), before);
}

#[test]
fn rename_prefix_refuses_a_move_into_itself_and_a_bad_prefix() {
    let Fixture { vault, .. } = fixture();
    let files = vault.note_files();
    files.upsert_stat(stat("n1", "a/x.md")).unwrap();
    for (old, new) in [("a", "a/b"), ("", "b"), ("a", ""), ("a", "/b")] {
        let err = files.rename_prefix(old, new).expect_err(old);
        assert!(
            matches!(err, StorageError::Invalid { .. }),
            "{old:?}: {err:?}"
        );
    }
    assert_eq!(files.rename_prefix("a", "a/").expect("same folder"), 0);
    assert_eq!(paths(&files), [("n1".into(), "a/x.md".into())]);
}

#[test]
fn missing_candidates_skip_attachments_that_never_arrived() {
    let Fixture { vault, .. } = fixture();
    let files = vault.note_files();
    files.upsert_stat(stat("note", "a.md")).unwrap();
    let mut empty_note = stat("empty-note", "b.md");
    empty_note.file_size = None;
    files.upsert_stat(empty_note).unwrap();
    let mut pending = stat("pending", "attachments/p.pdf");
    pending.file_type = "pdf".to_owned();
    pending.file_size = None;
    files.upsert_stat(pending).unwrap();
    let mut zero = stat("zero", "attachments/z.png");
    zero.file_type = "image".to_owned();
    zero.file_size = Some(0);
    files.upsert_stat(zero).unwrap();
    let mut arrived = stat("arrived", "attachments/q.pdf");
    arrived.file_type = "pdf".to_owned();
    files.upsert_stat(arrived).unwrap();

    let ids: Vec<_> = paths(&files).into_iter().map(|(id, _)| id).collect();
    assert_eq!(ids, ["arrived", "empty-note", "note"]);
}

#[test]
fn the_migration_runs_again_over_a_file_that_already_has_the_table() {
    // A crash between the migration's commit and the `user_version` pragma leaves the
    // table in place at the old version; the next open runs 0015 again.
    let Fixture { dir, vault } = fixture();
    vault
        .note_files()
        .upsert_stat(stat("n1", "a.md"))
        .expect("insert");
    vault
        .db_handle()
        .call_blocking(|conn| {
            conn.execute_batch("PRAGMA user_version = 14")
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
        })
        .expect("rewind the counter");
    drop(vault);

    let files = open_at(dir.path()).note_files();
    assert_eq!(paths(&files), [("n1".into(), "a.md".into())]);
    files
        .upsert_stat(stat("n2", "b.md"))
        .expect("still writable");
    assert_eq!(files.list_paths().expect("paths").len(), 2);
}
