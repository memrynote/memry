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
    note_created_event_payload, note_deleted_event_payload, note_local_only_event_payload,
    note_moved_event_payload, note_renamed_event_payload, note_update_event_changes,
    note_updated_event_payload, notes_create_inner, notes_delete_inner, notes_exists_inner,
    notes_get_local_only_count_inner, notes_list_by_folder_inner, notes_list_inner,
    notes_move_inner, notes_rename_inner, notes_set_local_only_inner, notes_update_inner,
    JsonUnknown, NoteCreateInput, NoteDto, NoteListOptions, NoteUpdateInput, NOTE_CREATED_EVENT,
    NOTE_DELETED_EVENT, NOTE_MOVED_EVENT, NOTE_RENAMED_EVENT, NOTE_UPDATED_EVENT,
    TAGS_CHANGED_EVENT,
};
use memry_desktop_tauri_lib::db::note_metadata;
use memry_desktop_tauri_lib::test_helpers::{open_in_memory_with_migrations, test_vault_runtime};
use memry_desktop_tauri_lib::vault::notes_io;
use serde_json::json;

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
    assert_eq!(renamed.path, "notes/Inbox/renamed-doc.md");

    assert!(
        notes_io::read_note_from_disk(&vault.require_current().unwrap(), &created.path)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        notes_io::read_note_from_disk(&vault.require_current().unwrap(), &renamed.path)
            .await
            .unwrap()
            .is_some()
    );
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
    assert_eq!(moved.path, "notes/Archive/drop.md");

    let listing = notes_list_by_folder_inner(&conn, "Archive").unwrap();
    assert_eq!(listing.total, 1);
    assert_eq!(listing.notes[0].path, "notes/Archive/drop.md");

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
    assert!(raw.path.starts_with(".trash/"));

    let recreated = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Discard".into(),
            content: Some("again".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();
    assert_eq!(recreated.path, created.path);
}

#[tokio::test]
async fn update_after_soft_delete_returns_not_found_and_keeps_note_hidden() {
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

    let err = notes_update_inner(
        &conn,
        &vault,
        NoteUpdateInput {
            id: created.id.clone(),
            title: Some("Resurface".into()),
            content: Some("stale autosave".into()),
            tags: None,
            frontmatter: None,
            emoji: None,
        },
    )
    .await
    .unwrap_err();

    assert!(err.to_string().contains("not found"));
    let listing = notes_list_inner(&conn, None).unwrap();
    assert_eq!(listing.total, 0);
    assert!(listing.notes.is_empty());
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

#[test]
fn list_honors_contract_limit_above_one_thousand() {
    let conn = open_in_memory_with_migrations();
    for index in 0..1001 {
        let id = format!("note-{index:04}");
        conn.execute(
            "INSERT INTO notes_cache (
                id, title, path, snippet, word_count, tags_json, inline_tags_json,
                modified_at, created_at, local_only
             ) VALUES (?1, ?2, ?3, '', 0, '[]', '[]', ?4, ?4, 0)",
            rusqlite::params![
                id,
                format!("Doc {index:04}"),
                format!("notes/doc-{index:04}.md"),
                "2026-04-27T00:00:00.000Z",
            ],
        )
        .unwrap();
    }

    let page = notes_list_inner(
        &conn,
        Some(NoteListOptions {
            folder: None,
            tags: None,
            sort_by: Some("title".into()),
            sort_order: Some("asc".into()),
            limit: Some(1001),
            offset: Some(0),
        }),
    )
    .unwrap();

    assert_eq!(page.total, 1001);
    assert_eq!(page.notes.len(), 1001);
    assert!(!page.has_more);
}

