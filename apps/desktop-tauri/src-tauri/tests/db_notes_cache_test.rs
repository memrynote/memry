use memry_desktop_tauri_lib::db::note_metadata::{get_by_id, upsert, NoteMetadataRow};
use memry_desktop_tauri_lib::db::notes_cache::{
    count_active, delete, list_active, refresh_from_metadata,
};
use memry_desktop_tauri_lib::test_helpers::open_in_memory_with_migrations;
use memry_desktop_tauri_lib::vault::frontmatter::create_frontmatter;
use memry_desktop_tauri_lib::vault::notes_io;
use std::fs;

fn make_vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("notes")).unwrap();
    dir
}

fn metadata(id: &str, path: &str, title: &str, modified_at: &str) -> NoteMetadataRow {
    NoteMetadataRow {
        id: id.to_string(),
        path: path.to_string(),
        title: title.to_string(),
        emoji: Some("note".into()),
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
        modified_at: modified_at.to_string(),
    }
}

async fn write_note(vault: &tempfile::TempDir, path: &str, title: &str, body: &str) {
    let mut fm = create_frontmatter(title, &[]);
    fm.id = path.replace(['/', '.'], "-");
    notes_io::write_note_to_disk(vault.path(), path, &fm, body)
        .await
        .unwrap();
}

#[tokio::test]
async fn refresh_from_metadata_caches_snippet_and_word_count() {
    let conn = open_in_memory_with_migrations();
    let vault = make_vault();
    write_note(&vault, "notes/a.md", "A", "alpha beta gamma").await;
    upsert(
        &conn,
        &metadata("a", "notes/a.md", "A", "2026-04-26T01:00:00.000Z"),
    )
    .unwrap();
    let row = get_by_id(&conn, "a").unwrap().expect("metadata");

    refresh_from_metadata(&conn, vault.path(), &row)
        .await
        .unwrap();

    let cached = list_active(&conn, 10, 0, "modified").unwrap();
    assert_eq!(cached.len(), 1);
    assert_eq!(cached[0].snippet, "alpha beta gamma");
    assert_eq!(cached[0].word_count, 3);
}

#[tokio::test]
async fn list_active_supports_pagination_and_sorting() {
    let conn = open_in_memory_with_migrations();
    let vault = make_vault();
    write_note(&vault, "notes/a.md", "Alpha", "old body").await;
    write_note(&vault, "notes/b.md", "Beta", "new body").await;
    upsert(
        &conn,
        &metadata("a", "notes/a.md", "Alpha", "2026-04-26T01:00:00.000Z"),
    )
    .unwrap();
    upsert(
        &conn,
        &metadata("b", "notes/b.md", "Beta", "2026-04-26T02:00:00.000Z"),
    )
    .unwrap();
    for id in ["a", "b"] {
        let row = get_by_id(&conn, id).unwrap().expect("metadata");
        refresh_from_metadata(&conn, vault.path(), &row)
            .await
            .unwrap();
    }

    let modified = list_active(&conn, 1, 0, "modified").unwrap();
    assert_eq!(modified[0].id, "b");

    let title_page = list_active(&conn, 1, 1, "title").unwrap();
    assert_eq!(title_page[0].id, "b");
}

#[tokio::test]
async fn count_and_delete_cache_rows() {
    let conn = open_in_memory_with_migrations();
    let vault = make_vault();
    write_note(&vault, "notes/a.md", "A", "body").await;
    upsert(
        &conn,
        &metadata("a", "notes/a.md", "A", "2026-04-26T01:00:00.000Z"),
    )
    .unwrap();
    let row = get_by_id(&conn, "a").unwrap().expect("metadata");
    refresh_from_metadata(&conn, vault.path(), &row)
        .await
        .unwrap();

    assert_eq!(count_active(&conn).unwrap(), 1);
    delete(&conn, "a").unwrap();
    assert_eq!(count_active(&conn).unwrap(), 0);
}
