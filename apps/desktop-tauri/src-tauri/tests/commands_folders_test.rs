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
use memry_desktop_tauri_lib::db::{folder_configs, note_metadata, note_positions, notes_cache};
use memry_desktop_tauri_lib::error::AppError;
use memry_desktop_tauri_lib::test_helpers::{open_in_memory_with_migrations, test_vault_runtime};
use memry_desktop_tauri_lib::vault::notes_io;
use memry_desktop_tauri_lib::vault::preferences::{read_config, update_config};

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
async fn create_folder_treats_notes_prefixed_path_as_logical_child() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let root = vault.require_current().unwrap();

    notes_create_folder_inner(&vault, "notes/Child")
        .await
        .unwrap();

    assert!(root.join("notes/notes/Child").is_dir());
    assert!(!root.join("notes/Child").is_dir());
    let folders = notes_get_folders_inner(&conn, &vault).await.unwrap();
    let names: Vec<String> = folders.into_iter().map(|f| f.path).collect();
    assert!(names.contains(&"notes/Child".to_string()));
}

#[tokio::test]
async fn folder_disk_commands_reject_parent_path_components() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    notes_create_folder_inner(&vault, "Inbox").await.unwrap();

    let create_err = notes_create_folder_inner(&vault, "../attachments")
        .await
        .expect_err("create should reject parent traversal");
    assert!(matches!(create_err, AppError::Validation(ref message) if message.contains("..")));

    let rename_err = notes_rename_folder_inner(&conn, &vault, "Inbox", "Inbox/../../journal")
        .await
        .expect_err("rename should reject parent traversal");
    assert!(matches!(rename_err, AppError::Validation(ref message) if message.contains("..")));

    let delete_err = notes_delete_folder_inner(&conn, &vault, "Inbox/../Archive", true)
        .await
        .expect_err("delete should reject parent traversal");
    assert!(matches!(delete_err, AppError::Validation(ref message) if message.contains("..")));
}

#[tokio::test]
async fn rename_folder_rejects_descendant_target_without_creating_child() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let root = vault.require_current().unwrap();
    notes_create_folder_inner(&vault, "Inbox").await.unwrap();

    let err = notes_rename_folder_inner(&conn, &vault, "Inbox", "Inbox/Sub")
        .await
        .expect_err("descendant rename should be rejected");

    assert!(matches!(err, AppError::Validation(ref message) if message.contains("descendant")));
    assert!(root.join("notes/Inbox").is_dir());
    assert!(!root.join("notes/Inbox/Sub").exists());
}

#[tokio::test]
async fn folder_commands_use_configured_default_note_folder() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let root = vault.require_current().unwrap();
    let mut config = read_config(&root).unwrap();
    config.default_note_folder = "Custom".into();
    update_config(&root, &config).unwrap();

    notes_create_folder_inner(&vault, "Inbox").await.unwrap();
    assert!(root.join("Custom").join("Inbox").is_dir());

    let folders = notes_get_folders_inner(&conn, &vault).await.unwrap();
    assert!(folders.iter().any(|folder| folder.path == "Inbox"));

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
    assert_eq!(created.path, "Custom/Inbox/doc.md");

    notes_rename_folder_inner(&conn, &vault, "Inbox", "Archive")
        .await
        .unwrap();
    let renamed = note_metadata::get_by_id(&conn, &created.id)
        .unwrap()
        .expect("metadata still exists");
    assert_eq!(renamed.path, "Custom/Archive/doc.md");

    notes_delete_folder_inner(&conn, &vault, "Archive", true)
        .await
        .unwrap();
    assert!(note_metadata::get_active_by_id(&conn, &created.id)
        .unwrap()
        .is_none());
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
    assert_eq!(created.path, "notes/Inbox/doc.md");

    notes_rename_folder_inner(&conn, &vault, "Inbox", "Archive")
        .await
        .unwrap();

    let row = note_metadata::get_by_id(&conn, &created.id)
        .unwrap()
        .expect("metadata still exists");
    assert_eq!(row.path, "notes/Archive/doc.md");
}

