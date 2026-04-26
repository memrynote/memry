use memry_desktop_tauri_lib::db::folder_configs::{
    delete, get, get_template_inherited, set, FolderConfigRow,
};
use memry_desktop_tauri_lib::test_helpers::open_in_memory_with_migrations;

#[test]
fn round_trip_config() {
    let conn = open_in_memory_with_migrations();
    let cfg = FolderConfigRow {
        path: "Projects".into(),
        icon: Some("folder-kanban".into()),
        template_json: Some(r#"{"frontmatter":{"status":"active"}}"#.into()),
    };

    set(&conn, &cfg).unwrap();

    let got = get(&conn, "Projects").unwrap().expect("row");
    assert_eq!(got.icon.as_deref(), Some("folder-kanban"));
    assert_eq!(
        got.template_json.as_deref(),
        Some(r#"{"frontmatter":{"status":"active"}}"#)
    );
}

#[test]
fn template_inherits_from_parent() {
    let conn = open_in_memory_with_migrations();
    set(
        &conn,
        &FolderConfigRow {
            path: "Projects".into(),
            icon: None,
            template_json: Some(r#"{"frontmatter":{"status":"active"}}"#.into()),
        },
    )
    .unwrap();

    let inherited = get_template_inherited(&conn, "Projects/sub/deep")
        .unwrap()
        .expect("template");
    assert!(inherited.contains("\"status\":\"active\""));
}

#[test]
fn delete_removes_config() {
    let conn = open_in_memory_with_migrations();
    set(
        &conn,
        &FolderConfigRow {
            path: "Projects".into(),
            icon: Some("folder".into()),
            template_json: None,
        },
    )
    .unwrap();

    delete(&conn, "Projects").unwrap();

    assert!(get(&conn, "Projects").unwrap().is_none());
}