#[test]
fn update_event_changes_includes_content_for_content_saves() {
    let input = NoteUpdateInput {
        id: "note-1".into(),
        title: None,
        content: Some("new [[Target]] body".into()),
        tags: None,
        frontmatter: None,
        emoji: None,
    };
    let note = NoteDto {
        id: "note-1".into(),
        path: "notes/Inbox/doc.md".into(),
        title: "Doc".into(),
        content: "new [[Target]] body".into(),
        frontmatter: serde_json::json!({}).into(),
        properties: serde_json::json!({}).into(),
        created: "2026-04-27T00:00:00Z".into(),
        modified: "2026-04-27T00:00:01Z".into(),
        tags: vec![],
        aliases: vec![],
        word_count: 3,
        emoji: None,
    };

    let changes = note_update_event_changes(&input, &note);
    assert_eq!(changes["content"], "new [[Target]] body");
    assert!(changes.get("title").is_none());
}

#[test]
fn note_event_names_match_renderer_subscriptions() {
    assert_eq!(NOTE_CREATED_EVENT, "note-created");
    assert_eq!(NOTE_UPDATED_EVENT, "note-updated");
    assert_eq!(NOTE_DELETED_EVENT, "note-deleted");
    assert_eq!(NOTE_RENAMED_EVENT, "note-renamed");
    assert_eq!(NOTE_MOVED_EVENT, "note-moved");
    assert_eq!(TAGS_CHANGED_EVENT, "tags-changed");
}

#[test]
fn note_event_payloads_match_renderer_shapes() {
    let note = sample_note();
    let update = NoteUpdateInput {
        id: note.id.clone(),
        title: Some("New title".into()),
        content: None,
        tags: Some(vec!["next".into()]),
        frontmatter: Some(JsonUnknown::from(json!({ "emoji": "note" }))),
        emoji: None,
    };

    assert_eq!(
        note_created_event_payload(&note),
        json!({
            "note": {
                "id": "note-1",
                "path": "notes/Inbox/example.md",
                "title": "Example",
                "created": "2026-04-27T00:00:00.000Z",
                "modified": "2026-04-27T00:00:00.000Z",
                "tags": ["next"],
                "wordCount": 1,
                "snippet": "body",
                "emoji": "note",
                "localOnly": false
            },
            "source": "internal"
        })
    );
    assert_eq!(
        note_updated_event_payload(&update, &note),
        json!({
            "id": "note-1",
            "changes": {
                "title": "Example",
                "tags": ["next"],
                "frontmatter": {},
                "emoji": "note"
            },
            "source": "internal"
        })
    );
    assert_eq!(
        note_deleted_event_payload("note-1", "notes/Inbox/example.md"),
        json!({ "id": "note-1", "path": "notes/Inbox/example.md", "source": "internal" })
    );
    assert_eq!(
        note_renamed_event_payload(&note, "notes/Inbox/old.md", "Old"),
        json!({
            "id": "note-1",
            "oldPath": "notes/Inbox/old.md",
            "newPath": "notes/Inbox/example.md",
            "oldTitle": "Old",
            "newTitle": "Example",
            "source": "internal"
        })
    );
    assert_eq!(
        note_moved_event_payload(&note, "notes/Archive/example.md"),
        json!({
            "id": "note-1",
            "oldPath": "notes/Archive/example.md",
            "newPath": "notes/Inbox/example.md",
            "source": "internal"
        })
    );
    assert_eq!(
        note_local_only_event_payload("note-1", true),
        json!({
            "id": "note-1",
            "changes": {
                "frontmatter": { "localOnly": true },
                "localOnly": true
            },
            "source": "internal"
        })
    );
}

fn sample_note() -> NoteDto {
    NoteDto {
        id: "note-1".into(),
        path: "notes/Inbox/example.md".into(),
        title: "Example".into(),
        content: "body".into(),
        frontmatter: JsonUnknown::from(json!({})),
        properties: JsonUnknown::from(json!({})),
        created: "2026-04-27T00:00:00.000Z".into(),
        modified: "2026-04-27T00:00:00.000Z".into(),
        tags: vec!["next".into()],
        aliases: Vec::new(),
        word_count: 1,
        emoji: Some("note".into()),
    }
}
