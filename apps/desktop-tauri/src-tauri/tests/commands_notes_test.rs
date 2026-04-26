//! Aggregate happy-path coverage for the M5 notes command surface.
//!
//! Each test composes inner helpers end-to-end so the entire CRUD slice
//! stays exercised even as edge cases move into per-feature test files
//! (`commands_notes_create_test`, `commands_notes_get_test`,
//! `commands_notes_rename_test`, `commands_notes_local_only_test`,
//! `commands_notes_tags_links_test`).
//!
//! These are kept synchronous + DB-only — no Tauri AppHandle dependencies.
//! The real `#[tauri::command]` async fns are covered by the runtime
//! e2e lane in Chunk 12.

use memry_desktop_tauri_lib::commands::notes::{
    notes_create_inner, notes_delete_inner, notes_exists_inner,
    notes_get_local_only_count_inner, notes_list_by_folder_inner, notes_list_inner,
    notes_move_inner, notes_rename_inner, notes_set_local_only_inner, NoteCreateInput,
    NoteListOptions,
};
use memry_desktop_tauri_lib::db::note_metadata;
use memry_desktop_tauri_lib::test_helpers::{open_in_memory_with_migrations, test_vault_runtime};
use memry_desktop_tauri_lib::vault::notes_io;

#[tokio::test]
async fn create_then_list_returns_single_active_note() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "First".into(),
            content: Some("alpha".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap();

    let active = note_metadata::list_active(&conn).unwrap();
    assert_eq!(active.len(), 1);

    let listing = notes_list_inner(&conn, None).unwrap();
    assert_eq!(listing.total, 1);
    assert_eq!(listing.notes.len(), 1);
    assert_eq!(listing.notes[0].title, "First");
}

#[tokio::test]
async fn rename_round_trip_keeps_id_updates_path_and_title() {
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

    let renamed = notes_rename_inner(&conn, &vault, &created.id, "Renamed Doc")
        .await
        .unwrap()
        .note
        .unwrap();
    assert_eq!(renamed.id, created.id);
    assert_eq!(renamed.title, "Renamed Doc");
    assert_eq!(renamed.path, "Inbox/renamed-doc.md");

    assert!(notes_io::read_note_from_disk(&vault.require_current().unwrap(), &created.path)
        .await
        .unwrap()
        .is_none());
    assert!(notes_io::read_note_from_disk(&vault.require_current().unwrap(), &renamed.path)
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn move_round_trip_changes_only_folder_segment() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Drop".into(),
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
    assert_eq!(moved.id, created.id);
    assert_eq!(moved.title, "Drop");
    assert_eq!(moved.path, "Archive/drop.md");

    let listing = notes_list_by_folder_inner(&conn, "Archive").unwrap();
    assert_eq!(listing.total, 1);
    assert_eq!(listing.notes[0].path, "Archive/drop.md");

    let inbox = notes_list_by_folder_inner(&conn, "Inbox").unwrap();
    assert_eq!(inbox.total, 0);
}

#[tokio::test]
async fn soft_delete_removes_note_from_list_but_keeps_metadata_row() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Discard".into(),
            content: Some("bye".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    notes_delete_inner(&conn, &vault, &created.id)
        .await
        .unwrap();

    let listing = notes_list_inner(&conn, None).unwrap();
    assert_eq!(listing.total, 0);
    assert!(listing.notes.is_empty());

    let raw = note_metadata::get_by_id(&conn, &created.id)
        .unwrap()
        .expect("metadata row preserved for tombstone");
    assert_eq!(raw.id, created.id);
}

#[tokio::test]
async fn set_local_only_flips_visibility_for_count_query() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Private".into(),
            content: Some("local".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    assert_eq!(notes_get_local_only_count_inner(&conn).unwrap().count, 0);
    notes_set_local_only_inner(&vault, &conn, &created.id, true)
        .await
        .unwrap();
    assert_eq!(notes_get_local_only_count_inner(&conn).unwrap().count, 1);
    notes_set_local_only_inner(&vault, &conn, &created.id, false)
        .await
        .unwrap();
    assert_eq!(notes_get_local_only_count_inner(&conn).unwrap().count, 0);
}

#[tokio::test]
async fn exists_resolves_by_path_and_title() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Lookup".into(),
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
    assert!(notes_exists_inner(&conn, "lookup").unwrap());
    assert!(!notes_exists_inner(&conn, "missing").unwrap());
}

#[tokio::test]
async fn list_with_pagination_and_folder_filter() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    for index in 0..3 {
        notes_create_inner(
            &conn,
            &vault,
            NoteCreateInput {
                title: format!("Doc {index}"),
                content: Some(format!("body {index}")),
                folder: Some("Projects".into()),
                tags: None,
                template: None,
            },
        )
        .await
        .unwrap();
    }

    let page = notes_list_inner(
        &conn,
        Some(NoteListOptions {
            folder: Some("Projects".into()),
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
    assert_eq!(page.notes.len(), 2);
}
