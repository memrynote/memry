use memry_desktop_tauri_lib::commands::devtools::{
    devtools_open_test_vault_inner, devtools_reset_db_inner, devtools_seed_vault_inner,
};
use memry_desktop_tauri_lib::db::{crdt_updates, note_metadata};
use memry_desktop_tauri_lib::test_helpers::{open_in_memory_with_migrations, test_vault_runtime};

#[tokio::test]
async fn reset_db_clears_data_tables_but_keeps_migrations() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    devtools_seed_vault_inner(
        &conn,
        &vault,
        vault.require_current().unwrap().to_str().unwrap(),
    )
    .await
    .unwrap();
    crdt_updates::append(&conn, "note-1", &[1, 2, 3], 7).unwrap();

    assert!(!note_metadata::list_active(&conn).unwrap().is_empty());
    assert!(migration_count(&conn) > 0);

    devtools_reset_db_inner(&conn).unwrap();

    assert!(note_metadata::list_active(&conn).unwrap().is_empty());
    assert!(crdt_updates::list_for_note(&conn, "note-1")
        .unwrap()
        .is_empty());
    assert!(migration_count(&conn) > 0);
}

#[tokio::test]
async fn seed_vault_creates_folder_and_markdown_notes() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let root = tempfile::tempdir().unwrap();

    let result = devtools_seed_vault_inner(&conn, &vault, root.path().to_str().unwrap())
        .await
        .unwrap();

    assert_eq!(result["notes"].as_array().unwrap().len(), 2);
    assert!(root.path().join("notes/Inbox").is_dir());
    assert!(note_metadata::list_active(&conn).unwrap().len() >= 2);
}

#[tokio::test]
async fn open_test_vault_points_runtime_at_temp_root() {
    let vault = test_vault_runtime();
    let root = tempfile::tempdir().unwrap();

    let status = devtools_open_test_vault_inner(&vault, root.path().to_str().unwrap()).unwrap();
    let expected = dunce::canonicalize(root.path()).unwrap();

    assert_eq!(status["isOpen"], true);
    assert_eq!(status["path"].as_str().unwrap(), expected.to_str().unwrap());
    assert_eq!(
        vault.current_path().unwrap().to_string_lossy(),
        expected.to_string_lossy()
    );
}

#[test]
fn production_default_capability_does_not_grant_devtools() {
    let default_capability = include_str!("../capabilities/default.json");

    assert!(!default_capability.contains("devtools_"));
    assert!(!default_capability.contains("allow-devtools"));
}

fn migration_count(conn: &rusqlite::Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM schema_migrations", [], |row| {
        row.get(0)
    })
    .unwrap()
}
