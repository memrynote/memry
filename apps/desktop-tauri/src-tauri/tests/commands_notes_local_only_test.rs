use memry_desktop_tauri_lib::commands::notes::{
    notes_create_inner, notes_delete_inner, notes_get_local_only_count_inner,
    notes_set_local_only_inner, NoteCreateInput,
};
use memry_desktop_tauri_lib::db::note_metadata;
use memry_desktop_tauri_lib::test_helpers::{open_in_memory_with_migrations, test_vault_runtime};
use memry_desktop_tauri_lib::vault::notes_io;

#[tokio::test]
async fn set_local_only_flips_metadata_sync_policy_frontmatter_and_count() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Private".into(),
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

    assert_eq!(notes_get_local_only_count_inner(&conn).unwrap().count, 0);

    let response = notes_set_local_only_inner(&vault, &conn, &created.id, true)
        .await
        .unwrap();
    assert!(response.success);

    let row = note_metadata::get_by_id(&conn, &created.id)
        .unwrap()
        .unwrap();
    assert!(row.local_only);
    assert_eq!(row.sync_policy, "local-only");
    assert_eq!(notes_get_local_only_count_inner(&conn).unwrap().count, 1);

    let on_disk = notes_io::read_note_from_disk(&vault.require_current().unwrap(), &created.path)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(on_disk.parsed.frontmatter.local_only, Some(true));

    let response = notes_set_local_only_inner(&vault, &conn, &created.id, false)
        .await
        .unwrap();
    assert!(response.success);
    let row = note_metadata::get_by_id(&conn, &created.id)
        .unwrap()
        .unwrap();
    assert!(!row.local_only);
    assert_eq!(row.sync_policy, "sync");
    assert_eq!(notes_get_local_only_count_inner(&conn).unwrap().count, 0);

    let on_disk = notes_io::read_note_from_disk(&vault.require_current().unwrap(), &created.path)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(on_disk.parsed.frontmatter.local_only, Some(false));
}

#[tokio::test]
async fn local_only_count_excludes_soft_deleted_notes() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();

    let kept = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Keep".into(),
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
    let trashed = notes_create_inner(
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

    notes_set_local_only_inner(&vault, &conn, &kept.id, true)
        .await
        .unwrap();
    notes_set_local_only_inner(&vault, &conn, &trashed.id, true)
        .await
        .unwrap();
    assert_eq!(notes_get_local_only_count_inner(&conn).unwrap().count, 2);

    notes_delete_inner(&conn, &vault, &trashed.id)
        .await
        .unwrap();
    assert_eq!(notes_get_local_only_count_inner(&conn).unwrap().count, 1);
}
