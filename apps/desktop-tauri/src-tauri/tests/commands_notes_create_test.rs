use memry_desktop_tauri_lib::commands::notes::{
    notes_create_inner, notes_delete_inner, notes_delete_with_db_inner, notes_list_by_folder_inner,
    notes_list_inner, notes_list_with_backfill_inner, notes_move_inner, notes_update_inner,
    notes_update_with_db_inner, NoteCreateInput, NoteListOptions, NoteUpdateInput,
};
use memry_desktop_tauri_lib::db::{folder_configs, note_metadata, note_positions, notes_cache, Db};
use memry_desktop_tauri_lib::error::AppError;
use memry_desktop_tauri_lib::test_helpers::{open_in_memory_with_migrations, test_vault_runtime};
use memry_desktop_tauri_lib::vault::notes_io;
use memry_desktop_tauri_lib::vault::preferences::{read_config, update_config};
use std::time::Duration;

#[tokio::test]
async fn create_note_writes_metadata_vault_file_cache_and_returns_dto() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();

    let result = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Hello".into(),
            content: Some("# Body".into()),
            folder: Some("Inbox".into()),
            tags: Some(vec!["work".into()]),
            template: None,
        },
    )
    .await
    .unwrap();

    assert!(result.success);
    let note = result.note.unwrap();
    assert_eq!(note.title, "Hello");
    assert_eq!(note.content, "# Body");
    assert_eq!(note.tags, vec!["work"]);
    assert!(note.path.starts_with("notes/Inbox/"));
    assert!(note.path.ends_with(".md"));

    let metadata = note_metadata::get_by_id(&conn, &note.id)
        .unwrap()
        .expect("metadata row");
    assert_eq!(metadata.path, note.path);
    assert_eq!(metadata.title, "Hello");

    let root = vault.require_current().unwrap();
    let on_disk = notes_io::read_note_from_disk(&root, &note.path)
        .await
        .unwrap()
        .expect("vault note");
    assert_eq!(on_disk.parsed.content, "# Body");
    assert_eq!(on_disk.parsed.frontmatter.id, note.id);
    assert_eq!(on_disk.parsed.frontmatter.title.as_deref(), Some("Hello"));

    let cached = notes_cache::list_active(&conn, 10, 0, "modified").unwrap();
    assert_eq!(cached.len(), 1);
    assert_eq!(cached[0].id, note.id);
    assert_eq!(cached[0].snippet, "# Body");
}

#[tokio::test]
async fn create_note_rejects_parent_segments_in_folder() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();

    let err = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Escape".into(),
            content: Some("body".into()),
            folder: Some("../archive".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .expect_err("create should reject parent traversal");

    assert!(matches!(err, AppError::Validation(ref message) if message.contains("..")));
}

#[tokio::test]
async fn create_note_treats_notes_prefixed_folder_as_logical_child() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();

    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Child".into(),
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

    assert_eq!(created.path, "notes/notes/Child/child.md");
    let listed = notes_list_by_folder_inner(&conn, "notes/Child").unwrap();
    assert_eq!(listed.notes.len(), 1);
    assert_eq!(listed.notes[0].id, created.id);
}

#[tokio::test]
async fn create_note_applies_template_body_tags_and_properties_when_content_empty() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let root = vault.require_current().unwrap();
    let templates_dir = root.join(".memry").join("templates");
    std::fs::create_dir_all(&templates_dir).unwrap();
    std::fs::write(
        templates_dir.join("meeting-notes.md"),
        r#"---
id: meeting-notes
name: Meeting Notes
tags:
  - meetings
properties:
  - name: Status
    value: Planned
---
# {{title}}

Agenda
"#,
    )
    .unwrap();

    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Weekly Sync".into(),
            content: None,
            folder: Some("Inbox".into()),
            tags: Some(vec!["work".into()]),
            template: Some("meeting-notes".into()),
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    assert_eq!(created.content, "# Weekly Sync\n\nAgenda");
    assert_eq!(created.tags, vec!["meetings", "work"]);
    assert_eq!(created.frontmatter["properties"]["Status"], "Planned");
    assert_eq!(created.properties["Status"], "Planned");
}