#[tokio::test]
async fn rename_folder_treats_notes_prefixed_paths_as_logical_children() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    notes_create_folder_inner(&vault, "notes/Child")
        .await
        .unwrap();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Doc".into(),
            content: Some("body".into()),
            folder: Some("notes/Child".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();
    assert_eq!(created.path, "notes/notes/Child/doc.md");

    notes_rename_folder_inner(&conn, &vault, "notes/Child", "notes/Archive")
        .await
        .unwrap();

    let row = note_metadata::get_by_id(&conn, &created.id)
        .unwrap()
        .expect("metadata still exists");
    assert_eq!(row.path, "notes/notes/Archive/doc.md");
}

#[tokio::test]
async fn rename_folder_normalizes_backslashes_before_db_rewrite() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let root = vault.require_current().unwrap();
    notes_create_folder_inner(&vault, "Inbox/Sub")
        .await
        .unwrap();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Doc".into(),
            content: Some("body".into()),
            folder: Some("Inbox/Sub".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    notes_rename_folder_inner(&conn, &vault, "Inbox\\Sub", "Archive\\Sub")
        .await
        .unwrap();

    assert!(root.join("notes/Archive/Sub").is_dir());
    let row = note_metadata::get_by_id(&conn, &created.id)
        .unwrap()
        .expect("metadata still exists");
    assert_eq!(row.path, "notes/Archive/Sub/doc.md");
}

#[tokio::test]
async fn rename_folder_rewrites_unicode_child_paths_across_db_tables() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    notes_create_folder_inner(&vault, "Café/Sub").await.unwrap();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Doc".into(),
            content: Some("body".into()),
            folder: Some("Café/Sub".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();
    notes_reorder_inner(&conn, "", &["Café".into()]).unwrap();
    notes_reorder_inner(&conn, "Café", &["Café/Sub".into()]).unwrap();
    notes_reorder_inner(&conn, "Café/Sub", std::slice::from_ref(&created.path)).unwrap();
    notes_set_folder_config_inner(
        &conn,
        SetFolderConfigInput {
            path: "Café/Sub".into(),
            icon: Some("folder-kanban".into()),
            template_json: None,
        },
    )
    .unwrap();

    notes_rename_folder_inner(&conn, &vault, "Café", "Archive")
        .await
        .unwrap();

    let row = note_metadata::get_by_id(&conn, &created.id)
        .unwrap()
        .expect("metadata still exists");
    assert_eq!(row.path, "notes/Archive/Sub/doc.md");
    let cache = notes_cache::list_active(&conn, 10, 0, "title").unwrap();
    assert_eq!(cache[0].path, "notes/Archive/Sub/doc.md");
    let positions = note_positions::get_for_folder(&conn, "Archive/Sub").unwrap();
    assert_eq!(positions.get("notes/Archive/Sub/doc.md").copied(), Some(0));
    let all_positions = note_positions::get_all(&conn).unwrap();
    assert_eq!(all_positions.get("Archive").copied(), Some(0));
    assert_eq!(all_positions.get("Archive/Sub").copied(), Some(0));
    assert!(!all_positions.contains_key("Café"));
    assert!(!all_positions.contains_key("Café/Sub"));
    let config = notes_get_folder_config_inner(&conn, "Archive/Sub")
        .unwrap()
        .expect("folder config moved");
    assert_eq!(config.icon.as_deref(), Some("folder-kanban"));
}

#[tokio::test]
async fn recursive_delete_folder_normalizes_backslashes_before_db_rewrite() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    notes_create_folder_inner(&vault, "Inbox/Sub")
        .await
        .unwrap();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Doc".into(),
            content: Some("body".into()),
            folder: Some("Inbox/Sub".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    notes_delete_folder_inner(&conn, &vault, "Inbox\\Sub", true)
        .await
        .unwrap();

    let row = note_metadata::get_by_id(&conn, &created.id)
        .unwrap()
        .expect("metadata still exists");
    assert!(row.path.starts_with(".trash/"));
    assert!(notes_cache::list_active(&conn, 10, 0, "title")
        .unwrap()
        .into_iter()
        .all(|cached| cached.id != created.id));
}

