//! Folder command coverage for M5 Phase F.
//!
//! Mirrors the inner-helper pattern from `commands_notes_test.rs` so we
//! exercise the DB+vault FS slice without needing a Tauri AppHandle.

use memry_desktop_tauri_lib::commands::folders::{
    notes_create_folder_inner, notes_delete_folder_inner, notes_get_all_positions_inner,
    notes_get_folder_config_inner, notes_get_folder_template_inner, notes_get_folders_inner,
    notes_get_positions_inner, notes_rename_folder_inner, notes_reorder_inner,
    notes_set_folder_config_inner, SetFolderConfigInput,
};
use memry_desktop_tauri_lib::commands::notes::{notes_create_inner, NoteCreateInput};
use memry_desktop_tauri_lib::db::folder_configs;
use memry_desktop_tauri_lib::db::note_metadata;
use memry_desktop_tauri_lib::error::AppError;
use memry_desktop_tauri_lib::test_helpers::{open_in_memory_with_migrations, test_vault_runtime};

#[tokio::test]
async fn create_folder_then_get_folders_returns_path() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();

    notes_create_folder_inner(&vault, "Inbox").await.unwrap();

    let folders = notes_get_folders_inner(&conn, &vault).await.unwrap();
    let names: Vec<String> = folders.into_iter().map(|f| f.path).collect();
    assert!(names.contains(&"Inbox".to_string()));
}

#[tokio::test]
async fn get_folders_attaches_icon_from_folder_config() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    notes_create_folder_inner(&vault, "Projects").await.unwrap();
    folder_configs::set(
        &conn,
        &folder_configs::FolderConfigRow {
            path: "Projects".into(),
            icon: Some("folder-kanban".into()),
            template_json: None,
        },
    )
    .unwrap();

    let folders = notes_get_folders_inner(&conn, &vault).await.unwrap();
    let projects = folders.into_iter().find(|f| f.path == "Projects").unwrap();
    assert_eq!(projects.icon.as_deref(), Some("folder-kanban"));
}

#[tokio::test]
async fn rename_folder_moves_child_note_metadata() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    notes_create_folder_inner(&vault, "Inbox").await.unwrap();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Doc".into(),
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
    assert_eq!(created.path, "Inbox/doc.md");

    notes_rename_folder_inner(&conn, &vault, "Inbox", "Archive")
        .await
        .unwrap();

    let row = note_metadata::get_by_id(&conn, &created.id)
        .unwrap()
        .expect("metadata still exists");
    assert_eq!(row.path, "Archive/doc.md");
}

#[tokio::test]
async fn delete_folder_refuses_nonempty_without_recursive() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    notes_create_folder_inner(&vault, "Inbox").await.unwrap();
    notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Doc".into(),
            content: Some("body".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap();

    let err = notes_delete_folder_inner(&conn, &vault, "Inbox", false)
        .await
        .expect_err("non-empty folder should error");
    assert!(
        matches!(err, AppError::Conflict(_)),
        "expected Conflict, got {err:?}"
    );
}

#[tokio::test]
async fn delete_folder_recursive_soft_deletes_children() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    notes_create_folder_inner(&vault, "Inbox").await.unwrap();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Doc".into(),
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

    notes_delete_folder_inner(&conn, &vault, "Inbox", true)
        .await
        .unwrap();

    let active = note_metadata::get_active_by_id(&conn, &created.id).unwrap();
    assert!(
        active.is_none(),
        "soft-deleted note must drop out of active queries"
    );
}

#[tokio::test]
async fn delete_folder_empty_passes_without_recursive() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    notes_create_folder_inner(&vault, "Empty").await.unwrap();

    notes_delete_folder_inner(&conn, &vault, "Empty", false)
        .await
        .unwrap();

    let folders = notes_get_folders_inner(&conn, &vault).await.unwrap();
    assert!(!folders.iter().any(|f| f.path == "Empty"));
}

// ---- Task 34: folder config + template inheritance -------------------------

#[test]
fn set_folder_config_round_trip_returns_icon_and_template() {
    let conn = open_in_memory_with_migrations();

    notes_set_folder_config_inner(
        &conn,
        SetFolderConfigInput {
            path: "Projects".into(),
            icon: Some("folder-kanban".into()),
            template_json: Some(r#"{"frontmatter":{"status":"active"}}"#.into()),
        },
    )
    .unwrap();

    let cfg = notes_get_folder_config_inner(&conn, "Projects")
        .unwrap()
        .expect("config persisted");
    assert_eq!(cfg.icon.as_deref(), Some("folder-kanban"));
    assert!(cfg
        .template_json
        .as_deref()
        .unwrap()
        .contains("\"status\":\"active\""));
}

#[test]
fn get_folder_template_walks_ancestors_for_inheritance() {
    let conn = open_in_memory_with_migrations();

    notes_set_folder_config_inner(
        &conn,
        SetFolderConfigInput {
            path: "Projects".into(),
            icon: None,
            template_json: Some(r#"{"frontmatter":{"status":"active"}}"#.into()),
        },
    )
    .unwrap();

    let resolved = notes_get_folder_template_inner(&conn, "Projects/sub/deep")
        .unwrap()
        .expect("template inherits from Projects/");
    assert!(resolved.contains("\"status\":\"active\""));

    let none = notes_get_folder_template_inner(&conn, "Other").unwrap();
    assert!(none.is_none(), "no ancestor → no template");
}

// ---- Task 35: positions + reorder ------------------------------------------

#[test]
fn reorder_then_get_positions_returns_indexed_paths() {
    let conn = open_in_memory_with_migrations();

    notes_reorder_inner(
        &conn,
        "Inbox",
        &["a.md".into(), "b.md".into(), "c.md".into()],
    )
    .unwrap();

    let positions = notes_get_positions_inner(&conn, "Inbox").unwrap();
    assert_eq!(positions.get("a.md").copied(), Some(0));
    assert_eq!(positions.get("b.md").copied(), Some(1));
    assert_eq!(positions.get("c.md").copied(), Some(2));
}

#[test]
fn get_all_positions_returns_flat_map_across_folders() {
    let conn = open_in_memory_with_migrations();
    notes_reorder_inner(&conn, "Inbox", &["a.md".into(), "b.md".into()]).unwrap();
    notes_reorder_inner(&conn, "Projects", &["c.md".into()]).unwrap();

    let all = notes_get_all_positions_inner(&conn).unwrap();
    assert_eq!(all.get("a.md").copied(), Some(0));
    assert_eq!(all.get("b.md").copied(), Some(1));
    assert_eq!(all.get("c.md").copied(), Some(0));
    assert_eq!(all.len(), 3);
}
