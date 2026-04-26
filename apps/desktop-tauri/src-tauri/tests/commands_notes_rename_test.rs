use memry_desktop_tauri_lib::commands::notes::{
    notes_create_inner, notes_delete_inner, notes_exists_inner, notes_move_inner,
    notes_rename_inner, NoteCreateInput,
};
use memry_desktop_tauri_lib::db::{note_metadata, notes_cache};
use memry_desktop_tauri_lib::error::AppError;
use memry_desktop_tauri_lib::test_helpers::{open_in_memory_with_migrations, test_vault_runtime};
use memry_desktop_tauri_lib::vault::notes_io;

#[tokio::test]
async fn rename_changes_title_and_path_in_db_vault_and_cache() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Old".into(),
            content: Some("body".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let response = notes_rename_inner(&conn, &vault, &created.id, "New Title")
        .await
        .unwrap();
    assert!(response.success);
    let renamed = response.note.unwrap();

    assert_eq!(renamed.id, created.id);
    assert_eq!(renamed.title, "New Title");
    assert_eq!(renamed.path, "Inbox/new-title.md");
    assert_eq!(renamed.content, "body");

    let row = note_metadata::get_by_id(&conn, &created.id)
        .unwrap()
        .unwrap();
    assert_eq!(row.path, "Inbox/new-title.md");
    assert_eq!(row.title, "New Title");

    let root = vault.require_current().unwrap();
    assert!(notes_io::read_note_from_disk(&root, &created.path)
        .await
        .unwrap()
        .is_none());
    let on_disk = notes_io::read_note_from_disk(&root, "Inbox/new-title.md")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        on_disk.parsed.frontmatter.title.as_deref(),
        Some("New Title")
    );

    let cached = notes_cache::list_active(&conn, 10, 0, "modified").unwrap();
    assert_eq!(cached.len(), 1);
    assert_eq!(cached[0].id, created.id);
    assert_eq!(cached[0].title, "New Title");
    assert_eq!(cached[0].path, "Inbox/new-title.md");
}

#[tokio::test]
async fn rename_preserves_path_when_slug_does_not_change() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Foo".into(),
            content: Some("body".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let renamed = notes_rename_inner(&conn, &vault, &created.id, "Foo.")
        .await
        .unwrap()
        .note
        .unwrap();

    assert_eq!(renamed.path, created.path);
    assert_eq!(renamed.title, "Foo.");
    let on_disk = notes_io::read_note_from_disk(&vault.require_current().unwrap(), &created.path)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(on_disk.parsed.frontmatter.title.as_deref(), Some("Foo."));
}

#[tokio::test]
async fn rename_to_colliding_path_returns_conflict_and_keeps_originals() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let first = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "First".into(),
            content: Some("a".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();
    let second = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Second".into(),
            content: Some("b".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let err = notes_rename_inner(&conn, &vault, &second.id, "First")
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Conflict(message) if message.contains(&first.path)));

    let root = vault.require_current().unwrap();
    let still_first = notes_io::read_note_from_disk(&root, &first.path)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(still_first.parsed.content, "a");
    let still_second = notes_io::read_note_from_disk(&root, &second.path)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(still_second.parsed.content, "b");
}

#[tokio::test]
async fn move_changes_folder_in_db_vault_and_cache() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Note".into(),
            content: Some("body".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let moved = notes_move_inner(&conn, &vault, &created.id, "Archive")
        .await
        .unwrap()
        .note
        .unwrap();

    assert_eq!(moved.path, "Archive/note.md");
    assert_eq!(moved.title, "Note");

    let row = note_metadata::get_by_id(&conn, &created.id)
        .unwrap()
        .unwrap();
    assert_eq!(row.path, "Archive/note.md");

    let root = vault.require_current().unwrap();
    assert!(notes_io::read_note_from_disk(&root, "Inbox/note.md")
        .await
        .unwrap()
        .is_none());
    assert!(notes_io::read_note_from_disk(&root, "Archive/note.md")
        .await
        .unwrap()
        .is_some());

    let cached = notes_cache::list_active(&conn, 10, 0, "modified").unwrap();
    assert_eq!(cached.len(), 1);
    assert_eq!(cached[0].path, "Archive/note.md");
}

#[tokio::test]
async fn move_to_root_when_folder_empty() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Loose".into(),
            content: None,
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let moved = notes_move_inner(&conn, &vault, &created.id, "")
        .await
        .unwrap()
        .note
        .unwrap();

    assert_eq!(moved.path, "loose.md");
    assert!(notes_io::read_note_from_disk(&vault.require_current().unwrap(), "loose.md")
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn move_to_colliding_target_folder_returns_conflict() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let _inbox = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Doc".into(),
            content: Some("a".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();
    let archive = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Doc".into(),
            content: Some("b".into()),
            folder: Some("Archive".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let err = notes_move_inner(&conn, &vault, &archive.id, "Inbox")
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Conflict(_)));
}

#[tokio::test]
async fn exists_matches_by_path_and_case_insensitive_title() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Greeting".into(),
            content: None,
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    assert!(notes_exists_inner(&conn, &created.path).unwrap());
    assert!(notes_exists_inner(&conn, "GREETING").unwrap());
    assert!(!notes_exists_inner(&conn, "missing").unwrap());
}

#[tokio::test]
async fn exists_returns_false_after_soft_delete() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Trash".into(),
            content: None,
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    notes_delete_inner(&conn, &vault, &created.id).await.unwrap();

    assert!(!notes_exists_inner(&conn, &created.path).unwrap());
    assert!(!notes_exists_inner(&conn, "Trash").unwrap());
}
