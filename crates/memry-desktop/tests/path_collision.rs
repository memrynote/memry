//! Case and normalization collisions of vault paths, against the real `note_files` table.
//! The table compares bytes and the core folds nothing, so without the vault tier's check two
//! spellings of one file become two rows.

use memry_core::api::note_files::NoteFiles;
use memry_core::api::vault::Vault;
use memry_core::domain::note_files::NoteFileStat;
use memry_desktop::vault::path_key::{PathIndex, folded_key};

fn vault() -> (tempfile::TempDir, NoteFiles) {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open("v".to_owned(), dir.path().display().to_string()).unwrap();
    (dir, vault.note_files())
}

fn stat(id: &str, path: &str) -> NoteFileStat {
    NoteFileStat {
        note_id: id.to_owned(),
        path: path.to_owned(),
        file_type: "markdown".to_owned(),
        mime_type: None,
        file_size: Some(1),
        content_hash: None,
        indexed_at: 1,
    }
}

/// The write path of the tier: check, then the table, then the index.
fn upsert(files: &NoteFiles, index: &mut PathIndex, id: &str, path: &str) -> Result<(), String> {
    index.check(id, path).map_err(|e| e.to_string())?;
    files
        .upsert_stat(stat(id, path))
        .map_err(|e| e.to_string())?;
    index.insert(id, path);
    Ok(())
}

#[test]
fn the_table_alone_accepts_two_spellings_of_one_file() {
    let (_dir, files) = vault();
    files.upsert_stat(stat("n1", "Note.md")).unwrap();
    files.upsert_stat(stat("n2", "note.md")).unwrap();
    assert_eq!(
        files.list_paths().unwrap().len(),
        2,
        "why the tier must check"
    );
}

#[test]
fn a_case_variant_or_an_nfd_spelling_of_another_notes_path_is_refused() {
    let (_dir, files) = vault();
    let mut index = PathIndex::load(&files).unwrap();
    upsert(&files, &mut index, "n1", "Notes/Caf\u{e9}.md").unwrap();

    for variant in [
        "notes/caf\u{e9}.md",
        "NOTES/CAF\u{c9}.MD",
        "Notes/Cafe\u{301}.md",
        "Notes/cafe\u{301}.md",
    ] {
        let err = upsert(&files, &mut index, "n2", variant).expect_err(variant);
        assert!(err.contains("Notes/Caf\u{e9}.md"), "{err}");
    }
    assert_eq!(files.list_paths().unwrap().len(), 1, "nothing was written");
    upsert(&files, &mut index, "n2", "Notes/Other.md").unwrap();
}

#[test]
fn a_note_may_change_the_case_of_its_own_path_and_free_the_old_one() {
    let (_dir, files) = vault();
    let mut index = PathIndex::load(&files).unwrap();
    upsert(&files, &mut index, "n1", "note.md").unwrap();
    upsert(&files, &mut index, "n1", "Note.md").unwrap();
    assert_eq!(index.len(), 1);
    assert_eq!(files.by_id("n1").unwrap().unwrap().path, "Note.md");
    // After a removal the spelling is free for another note.
    index.remove_note("n1");
    files.remove("n1").unwrap();
    upsert(&files, &mut index, "n2", "NOTE.md").unwrap();
}

#[test]
fn the_index_loaded_from_the_table_knows_rows_written_by_an_earlier_session() {
    let (_dir, files) = vault();
    files.upsert_stat(stat("n1", "A/b.md")).unwrap();
    let index = PathIndex::load(&files).unwrap();
    assert!(index.check("n2", "a/B.md").is_err());
    assert!(index.check("n1", "a/B.md").is_ok());
}

#[test]
fn the_key_is_nfc_then_lowercase() {
    assert_eq!(folded_key("Cafe\u{301}"), "caf\u{e9}");
    assert_eq!(folded_key("A/B"), "a/b");
}