#[tokio::test]
async fn create_note_applies_folder_template_json_payload() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();

    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Weekly Sync".into(),
            content: None,
            folder: Some("Inbox".into()),
            tags: Some(vec!["work".into()]),
            template: Some(
                serde_json::json!({
                    "content": "# {{title}}\n\nAgenda",
                    "frontmatter": {
                        "tags": ["meetings"],
                        "status": "active",
                        "properties": {
                            "priority": "high"
                        }
                    }
                })
                .to_string(),
            ),
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    assert_eq!(created.content, "# Weekly Sync\n\nAgenda");
    assert_eq!(created.tags, vec!["meetings", "work"]);
    assert_eq!(created.frontmatter["properties"]["status"], "active");
    assert_eq!(created.frontmatter["properties"]["priority"], "high");
    assert_eq!(created.properties["status"], "active");
    assert_eq!(created.properties["priority"], "high");
}

#[tokio::test]
async fn create_note_inherits_folder_template_when_template_omitted() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();

    folder_configs::set(
        &conn,
        &folder_configs::FolderConfigRow {
            path: "Inbox".into(),
            icon: None,
            template_json: Some(
                serde_json::json!({
                    "content": "# {{title}}\n\nAgenda",
                    "frontmatter": {
                        "tags": ["meetings"],
                        "properties": {
                            "priority": "high"
                        }
                    }
                })
                .to_string(),
            ),
        },
    )
    .unwrap();

    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Inherited".into(),
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

    assert_eq!(created.content, "# Inherited\n\nAgenda");
    assert_eq!(created.tags, vec!["meetings"]);
    assert_eq!(created.properties["priority"], "high");
}

#[tokio::test]
async fn create_note_generates_unique_path_without_overwriting_existing_file() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();

    let first = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Same Title".into(),
            content: Some("original body".into()),
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
            title: "Same Title".into(),
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

    assert_ne!(second.path, first.path);
    assert!(second.path.starts_with("notes/Inbox/same-title "));
    assert!(second.path.ends_with(".md"));

    let root = vault.require_current().unwrap();
    let on_disk = notes_io::read_note_from_disk(&root, &first.path)
        .await
        .unwrap()
        .expect("original note remains");
    assert_eq!(on_disk.parsed.content, "original body");

    let metadata = note_metadata::get_by_id(&conn, &first.id)
        .unwrap()
        .expect("original metadata remains");
    assert_eq!(metadata.title, "Same Title");

    let second_disk = notes_io::read_note_from_disk(&root, &second.path)
        .await
        .unwrap()
        .expect("second note is written to unique path");
    assert_eq!(second_disk.parsed.content, "new body");
}

#[tokio::test]
async fn create_note_retries_suffix_when_disk_file_appears_before_metadata() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let root = vault.require_current().unwrap();
    std::fs::create_dir_all(root.join("notes").join("Inbox")).unwrap();
    std::fs::write(
        root.join("notes").join("Inbox").join("race.md"),
        "pre-existing body",
    )
    .unwrap();

    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Race".into(),
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

    assert_eq!(created.path, "notes/Inbox/race 1.md");
    assert_eq!(
        std::fs::read_to_string(root.join("notes").join("Inbox").join("race.md")).unwrap(),
        "pre-existing body"
    );
}

