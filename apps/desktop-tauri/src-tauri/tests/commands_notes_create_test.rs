use memry_desktop_tauri_lib::commands::notes::{
    notes_create_inner, notes_delete_inner, notes_list_by_folder_inner, notes_list_inner,
    notes_update_inner, NoteCreateInput, NoteListOptions, NoteUpdateInput,
};
use memry_desktop_tauri_lib::db::{note_metadata, note_positions, notes_cache};
use memry_desktop_tauri_lib::error::AppError;
use memry_desktop_tauri_lib::test_helpers::{open_in_memory_with_migrations, test_vault_runtime};
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
async fn create_note_rejects_duplicate_path_without_overwriting_existing_file() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();

    let first = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Same Title".into(),
            content: Some("original body".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let err = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Same Title".into(),
            content: Some("new body".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, AppError::Conflict(message) if message.contains(&first.path)));

    let root = vault.require_current().unwrap();
    let on_disk = notes_io::read_note_from_disk(&root, &first.path)
        .await
        .unwrap()
        .expect("original note remains");
    assert_eq!(on_disk.parsed.content, "original body");

    let metadata = note_metadata::get_by_id(&conn, &first.id)
        .unwrap()
        .expect("original metadata remains");
    assert_eq!(metadata.title, "Same Title");
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
    assert_eq!(
        metadata.file_size,
        Some("new body with more words".len() as i64)
    );

    let root = vault.require_current().unwrap();
    let on_disk = notes_io::read_note_from_disk(&root, &updated.path)
        .await
        .unwrap()
        .expect("vault note");
    assert_eq!(on_disk.parsed.content, "new body with more words");
    assert_eq!(
        on_disk.parsed.frontmatter.title.as_deref(),
        Some("Published")
    );
    assert_eq!(on_disk.parsed.frontmatter.tags, vec!["new", "shared"]);

    let cached = notes_cache::list_active(&conn, 10, 0, "modified").unwrap();
    assert_eq!(cached[0].id, created.id);
    assert_eq!(cached[0].title, "Published");
    assert_eq!(cached[0].snippet, "new body with more words");
    assert_eq!(cached[0].word_count, 5);
    assert_eq!(cached[0].tags_json, "[\"new\",\"shared\"]");
}

#[tokio::test]
async fn update_note_merges_custom_frontmatter_and_returns_it() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Layout".into(),
            content: Some("body".into()),
            folder: Some("Inbox".into()),
            tags: Some(vec!["ui".into()]),
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let updated = notes_update_inner(
        &conn,
        &vault,
        NoteUpdateInput {
            id: created.id.clone(),
            title: None,
            content: None,
            tags: None,
            frontmatter: Some(
                serde_json::json!({
                    "fullWidth": true,
                    "rating": 4
                })
                .into(),
            ),
            emoji: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    assert_eq!(updated.frontmatter["id"], created.id);
    assert_eq!(updated.frontmatter["fullWidth"], true);
    assert_eq!(updated.frontmatter["rating"], 4);
    assert_eq!(updated.tags, vec!["ui"]);

    let root = vault.require_current().unwrap();
    let on_disk = notes_io::read_note_from_disk(&root, &updated.path)
        .await
        .unwrap()
        .expect("vault note");
    assert_eq!(
        on_disk.parsed.frontmatter.extra.get("fullWidth"),
        Some(&serde_yaml_ng::Value::Bool(true))
    );
}

#[tokio::test]
async fn delete_note_soft_deletes_metadata_removes_cache_and_trashes_vault_file() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Discard".into(),
            content: Some("remove me".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let result = notes_delete_inner(&conn, &vault, &created.id)
        .await
        .unwrap();

    assert!(result.success);
    let active = note_metadata::list_active(&conn).unwrap();
    assert!(active.iter().all(|row| row.id != created.id));
    assert_eq!(notes_cache::count_active(&conn).unwrap(), 0);

    let root = vault.require_current().unwrap();
    let original = notes_io::read_note_from_disk(&root, &created.path)
        .await
        .unwrap();
    assert!(original.is_none());
    assert!(root
        .join(".trash")
        .join(format!("{}.md", created.id))
        .exists());
}

#[tokio::test]
async fn list_notes_supports_pagination_modified_sort_and_folder_position_order() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let first = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "First".into(),
            content: Some("first body".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();
    tokio::time::sleep(Duration::from_millis(5)).await;
    let second = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Second".into(),
            content: Some("second body".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();
    tokio::time::sleep(Duration::from_millis(5)).await;
    let third = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Third".into(),
            content: Some("third body".into()),
            folder: Some("Projects".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let page = notes_list_inner(
        &conn,
        Some(NoteListOptions {
            folder: None,
            tags: None,
            sort_by: Some("modified".into()),
            sort_order: Some("desc".into()),
            limit: Some(2),
            offset: Some(0),
        }),
    )
    .unwrap();

    assert_eq!(page.total, 3);
    assert!(page.has_more);
    assert_eq!(
        page.notes
            .iter()
            .map(|note| note.id.as_str())
            .collect::<Vec<_>>(),
        [third.id.as_str(), second.id.as_str(),]
    );

    note_positions::reorder(&conn, "Inbox", &[second.path.clone(), first.path.clone()]).unwrap();
    let inbox = notes_list_by_folder_inner(&conn, "Inbox").unwrap();

    assert_eq!(inbox.total, 2);
    assert!(!inbox.has_more);
    assert_eq!(
        inbox
            .notes
            .iter()
            .map(|note| note.path.as_str())
            .collect::<Vec<_>>(),
        [second.path.as_str(), first.path.as_str()]
    );
    assert!(inbox
        .notes
        .iter()
        .all(|note| note.path.starts_with("Inbox/")));
}
