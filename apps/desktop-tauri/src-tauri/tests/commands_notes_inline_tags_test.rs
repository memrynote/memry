//! Body-only saves (no explicit `tags` param) should reconcile inline
//! `#hashtags` from the new body into `frontmatter.tags` so the tags shown
//! in the renderer + cached in `notes_cache.tags_json` stay in sync with
//! what the user actually wrote.

use memry_desktop_tauri_lib::commands::notes::{
    notes_create_inner, notes_update_inner, NoteCreateInput, NoteUpdateInput,
};
use memry_desktop_tauri_lib::db::notes_cache;
use memry_desktop_tauri_lib::test_helpers::{open_in_memory_with_migrations, test_vault_runtime};

#[tokio::test]
async fn body_only_save_extracts_new_inline_tags_into_frontmatter() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Doc".into(),
            content: Some("plain body, no tags".into()),
            folder: Some("Inbox".into()),
            tags: None,
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
            content: Some("now with #urgent and #review tags".into()),
            tags: None,
            frontmatter: None,
            emoji: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    assert_eq!(updated.tags, vec!["urgent".to_string(), "review".to_string()]);
    let cached = notes_cache::list_active(&conn, 10, 0, "modified").unwrap();
    assert_eq!(cached[0].tags_json, "[\"urgent\",\"review\"]");
}

#[tokio::test]
async fn body_only_save_preserves_existing_explicit_frontmatter_tags() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Doc".into(),
            content: Some("initial".into()),
            folder: Some("Inbox".into()),
            tags: Some(vec!["explicit".into()]),
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
            content: Some("body now mentions #explicit and #fresh".into()),
            tags: None,
            frontmatter: None,
            emoji: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    assert_eq!(
        updated.tags,
        vec!["explicit".to_string(), "fresh".to_string()],
        "explicit tag stays at front, new inline tag is appended"
    );
}

#[tokio::test]
async fn explicit_tags_param_takes_precedence_over_inline_extraction() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Doc".into(),
            content: Some("initial".into()),
            folder: Some("Inbox".into()),
            tags: None,
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
            content: Some("body with #shouldbeignored".into()),
            tags: Some(vec!["wins".into()]),
            frontmatter: None,
            emoji: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    assert_eq!(
        updated.tags,
        vec!["wins".to_string()],
        "explicit tags param skips inline extraction"
    );
}

#[tokio::test]
async fn body_only_save_without_tag_changes_keeps_frontmatter_unchanged() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Doc".into(),
            content: Some("with #alpha tag".into()),
            folder: Some("Inbox".into()),
            tags: None,
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
            content: Some("rewrite mentioning #alpha again".into()),
            tags: None,
            frontmatter: None,
            emoji: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    assert_eq!(updated.tags, vec!["alpha".to_string()]);
}
