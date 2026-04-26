use memry_desktop_tauri_lib::commands::notes::{
    notes_create_inner, notes_update_inner, NoteCreateInput, NoteUpdateInput,
};
use memry_desktop_tauri_lib::db::{note_metadata, notes_cache};
use memry_desktop_tauri_lib::test_helpers::{
    open_in_memory_with_migrations, test_vault_runtime,
};
use memry_desktop_tauri_lib::vault::notes_io;
use std::time::Duration;

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

#[tokio::test]
async fn update_note_changes_metadata_vault_file_cache_and_returns_dto() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Draft".into(),
            content: Some("old body".into()),
            folder: Some("Inbox".into()),
            tags: Some(vec!["old".into()]),
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    tokio::time::sleep(Duration::from_millis(5)).await;

    let updated = notes_update_inner(
        &conn,
        &vault,
        NoteUpdateInput {
            id: created.id.clone(),
            title: Some("Published".into()),
            content: Some("new body with more words".into()),
            tags: Some(vec!["new".into(), "shared".into()]),
            frontmatter: None,
            emoji: Some(Some("spark".into())),
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    assert_eq!(updated.id, created.id);
    assert_eq!(updated.title, "Published");
    assert_eq!(updated.content, "new body with more words");
    assert_eq!(updated.tags, vec!["new", "shared"]);
    assert_eq!(updated.emoji.as_deref(), Some("spark"));
    assert!(updated.modified > created.modified);

    let metadata = note_metadata::get_by_id(&conn, &created.id)
        .unwrap()
        .expect("metadata row");
    assert_eq!(metadata.title, "Published");
    assert_eq!(metadata.emoji.as_deref(), Some("spark"));
    assert_eq!(metadata.file_size, Some("new body with more words".len() as i64));

    let root = vault.require_current().unwrap();
    let on_disk = notes_io::read_note_from_disk(&root, &updated.path)
        .await
        .unwrap()
        .expect("vault note");
    assert_eq!(on_disk.parsed.content, "new body with more words");
    assert_eq!(on_disk.parsed.frontmatter.title.as_deref(), Some("Published"));
    assert_eq!(on_disk.parsed.frontmatter.tags, vec!["new", "shared"]);

    let cached = notes_cache::list_active(&conn, 10, 0, "modified").unwrap();
    assert_eq!(cached[0].id, created.id);
    assert_eq!(cached[0].title, "Published");
    assert_eq!(cached[0].snippet, "new body with more words");
    assert_eq!(cached[0].word_count, 5);
    assert_eq!(cached[0].tags_json, "[\"new\",\"shared\"]");
}