#[tokio::test]
async fn update_note_changes_metadata_vault_file_cache_and_returns_dto() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Draft".into(),
            content: Some("old body".into()),
            folder: Some("Inbox".into()),
            tags: Some(vec!["old".into()]),
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    tokio::time::sleep(Duration::from_millis(5)).await;

    let updated = notes_update_inner(
        &conn,
        &vault,
        NoteUpdateInput {
            id: created.id.clone(),
            title: Some("Published".into()),
            content: Some("new body with more words".into()),
            tags: Some(vec!["new".into(), "shared".into()]),
            frontmatter: None,
            emoji: Some(Some("spark".into())),
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    assert_eq!(updated.id, created.id);
    assert_eq!(updated.title, "Published");
    assert_eq!(updated.content, "new body with more words");
    assert_eq!(updated.tags, vec!["new", "shared"]);
    assert_eq!(updated.emoji.as_deref(), Some("spark"));
    assert!(updated.modified > created.modified);

    let metadata = note_metadata::get_by_id(&conn, &created.id)
        .unwrap()
        .expect("metadata row");
    assert_eq!(metadata.title, "Published");
    assert_eq!(metadata.emoji.as_deref(), Some("spark"));
    assert_eq!(
        metadata.file_size,
        Some("new body with more words".len() as i64)
    );

    let root = vault.require_current().unwrap();
    let on_disk = notes_io::read_note_from_disk(&root, &updated.path)
        .await
        .unwrap()
        .expect("vault note");
    assert_eq!(on_disk.parsed.content, "new body with more words");
    assert_eq!(
        on_disk.parsed.frontmatter.title.as_deref(),
        Some("Published")
    );
    assert_eq!(on_disk.parsed.frontmatter.tags, vec!["new", "shared"]);

    let cached = notes_cache::list_active(&conn, 10, 0, "modified").unwrap();
    assert_eq!(cached[0].id, created.id);
    assert_eq!(cached[0].title, "Published");
    assert_eq!(cached[0].snippet, "new body with more words");
    assert_eq!(cached[0].word_count, 5);
    assert_eq!(cached[0].tags_json, "[\"new\",\"shared\"]");
}

#[tokio::test]
async fn update_note_merges_custom_frontmatter_and_returns_it() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Layout".into(),
            content: Some("body".into()),
            folder: Some("Inbox".into()),
            tags: Some(vec!["ui".into()]),
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let updated = notes_update_inner(
        &conn,
        &vault,
        NoteUpdateInput {
            id: created.id.clone(),
            title: None,
            content: None,
            tags: None,
            frontmatter: Some(
                serde_json::json!({
                    "fullWidth": true,
                    "rating": 4
                })
                .into(),
            ),
            emoji: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    assert_eq!(updated.frontmatter["id"], created.id);
    assert_eq!(updated.frontmatter["fullWidth"], true);
    assert_eq!(updated.frontmatter["rating"], 4);
    assert_eq!(updated.tags, vec!["ui"]);

    let root = vault.require_current().unwrap();
    let on_disk = notes_io::read_note_from_disk(&root, &updated.path)
        .await
        .unwrap()
        .expect("vault note");
    assert_eq!(
        on_disk.parsed.frontmatter.extra.get("fullWidth"),
        Some(&serde_yaml_ng::Value::Bool(true))
    );
}

#[tokio::test]
async fn delete_note_soft_deletes_metadata_removes_cache_and_trashes_vault_file() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Discard".into(),
            content: Some("remove me".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let result = notes_delete_inner(&conn, &vault, &created.id)
        .await
        .unwrap();

    assert!(result.success);
    let active = note_metadata::list_active(&conn).unwrap();
    assert!(active.iter().all(|row| row.id != created.id));
    assert_eq!(notes_cache::count_active(&conn).unwrap(), 0);

    let root = vault.require_current().unwrap();
    let original = notes_io::read_note_from_disk(&root, &created.path)
        .await
        .unwrap();
    assert!(original.is_none());
    assert!(root
        .join(".trash")
        .join(format!("{}.md", created.id))
        .exists());
}

#[tokio::test]
async fn list_notes_supports_pagination_modified_sort_and_folder_position_order() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let first = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "First".into(),
            content: Some("first body".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();
    tokio::time::sleep(Duration::from_millis(5)).await;
    let second = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Second".into(),
            content: Some("second body".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();
    tokio::time::sleep(Duration::from_millis(5)).await;
    let third = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Third".into(),
            content: Some("third body".into()),
            folder: Some("Projects".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let page = notes_list_inner(
        &conn,
        Some(NoteListOptions {
            folder: None,
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
    assert_eq!(
        page.notes
            .iter()
            .map(|note| note.id.as_str())
            .collect::<Vec<_>>(),
        [third.id.as_str(), second.id.as_str(),]
    );

    note_positions::reorder(&conn, "Inbox", &[second.path.clone(), first.path.clone()]).unwrap();
    let inbox = notes_list_by_folder_inner(&conn, "Inbox").unwrap();

    assert_eq!(inbox.total, 2);
    assert!(!inbox.has_more);
    assert_eq!(
        inbox
            .notes
            .iter()
            .map(|note| note.path.as_str())
            .collect::<Vec<_>>(),
        [second.path.as_str(), first.path.as_str()]
    );
    assert!(inbox
        .notes
        .iter()
        .all(|note| note.path.starts_with("notes/Inbox/")));
}

#[tokio::test]
async fn list_notes_backfills_empty_cache_from_metadata() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Backfill".into(),
            content: Some("cached later".into()),
            folder: Some("Inbox".into()),
            tags: Some(vec!["work".into()]),
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();
    notes_cache::delete(&conn, &created.id).unwrap();
    assert_eq!(notes_cache::count_active(&conn).unwrap(), 0);

    let listing = notes_list_with_backfill_inner(&conn, &vault, None)
        .await
        .unwrap();

    assert_eq!(listing.total, 1);
    assert_eq!(listing.notes[0].id, created.id);
    assert_eq!(listing.notes[0].snippet, "cached later");
    assert_eq!(notes_cache::count_active(&conn).unwrap(), 1);
}

#[tokio::test]
async fn list_notes_uses_configured_default_note_folder() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let root = vault.require_current().unwrap();
    let mut config = read_config(&root).unwrap();
    config.default_note_folder = "Custom".into();
    update_config(&root, &config).unwrap();

    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Custom Root".into(),
            content: Some("custom body".into()),
            folder: None,
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let listing = notes_list_with_backfill_inner(&conn, &vault, None)
        .await
        .unwrap();

    assert_eq!(created.path, "Custom/custom-root.md");
    assert_eq!(listing.total, 1);
    assert_eq!(listing.notes[0].id, created.id);
}

#[tokio::test]
async fn list_backfill_skips_when_custom_root_cache_is_current() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let root = vault.require_current().unwrap();
    let mut config = read_config(&root).unwrap();
    config.default_note_folder = "Custom".into();
    update_config(&root, &config).unwrap();

    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Cached".into(),
            content: Some("keep cached snippet".into()),
            folder: None,
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();
    assert_eq!(notes_cache::count_active(&conn).unwrap(), 0);
    assert_eq!(notes_cache::count_all_active(&conn).unwrap(), 1);

    tokio::fs::remove_file(root.join(&created.path))
        .await
        .unwrap();
    let listing = notes_list_with_backfill_inner(&conn, &vault, None)
        .await
        .unwrap();

    assert_eq!(listing.total, 1);
    assert_eq!(listing.notes[0].snippet, "keep cached snippet");
}

#[tokio::test]
async fn concurrent_updates_to_same_note_preserve_partial_changes() {
    let db = Db::open_memory().unwrap();
    let vault = test_vault_runtime();
    let created = {
        let conn = db.conn().unwrap();
        notes_create_inner(
            &conn,
            &vault,
            NoteCreateInput {
                title: "Concurrent".into(),
                content: Some("old body".into()),
                folder: None,
                tags: None,
                template: None,
            },
        )
        .await
        .unwrap()
        .note
        .unwrap()
    };

    let content_db = db.clone();
    let content_vault = vault.clone();
    let content_id = created.id.clone();
    let content_update = tokio::spawn(async move {
        notes_update_with_db_inner(
            &content_db,
            &content_vault,
            NoteUpdateInput {
                id: content_id,
                title: None,
                content: Some("new body".into()),
                tags: None,
                frontmatter: None,
                emoji: None,
            },
        )
        .await
        .unwrap();
    });

    let tags_db = db.clone();
    let tags_vault = vault.clone();
    let tags_id = created.id.clone();
    let tags_update = tokio::spawn(async move {
        notes_update_with_db_inner(
            &tags_db,
            &tags_vault,
            NoteUpdateInput {
                id: tags_id,
                title: None,
                content: None,
                tags: Some(vec!["manual".into()]),
                frontmatter: None,
                emoji: None,
            },
        )
        .await
        .unwrap();
    });

    content_update.await.unwrap();
    tags_update.await.unwrap();

    let final_note = {
        let conn = db.conn().unwrap();
        memry_desktop_tauri_lib::commands::notes::notes_get_inner(&conn, &vault, &created.id)
            .await
            .unwrap()
            .unwrap()
    };
    assert_eq!(final_note.content, "new body");
    assert_eq!(final_note.tags, vec!["manual"]);
}

#[tokio::test]
async fn concurrent_update_and_delete_do_not_resurrect_note() {
    let db = Db::open_memory().unwrap();
    let vault = test_vault_runtime();
    let created = {
        let conn = db.conn().unwrap();
        notes_create_inner(
            &conn,
            &vault,
            NoteCreateInput {
                title: "Delete Race".into(),
                content: Some("old body".into()),
                folder: None,
                tags: None,
                template: None,
            },
        )
        .await
        .unwrap()
        .note
        .unwrap()
    };

    let update_db = db.clone();
    let update_vault = vault.clone();
    let update_id = created.id.clone();
    let update = tokio::spawn(async move {
        notes_update_with_db_inner(
            &update_db,
            &update_vault,
            NoteUpdateInput {
                id: update_id,
                title: None,
                content: Some("new body".repeat(512)),
                tags: None,
                frontmatter: None,
                emoji: None,
            },
        )
        .await
    });

    tokio::task::yield_now().await;

    let delete_db = db.clone();
    let delete_vault = vault.clone();
    let delete_id = created.id.clone();
    let delete = tokio::spawn(async move {
        notes_delete_with_db_inner(&delete_db, &delete_vault, &delete_id)
            .await
            .map(|mutation| mutation.response)
    });

    update.await.unwrap().unwrap();
    delete.await.unwrap().unwrap();

    let conn = db.conn().unwrap();
    assert!(note_metadata::get_active_by_id(&conn, &created.id)
        .unwrap()
        .is_none());
    assert_eq!(notes_cache::count_all_active(&conn).unwrap(), 0);
    assert!(
        notes_io::read_note_from_disk(&vault.require_current().unwrap(), &created.path)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn move_note_keeps_positions_logical_under_configured_default_note_folder() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let root = vault.require_current().unwrap();
    let mut config = read_config(&root).unwrap();
    config.default_note_folder = "Custom".into();
    update_config(&root, &config).unwrap();

    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Ordered".into(),
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
    note_positions::reorder(&conn, "Inbox", std::slice::from_ref(&created.path)).unwrap();

    let moved = notes_move_inner(&conn, &vault, &created.id, "Archive")
        .await
        .unwrap()
        .note
        .unwrap();

    assert!(note_positions::get_for_folder(&conn, "Inbox")
        .unwrap()
        .is_empty());
    let archive = note_positions::get_for_folder(&conn, "Archive").unwrap();
    assert_eq!(archive.get(&moved.path).copied(), Some(0));
}

#[tokio::test]
async fn move_note_rejects_parent_segments_in_folder() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Move Escape".into(),
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

    let err = notes_move_inner(&conn, &vault, &created.id, "Inbox/../../archive")
        .await
        .expect_err("move should reject parent traversal");

    assert!(matches!(err, AppError::Validation(ref message) if message.contains("..")));
}
