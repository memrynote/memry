use memry_desktop_tauri_lib::commands::notes::{
    NoteCreateInput, notes_create_inner, notes_get_links_inner, notes_get_tags_inner,
    notes_preview_by_title_inner, notes_resolve_by_title_inner,
};
use memry_desktop_tauri_lib::db::tag_definitions;
use memry_desktop_tauri_lib::test_helpers::{open_in_memory_with_migrations, test_vault_runtime};

#[tokio::test]
async fn get_tags_aggregates_counts_from_inline_hashtags_and_definitions() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();

    tag_definitions::upsert(&conn, "work", "blue").unwrap();

    notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "First".into(),
            content: Some("plan #work today".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap();
    notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Second".into(),
            content: Some("more #work and #personal".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap();

    let tags = notes_get_tags_inner(&conn).unwrap();
    let work = tags.iter().find(|tag| tag.tag == "work").expect("work tag");
    assert_eq!(work.count, 2);
    assert_eq!(work.color.as_deref(), Some("blue"));
    let personal = tags
        .iter()
        .find(|tag| tag.tag == "personal")
        .expect("personal tag");
    assert_eq!(personal.count, 1);
    assert!(personal.color.is_none());
}

#[tokio::test]
async fn get_links_returns_outgoing_targets_and_incoming_sources() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();

    let target = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Target".into(),
            content: Some("standalone".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();
    let source = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Source".into(),
            content: Some("see [[Target]] for details".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let from_source = notes_get_links_inner(&conn, &vault, &source.id)
        .await
        .unwrap();
    assert_eq!(from_source.outgoing.len(), 1);
    assert_eq!(from_source.outgoing[0].target_title, "Target");
    assert!(from_source.incoming.is_empty());

    let from_target = notes_get_links_inner(&conn, &vault, &target.id)
        .await
        .unwrap();
    assert!(from_target.outgoing.is_empty());
    assert_eq!(from_target.incoming.len(), 1);
    assert_eq!(from_target.incoming[0].source_id, source.id);
    assert_eq!(from_target.incoming[0].source_title, "Source");
}

#[tokio::test]
async fn get_links_does_not_treat_prefixed_titles_as_backlinks() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();

    let target = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Foo".into(),
            content: Some("standalone".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();
    notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Source".into(),
            content: Some("see [[Foobar]] instead".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap();

    let links = notes_get_links_inner(&conn, &vault, &target.id)
        .await
        .unwrap();
    assert!(links.incoming.is_empty());
}

#[tokio::test]
async fn get_links_outgoing_handles_pipe_aliases_and_multiple_links() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();

    let source = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Hub".into(),
            content: Some("see [[Alpha|read me]] and [[Beta]]".into()),
            folder: Some("Inbox".into()),
            tags: None,
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let result = notes_get_links_inner(&conn, &vault, &source.id)
        .await
        .unwrap();
    let titles: Vec<_> = result
        .outgoing
        .iter()
        .map(|link| link.target_title.as_str())
        .collect();
    assert_eq!(titles, vec!["Alpha", "Beta"]);
}

#[tokio::test]
async fn resolve_by_title_returns_match_case_insensitively() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Notes Page".into(),
            content: Some("body".into()),
            folder: Some("Inbox".into()),
            tags: Some(vec!["docs".into()]),
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let resolved = notes_resolve_by_title_inner(&conn, "notes page")
        .unwrap()
        .expect("match");
    assert_eq!(resolved.id, created.id);
    assert_eq!(resolved.title, "Notes Page");
    assert_eq!(resolved.path, created.path);
    assert_eq!(
        serde_json::to_value(&resolved).unwrap()["fileType"],
        "markdown",
        "wiki link resolution must identify markdown notes"
    );

    assert!(
        notes_resolve_by_title_inner(&conn, "missing")
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn preview_by_title_returns_snippet_payload_or_none() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    tag_definitions::upsert(&conn, "docs", "green").unwrap();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Preview".into(),
            content: Some("the snippet text".into()),
            folder: Some("Inbox".into()),
            tags: Some(vec!["docs".into()]),
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let preview = notes_preview_by_title_inner(&conn, "preview")
        .unwrap()
        .expect("preview");
    assert_eq!(preview.id, created.id);
    assert_eq!(preview.title, "Preview");
    assert_eq!(preview.snippet, "the snippet text");
    let preview_json = serde_json::to_value(&preview).unwrap();
    assert_eq!(preview_json["createdAt"], created.created);
    assert_eq!(preview_json["tags"][0]["name"], "docs");
    assert_eq!(preview_json["tags"][0]["color"], "green");

    assert!(
        notes_preview_by_title_inner(&conn, "missing")
            .unwrap()
            .is_none()
    );
}
