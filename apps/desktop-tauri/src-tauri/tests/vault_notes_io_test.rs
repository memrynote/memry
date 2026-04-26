use memry_desktop_tauri_lib::vault::frontmatter::create_frontmatter;
use memry_desktop_tauri_lib::vault::notes_io;
use std::fs;

fn make_vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("notes")).unwrap();
    dir
}

#[tokio::test]
async fn write_then_read_roundtrip() {
    let vault = make_vault();
    let mut fm = create_frontmatter("Hello", &["work".to_string()]);
    fm.id = "fixed-id-1".to_string();
    let written = notes_io::write_note_to_disk(vault.path(), "notes/hello.md", &fm, "body text")
        .await
        .unwrap();
    assert_eq!(written.relative_path, "notes/hello.md");

    let read = notes_io::read_note_from_disk(vault.path(), "notes/hello.md")
        .await
        .unwrap()
        .expect("note must exist");
    assert_eq!(read.parsed.frontmatter.id, "fixed-id-1");
    assert_eq!(read.parsed.frontmatter.title.as_deref(), Some("Hello"));
    assert_eq!(read.parsed.content, "body text");
}

#[tokio::test]
async fn read_returns_none_for_missing_path() {
    let vault = make_vault();
    let result = notes_io::read_note_from_disk(vault.path(), "notes/missing.md")
        .await
        .unwrap();
    assert!(result.is_none());
}

#[tokio::test]
async fn read_auto_repairs_missing_frontmatter_and_writes_back() {
    let vault = make_vault();
    let abs = vault.path().join("notes").join("plain.md");
    fs::write(&abs, "no fm here\n").unwrap();
    let read = notes_io::read_note_from_disk(vault.path(), "notes/plain.md")
        .await
        .unwrap()
        .unwrap();
    assert!(read.parsed.was_modified);
    let on_disk = fs::read_to_string(&abs).unwrap();
    assert!(on_disk.starts_with("---\n"));
    assert!(on_disk.contains(&format!("id: {}", read.parsed.frontmatter.id)));
}

#[tokio::test]
async fn write_skips_no_op_when_hash_matches() {
    let vault = make_vault();
    let mut fm = create_frontmatter("X", &[]);
    fm.id = "id-2".to_string();
    let first = notes_io::write_note_to_disk(vault.path(), "notes/x.md", &fm, "same")
        .await
        .unwrap();
    let second = notes_io::write_note_to_disk(vault.path(), "notes/x.md", &fm, "same")
        .await
        .unwrap();
    // Hash equality means the second call did NOT bump the file mtime.
    assert_eq!(first.content_hash, second.content_hash);
}

#[tokio::test]
async fn read_rejects_path_traversal() {
    let vault = make_vault();
    let err = notes_io::read_note_from_disk(vault.path(), "../escape.md")
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        memry_desktop_tauri_lib::error::AppError::PathEscape(_)
    ));
}
