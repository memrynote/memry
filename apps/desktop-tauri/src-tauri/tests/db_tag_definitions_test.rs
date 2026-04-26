use memry_desktop_tauri_lib::db::note_metadata::{upsert as upsert_note, NoteMetadataRow};
use memry_desktop_tauri_lib::db::tag_definitions::{count, list, list_with_counts, rename, upsert};
use memry_desktop_tauri_lib::test_helpers::open_in_memory_with_migrations;

fn note(id: &str) -> NoteMetadataRow {
    NoteMetadataRow {
        id: id.to_string(),
        path: format!("notes/{id}.md"),
        title: id.to_string(),
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

fn insert_cache(
    conn: &rusqlite::Connection,
    id: &str,
    title: &str,
    snippet: &str,
    tags_json: &str,
) {
    conn.execute(
        "INSERT INTO notes_cache (
            id, title, path, snippet, word_count, tags_json,
            modified_at, created_at, local_only
         ) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?6, 0)",
        rusqlite::params![
            id,
            title,
            format!("notes/{id}.md"),
            snippet,
            tags_json,
            "2026-04-26T00:00:00.000Z",
        ],
    )
    .unwrap();
}

#[test]
fn upsert_normalizes_and_count_tracks_definitions() {
    let conn = open_in_memory_with_migrations();

    upsert(&conn, " Work ", "#ef4444").unwrap();
    upsert(&conn, "work", "#22c55e").unwrap();

    assert_eq!(count(&conn).unwrap(), 1);
    let rows = list(&conn).unwrap();
    assert_eq!(rows[0].name, "work");
    assert_eq!(rows[0].color, "#22c55e");
}

#[test]
fn rename_updates_definition_and_children() {
    let conn = open_in_memory_with_migrations();
    upsert(&conn, "work", "#ef4444").unwrap();
    upsert(&conn, "work/client", "#3b82f6").unwrap();

    let changed = rename(&conn, "work", "personal").unwrap();

    assert_eq!(changed, 2);
    let names = list(&conn)
        .unwrap()
        .into_iter()
        .map(|row| row.name)
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["personal", "personal/client"]);
}

#[test]
fn list_with_counts_aggregates_frontmatter_tags_json_and_inline_snippets() {
    let conn = open_in_memory_with_migrations();
    upsert(&conn, "work", "#ef4444").unwrap();

    upsert_note(&conn, &note("a")).unwrap();
    insert_cache(
        &conn,
        "a",
        "A",
        "Discuss #work and #idea today",
        r#"["work","project"]"#,
    );

    let rows = list_with_counts(&conn).unwrap();
    let work = rows.iter().find(|row| row.name == "work").unwrap();
    let project = rows.iter().find(|row| row.name == "project").unwrap();
    let idea = rows.iter().find(|row| row.name == "idea").unwrap();

    assert_eq!(work.count, 2);
    assert_eq!(work.color.as_deref(), Some("#ef4444"));
    assert_eq!(project.count, 1);
    assert_eq!(idea.count, 1);
}

#[test]
fn list_with_counts_skips_soft_deleted_notes() {
    let conn = open_in_memory_with_migrations();
    upsert(&conn, "work", "#ef4444").unwrap();

    let mut alive = note("alive");
    alive.clock = None;
    upsert_note(&conn, &alive).unwrap();
    insert_cache(&conn, "alive", "Alive", "alive body", r#"["work"]"#);

    let mut tombstone = note("dead");
    tombstone.clock = Some(r#"{"deleted_at":"2026-04-26T00:00:00.000Z"}"#.into());
    upsert_note(&conn, &tombstone).unwrap();
    insert_cache(&conn, "dead", "Dead", "dead body", r#"["work","ghost"]"#);

    let rows = list_with_counts(&conn).unwrap();
    let work = rows.iter().find(|row| row.name == "work").unwrap();
    assert_eq!(work.count, 1, "only the live note's `work` tag counts");
    assert!(rows.iter().all(|row| row.name != "ghost"));
}
