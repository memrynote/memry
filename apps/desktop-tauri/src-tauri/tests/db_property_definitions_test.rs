use memry_desktop_tauri_lib::db::property_definitions::{
    add_option, add_status_option, create, delete, ensure, get, list, remove_option, rename_option,
    update, update_option_color, update_type, PropertyDefinitionRow,
};
use memry_desktop_tauri_lib::test_helpers::open_in_memory_with_migrations;

fn def(name: &str, ty: &str) -> PropertyDefinitionRow {
    PropertyDefinitionRow {
        name: name.into(),
        ty: ty.into(),
        options: None,
        default_value: None,
        color: None,
        created_at: "2026-04-26T00:00:00.000Z".into(),
    }
}

fn option_names(options: Option<String>) -> Vec<String> {
    serde_json::from_str::<Vec<serde_json::Value>>(&options.unwrap())
        .unwrap()
        .into_iter()
        .map(|option| option["name"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn create_get_and_list_in_name_order() {
    let conn = open_in_memory_with_migrations();

    create(&conn, &def("status", "select")).unwrap();
    create(&conn, &def("priority", "number")).unwrap();

    let all = list(&conn).unwrap();
    assert_eq!(
        all.iter().map(|row| row.name.as_str()).collect::<Vec<_>>(),
        vec!["priority", "status"]
    );
    assert_eq!(get(&conn, "status").unwrap().unwrap().ty, "select");
    assert!(get(&conn, "missing").unwrap().is_none());
}

#[test]
fn update_and_ensure_definition() {
    let conn = open_in_memory_with_migrations();

    ensure(&conn, "status", "select", Some("open")).unwrap();
    assert_eq!(
        get(&conn, "status")
            .unwrap()
            .unwrap()
            .default_value
            .as_deref(),
        Some("open")
    );

    ensure(&conn, "status", "status", Some("closed")).unwrap();
    let ensured = get(&conn, "status").unwrap().unwrap();
    assert_eq!(ensured.ty, "select");
    assert_eq!(ensured.default_value.as_deref(), Some("open"));

    update_type(&conn, "status", "status").unwrap();
    assert_eq!(get(&conn, "status").unwrap().unwrap().ty, "status");

    let mut updated = def("status", "multi_select");
    updated.options = Some(r##"[{"name":"active","color":"#10b981"}]"##.into());
    updated.default_value = Some("active".into());
    updated.color = Some("#111827".into());
    update(&conn, &updated).unwrap();

    let row = get(&conn, "status").unwrap().unwrap();
    assert_eq!(row.ty, "multi_select");
    assert_eq!(row.default_value.as_deref(), Some("active"));
    assert_eq!(row.color.as_deref(), Some("#111827"));
    assert_eq!(option_names(row.options), vec!["active"]);
}

#[test]
fn add_remove_rename_and_recolor_option() {
    let conn = open_in_memory_with_migrations();
    create(&conn, &def("status", "select")).unwrap();

    add_option(&conn, "status", "active", Some("#10b981")).unwrap();
    add_option(&conn, "status", "active", Some("#f59e0b")).unwrap();
    add_option(&conn, "status", "blocked", Some("#ef4444")).unwrap();
    rename_option(&conn, "status", "active", "in-progress").unwrap();
    update_option_color(&conn, "status", "in-progress", "#3b82f6").unwrap();
    remove_option(&conn, "status", "blocked").unwrap();

    let row = get(&conn, "status").unwrap().unwrap();
    let opts: serde_json::Value = serde_json::from_str(&row.options.unwrap()).unwrap();
    assert_eq!(opts.as_array().unwrap().len(), 1);
    assert_eq!(opts[0]["name"], "in-progress");
    assert_eq!(opts[0]["color"], "#3b82f6");
}

#[test]
fn status_options_are_category_scoped() {
    let conn = open_in_memory_with_migrations();
    create(&conn, &def("status", "status")).unwrap();

    add_status_option(&conn, "status", "todo", "queued", Some("#94a3b8")).unwrap();
    add_status_option(&conn, "status", "todo", "queued", Some("#ef4444")).unwrap();
    add_status_option(&conn, "status", "done", "queued", Some("#22c55e")).unwrap();

    let row = get(&conn, "status").unwrap().unwrap();
    let opts: serde_json::Value = serde_json::from_str(&row.options.unwrap()).unwrap();
    assert_eq!(opts.as_array().unwrap().len(), 2);
    assert_eq!(opts[0]["category"], "todo");
    assert_eq!(opts[0]["color"], "#94a3b8");
    assert_eq!(opts[1]["category"], "done");
}

#[test]
fn delete_removes_definition() {
    let conn = open_in_memory_with_migrations();
    create(&conn, &def("status", "select")).unwrap();

    delete(&conn, "status").unwrap();

    assert!(list(&conn).unwrap().is_empty());
}
