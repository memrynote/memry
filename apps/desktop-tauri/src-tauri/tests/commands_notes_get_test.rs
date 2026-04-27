use memry_desktop_tauri_lib::commands::notes::{
    notes_create_inner, notes_delete_inner, notes_get_by_path_inner, notes_get_inner,
    NoteCreateInput,
};
use memry_desktop_tauri_lib::test_helpers::{open_in_memory_with_migrations, test_vault_runtime};

#[tokio::test]
async fn get_note_by_id_and_path_returns_same_dto() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Read Me".into(),
            content: Some("alpha beta".into()),
            folder: Some("Docs".into()),
            tags: Some(vec!["docs".into()]),
            template: None,
        },
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let by_id = notes_get_inner(&conn, &vault, &created.id)
        .await
        .unwrap()
        .expect("note by id");
    let by_path = notes_get_by_path_inner(&conn, &vault, &created.path)
        .await
        .unwrap()
        .expect("note by path");

    assert_eq!(by_id.id, created.id);
    assert_eq!(by_id.path, created.path);
    assert_eq!(by_id.content, "alpha beta");
    assert_eq!(by_id.tags, vec!["docs"]);
    assert_eq!(by_path.id, by_id.id);
    assert_eq!(by_path.path, by_id.path);
    assert_eq!(by_path.content, by_id.content);
}

#[tokio::test]
async fn get_note_returns_none_when_missing() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();

    let result = notes_get_inner(&conn, &vault, "missing").await.unwrap();

    assert!(result.is_none());
}

#[tokio::test]
async fn get_note_returns_none_after_soft_delete() {
    let conn = open_in_memory_with_migrations();
    let vault = test_vault_runtime();
    let created = notes_create_inner(
        &conn,
        &vault,
        NoteCreateInput {
            title: "Delete Me".into(),
            content: Some("gone".into()),
            folder: Some("Docs".into()),
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

    let by_id = notes_get_inner(&conn, &vault, &created.id).await.unwrap();
    let by_path = notes_get_by_path_inner(&conn, &vault, &created.path)
        .await
        .unwrap();

    assert!(by_id.is_none());
    assert!(by_path.is_none());
}