#[tokio::test]
async fn rename_folder_treats_like_wildcards_as_literal_path_chars() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    notes_create_folder_inner(&vault, "A_B").await.unwrap();
    notes_create_folder_inner(&vault, "AxB").await.unwrap();
    let literal = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Literal".into(),
            content: Some("body".into()),
            folder: Some("A_B".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();
    let sibling = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Sibling".into(),
            content: Some("body".into()),
            folder: Some("AxB".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    notes_rename_folder_inner(&conn, &vault, "A_B", "Renamed")
        .await
        .unwrap();

    let literal_row = note_metadata::get_by_id(&conn, &literal.id)
        .unwrap()
        .expect("literal row");
    let sibling_row = note_metadata::get_by_id(&conn, &sibling.id)
        .unwrap()
        .expect("sibling row");
    assert_eq!(literal_row.path, "notes/Renamed/literal.md");
    assert_eq!(sibling_row.path, "notes/AxB/sibling.md");
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
async fn delete_folder_rejects_root_path_even_when_recursive() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();

    let err = notes_delete_folder_inner(&conn, &vault, "", true)
        .await
        .expect_err("root folder delete should error");
    assert!(
        matches!(err, AppError::Validation(ref message) if message.contains("root")),
        "expected root validation error, got {err:?}"
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

    let deleted_notes = notes_delete_folder_inner(&conn, &vault, "Inbox", true)
        .await
        .unwrap();
    assert_eq!(deleted_notes.len(), 1);
    assert_eq!(deleted_notes[0].id, created.id);
    assert_eq!(deleted_notes[0].path, created.path);

    let active = note_metadata::get_active_by_id(&conn, &created.id).unwrap();
    assert!(
        active.is_none(),
        "soft-deleted note must drop out of active queries"
    );
    let tombstone = note_metadata::get_by_id(&conn, &created.id)
        .unwrap()
        .expect("metadata row remains");
    assert!(tombstone.path.starts_with(".trash/"));
    let trashed = notes_io::read_note_from_disk(&vault.require_current().unwrap(), &tombstone.path)
        .await
        .unwrap();
    assert!(
        trashed.is_some(),
        "recursive folder delete must preserve the note file in trash"
    );

    notes_create_folder_inner(&vault, "Inbox").await.unwrap();
    let recreated = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Doc".into(),
            content: Some("new body".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();
    assert_eq!(recreated.path, "notes/Inbox/doc.md");
}

#[tokio::test]
async fn delete_folder_recursive_treats_like_wildcards_as_literal_path_chars() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    notes_create_folder_inner(&vault, "A_B").await.unwrap();
    notes_create_folder_inner(&vault, "AxB").await.unwrap();
    let literal = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Literal".into(),
            content: Some("body".into()),
            folder: Some("A_B".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();
    let sibling = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Sibling".into(),
            content: Some("body".into()),
            folder: Some("AxB".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    notes_delete_folder_inner(&conn, &vault, "A_B", true)
        .await
        .unwrap();

    assert!(note_metadata::get_active_by_id(&conn, &literal.id)
        .unwrap()
        .is_none());
    assert!(note_metadata::get_active_by_id(&conn, &sibling.id)
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn delete_folder_recursive_preserves_root_when_child_folder_is_named_notes() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let root_note = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Root".into(),
            content: Some("root body".into()),
            folder: None,
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();
    notes_create_folder_inner(&vault, "notes").await.unwrap();
    let child_note = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Child".into(),
            content: Some("child body".into()),
            folder: Some("notes".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    notes_delete_folder_inner(&conn, &vault, "notes", true)
        .await
        .unwrap();

    assert_eq!(root_note.path, "notes/root.md");
    assert_eq!(child_note.path, "notes/notes/child.md");
    assert!(note_metadata::get_active_by_id(&conn, &root_note.id)
        .unwrap()
        .is_some());
    assert!(note_metadata::get_active_by_id(&conn, &child_note.id)
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn delete_folder_empty_passes_without_recursive() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    notes_create_folder_inner(&vault, "Empty").await.unwrap();
    notes_reorder_inner(&conn, "", &["Empty".into()]).unwrap();

    notes_delete_folder_inner(&conn, &vault, "Empty", false)
        .await
        .unwrap();

    let folders = notes_get_folders_inner(&conn, &vault).await.unwrap();
    assert!(!folders.iter().any(|f| f.path == "Empty"));
    let positions = notes_get_all_positions_inner(&conn).unwrap();
    assert!(!positions.contains_key("Empty"));
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
