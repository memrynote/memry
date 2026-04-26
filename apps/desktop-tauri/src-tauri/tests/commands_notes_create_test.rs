use memry_desktop_tauri_lib::commands::notes::{notes_create_inner, NoteCreateInput};
use memry_desktop_tauri_lib::db::{note_metadata, notes_cache};
use memry_desktop_tauri_lib::test_helpers::{
    open_in_memory_with_migrations, test_vault_runtime,
};
use memry_desktop_tauri_lib::vault::notes_io;

#[tokio::test]
async fn create_note_writes_metadata_vault_file_cache_and_returns_dto() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();

    let result = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Hello".into(),
            content: Some("# Body".into()),
            folder: Some("Inbox".into()),
            tags: Some(vec!["work".into()]),
            template: None,
        },
    )
    .await
    .unwrap();

    assert!(result.success);
    let note = result.note.unwrap();
    assert_eq!(note.title, "Hello");
    assert_eq!(note.content, "# Body");
    assert_eq!(note.tags, vec!["work"]);
    assert!(note.path.starts_with("Inbox/"));
    assert!(note.path.ends_with(".md"));

    let metadata = note_metadata::get_by_id(&conn, &note.id)
        .unwrap()
        .expect("metadata row");
    assert_eq!(metadata.path, note.path);
    assert_eq!(metadata.title, "Hello");

    let root = vault.require_current().unwrap();
    let on_disk = notes_io::read_note_from_disk(&root, &note.path)
        .await
        .unwrap()
        .expect("vault note");
    assert_eq!(on_disk.parsed.content, "# Body");
    assert_eq!(on_disk.parsed.frontmatter.id, note.id);
    assert_eq!(on_disk.parsed.frontmatter.title.as_deref(), Some("Hello"));

    let cached = notes_cache::list_active(&conn, 10, 0, "modified").unwrap();
    assert_eq!(cached.len(), 1);
    assert_eq!(cached[0].id, note.id);
    assert_eq!(cached[0].snippet, "# Body");
}
