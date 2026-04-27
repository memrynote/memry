//! `notes_list_inner` should honor `opts.tags` so callers passing
//! `notesService.list({ tags: [...] })` get a filtered list + correct total.
//! Multi-tag filters are an AND across the array (all tags must be present).

use memry_desktop_tauri_lib::commands::notes::{
    notes_create_inner, notes_list_inner, NoteCreateInput, NoteListOptions,
};
use memry_desktop_tauri_lib::test_helpers::{open_in_memory_with_migrations, test_vault_runtime};

fn options_with_tags(tags: Vec<String>) -> NoteListOptions {
    NoteListOptions {
        folder: None,
        tags: Some(tags),
        sort_by: Some("modified".into()),
        sort_order: Some("desc".into()),
        limit: Some(100),
        offset: Some(0),
    }
}

#[tokio::test]
async fn list_with_tag_filter_returns_only_matching_notes() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();

    notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Work A".into(),
            content: Some("body".into()),
            folder: Some("Inbox".into()),
            tags: Some(vec!["work".into()]),
            template: None,
        },
    )
    .await
    .unwrap();
    notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Work B".into(),
            content: Some("body".into()),
            folder: Some("Inbox".into()),
            tags: Some(vec!["work".into(), "urgent".into()]),
            template: None,
        },
    )
    .await
    .unwrap();
    notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Personal".into(),
            content: Some("body".into()),
            folder: Some("Inbox".into()),
            tags: Some(vec!["personal".into()]),
            template: None,
        },
    )
    .await
    .unwrap();

    let work = notes_list_inner(&conn, Some(options_with_tags(vec!["work".into()]))).unwrap();
    assert_eq!(work.total, 2);
    assert_eq!(work.notes.len(), 2);
    assert!(work.notes.iter().all(|n| n.tags.contains(&"work".into())));

    let personal =
        notes_list_inner(&conn, Some(options_with_tags(vec!["personal".into()]))).unwrap();
    assert_eq!(personal.total, 1);
    assert_eq!(personal.notes[0].title, "Personal");
}

#[tokio::test]
async fn list_with_multiple_tag_filter_requires_all_tags() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();

    notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Work-only".into(),
            content: Some("body".into()),
            folder: Some("Inbox".into()),
            tags: Some(vec!["work".into()]),
            template: None,
        },
    )
    .await
    .unwrap();
    notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Both".into(),
            content: Some("body".into()),
            folder: Some("Inbox".into()),
            tags: Some(vec!["work".into(), "urgent".into()]),
            template: None,
        },
    )
    .await
    .unwrap();

    let listing = notes_list_inner(
        &conn,
        Some(options_with_tags(vec!["work".into(), "urgent".into()])),
    )
    .unwrap();
    assert_eq!(listing.total, 1);
    assert_eq!(listing.notes[0].title, "Both");
}

#[tokio::test]
async fn list_with_empty_tag_filter_returns_all_active_notes() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Solo".into(),
            content: Some("body".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap();

    let listing = notes_list_inner(&conn, Some(options_with_tags(vec![]))).unwrap();
    assert_eq!(listing.total, 1);
}

#[tokio::test]
async fn list_with_tag_filter_includes_inline_only_hashtags() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Inline".into(),
            content: Some("plan #work today".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap();

    let listing = notes_list_inner(&conn, Some(options_with_tags(vec!["work".into()]))).unwrap();

    assert_eq!(listing.total, 1);
    assert_eq!(listing.notes[0].title, "Inline");
}

#[tokio::test]
async fn list_with_tag_filter_includes_inline_hashtags_after_preview_snippet() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let long_prefix = "x ".repeat(120);
    notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Late inline".into(),
            content: Some(format!("{long_prefix}then #client")),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap();

    let listing = notes_list_inner(&conn, Some(options_with_tags(vec!["client".into()]))).unwrap();

    assert_eq!(listing.total, 1);
    assert_eq!(listing.notes[0].title, "Late inline");
}
