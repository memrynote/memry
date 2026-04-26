use memry_desktop_tauri_lib::db::note_metadata::{
    count_local_only, delete_soft, exists_path, get_by_id, get_by_path, list_active,
    list_in_folder, rename_path, set_local_only, upsert, NoteMetadataRow,
};
use memry_desktop_tauri_lib::test_helpers::open_in_memory_with_migrations;

fn row(id: &str, path: &str, title: &str) -> NoteMetadataRow {
    NoteMetadataRow {
        id: id.to_string(),
        path: path.to_string(),
        title: title.to_string(),
        emoji: None,
        file_type: "markdown".into(),
        mime_type: None,
        file_size: None,
        attachment_id: None,
        attachment_references: None,
        local_only: false,
        sync_policy: "sync".into(),
        journal_date: None,
        property_definition_names: None,
        clock: None,
        synced_at: None,
        created_at: "2026-04-26T00:00:00.000Z".into(),
        modified_at: "2026-04-26T00:00:00.000Z".into(),
    }
}

#[test]
fn upsert_and_get_by_id_and_path() {
    let conn = open_in_memory_with_migrations();
    upsert(&conn, &row("n1", "Inbox/note-1.md", "First")).unwrap();

    let got = get_by_id(&conn, "n1").unwrap().expect("row");
    assert_eq!(got.title, "First");
    assert_eq!(got.path, "Inbox/note-1.md");

    let by_path = get_by_path(&conn, "Inbox/note-1.md").unwrap().expect("row");
    assert_eq!(by_path.id, "n1");
    assert!(exists_path(&conn, "Inbox/note-1.md").unwrap());
}

#[test]
fn list_helpers_exclude_soft_deleted_rows() {
    let conn = open_in_memory_with_migrations();
    upsert(&conn, &row("a", "Inbox/a.md", "A")).unwrap();
    upsert(&conn, &row("b", "Inbox/b.md", "B")).unwrap();
    upsert(&conn, &row("c", "Projects/c.md", "C")).unwrap();
    delete_soft(&conn, "a", "2026-04-26T01:00:00.000Z").unwrap();

    let active = list_active(&conn).unwrap();
    assert_eq!(
        active.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        vec!["b", "c"]
    );
    assert!(!exists_path(&conn, "Inbox/a.md").unwrap());

    let inbox = list_in_folder(&conn, "Inbox").unwrap();
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].id, "b");
}

#[test]
fn rename_path_updates_unique_index_atomically() {
    let conn = open_in_memory_with_migrations();
    upsert(&conn, &row("n", "old.md", "T")).unwrap();
    rename_path(&conn, "n", "new.md", "2026-04-26T02:00:00.000Z").unwrap();

    assert!(get_by_path(&conn, "old.md").unwrap().is_none());
    assert!(get_by_path(&conn, "new.md").unwrap().is_some());
}

#[test]
fn local_only_helpers_count_active_rows() {
    let conn = open_in_memory_with_migrations();
    upsert(&conn, &row("a", "a.md", "A")).unwrap();
    upsert(&conn, &row("b", "b.md", "B")).unwrap();
    set_local_only(&conn, "a", true, "2026-04-26T03:00:00.000Z").unwrap();
    set_local_only(&conn, "b", true, "2026-04-26T03:00:00.000Z").unwrap();
    delete_soft(&conn, "b", "2026-04-26T04:00:00.000Z").unwrap();

    assert_eq!(count_local_only(&conn).unwrap(), 1);
}
