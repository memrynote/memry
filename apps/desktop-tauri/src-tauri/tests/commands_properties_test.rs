//! Property-definition command coverage for M5 Phase G.
//!
//! Mirrors the inner-helper pattern from `commands_folders_test.rs` so we
//! exercise the DB slice without spinning up a Tauri AppHandle. Acceptance
//! gate per plan: ≥10 tests pass after Task 37 lands.

use memry_desktop_tauri_lib::commands::properties::{
    notes_add_property_option_inner, notes_add_status_option_inner,
    notes_create_property_definition_inner, notes_delete_property_definition_inner,
    notes_ensure_property_definition_inner, notes_get_property_definitions_inner,
    notes_remove_property_option_inner, notes_rename_property_option_inner,
    notes_update_option_color_inner, notes_update_property_definition_inner,
    notes_create_property_definition_response_inner,
    notes_update_property_definition_response_inner,
    CreatePropertyDefinitionInput,
};
use memry_desktop_tauri_lib::error::AppError;
use memry_desktop_tauri_lib::test_helpers::open_in_memory_with_migrations;
use serde_json::{json, Value};

fn create_input(name: &str, ty: &str) -> CreatePropertyDefinitionInput {
    CreatePropertyDefinitionInput {
        name: name.into(),
        ty: ty.into(),
        options: None,
        default_value: None,
        color: None,
    }
}

fn options_array(options: Option<&str>) -> Vec<Value> {
    serde_json::from_str(options.expect("options json")).expect("options array")
}

// ---- Task 36: list / create / update / ensure -----------------------------

#[test]
fn list_returns_empty_then_alphabetical_after_creates() {
    let conn = open_in_memory_with_migrations();

    assert!(notes_get_property_definitions_inner(&conn)
        .unwrap()
        .is_empty());

    notes_create_property_definition_inner(&conn, create_input("status", "select")).unwrap();
    notes_create_property_definition_inner(&conn, create_input("priority", "number")).unwrap();

    let rows = notes_get_property_definitions_inner(&conn).unwrap();
    assert_eq!(
        rows.iter().map(|row| row.name.as_str()).collect::<Vec<_>>(),
        vec!["priority", "status"]
    );
}

#[test]
fn create_round_trips_options_default_color_and_stamps_created_at() {
    let conn = open_in_memory_with_migrations();

    let row = notes_create_property_definition_inner(
        &conn,
        CreatePropertyDefinitionInput {
            name: "priority".into(),
            ty: "select".into(),
            options: Some(json!([{"value": "low", "color": "#94a3b8"}]).into()),
            default_value: Some("low".into()),
            color: Some("#111827".into()),
        },
    )
    .unwrap();

    assert_eq!(row.name, "priority");
    assert_eq!(row.ty, "select");
    assert_eq!(row.default_value.as_deref(), Some("low"));
    assert_eq!(row.color.as_deref(), Some("#111827"));
    assert!(!row.created_at.is_empty(), "created_at must be stamped");
    let opts = options_array(row.options.as_deref());
    assert_eq!(opts.len(), 1);
    assert_eq!(opts[0]["value"], "low");
}

#[test]
fn update_changes_type_and_returns_not_found_for_missing_name() {
    let conn = open_in_memory_with_migrations();
    notes_create_property_definition_inner(&conn, create_input("status", "select")).unwrap();

    let updated = notes_update_property_definition_inner(
        &conn,
        &json!({ "name": "status", "type": "multiselect" }),
    )
    .unwrap();
    assert_eq!(updated.ty, "multiselect");

    let updated = notes_update_property_definition_inner(
        &conn,
        &json!({ "name": "status", "color": "#ff0000" }),
    )
    .unwrap();
    assert_eq!(updated.ty, "multiselect");
    assert_eq!(updated.color.as_deref(), Some("#ff0000"));

    let err = notes_update_property_definition_inner(
        &conn,
        &json!({ "name": "ghost", "type": "select" }),
    )
    .expect_err("missing definition must error");
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
}

#[test]
fn property_definition_command_helpers_wrap_success_response() {
    let conn = open_in_memory_with_migrations();

    let created =
        notes_create_property_definition_response_inner(&conn, create_input("status", "select"))
            .unwrap();
    assert!(created.success);
    assert_eq!(created.definition.unwrap().name, "status");
    assert!(created.error.is_none());

    let updated = notes_update_property_definition_response_inner(
        &conn,
        &json!({ "name": "status", "type": "multiselect" }),
    )
    .unwrap();
    assert!(updated.success);
    assert_eq!(updated.definition.unwrap().ty, "multiselect");
    assert!(updated.error.is_none());
}

#[test]
fn ensure_inserts_on_miss_and_no_ops_on_hit() {
    let conn = open_in_memory_with_migrations();

    let inserted = notes_ensure_property_definition_inner(
        &conn,
        &json!({ "name": "owner", "type": "text", "defaultValue": "kaan" }),
    )
    .unwrap();
    assert_eq!(inserted.ty, "text");
    assert_eq!(inserted.default_value.as_deref(), Some("kaan"));

    // Re-ensuring with a different type/default must not overwrite the row.
    let again = notes_ensure_property_definition_inner(
        &conn,
        &json!({ "name": "owner", "type": "select", "defaultValue": "other" }),
    )
    .unwrap();
    assert_eq!(again.ty, "text");
    assert_eq!(again.default_value.as_deref(), Some("kaan"));
}

#[test]
fn ensure_validates_name_field() {
    let conn = open_in_memory_with_migrations();

    let err = notes_ensure_property_definition_inner(&conn, &json!({ "type": "text" }))
        .expect_err("missing name must error");
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}

// ---- Task 37: option mutations + delete -----------------------------------

#[test]
fn add_property_option_appends_and_is_idempotent_on_duplicate_value() {
    let conn = open_in_memory_with_migrations();
    notes_create_property_definition_inner(&conn, create_input("status", "select")).unwrap();

    notes_add_property_option_inner(
        &conn,
        &json!({
            "propertyName": "status",
            "option": { "value": "active", "color": "#10b981" }
        }),
    )
    .unwrap();
    // Duplicate value with a different color must be a no-op (db-layer guard).
    notes_add_property_option_inner(
        &conn,
        &json!({
            "propertyName": "status",
            "option": { "value": "active", "color": "#f59e0b" }
        }),
    )
    .unwrap();

    let rows = notes_get_property_definitions_inner(&conn).unwrap();
    let status = rows.into_iter().find(|r| r.name == "status").unwrap();
    let opts = options_array(status.options.as_deref());
    assert_eq!(opts.len(), 1);
    assert_eq!(opts[0]["value"], "active");
    assert_eq!(opts[0]["color"], "#10b981");
}

#[test]
fn add_status_option_fills_named_category_bucket() {
    let conn = open_in_memory_with_migrations();

    notes_ensure_property_definition_inner(&conn, &json!({ "name": "status", "type": "status" }))
        .unwrap();

    notes_add_status_option_inner(
        &conn,
        &json!({
            "propertyName": "status",
            "categoryKey": "todo",
            "option": { "value": "queued", "color": "#94a3b8" }
        }),
    )
    .unwrap();
    notes_add_status_option_inner(
        &conn,
        &json!({
            "propertyName": "status",
            "categoryKey": "done",
            "option": { "value": "shipped", "color": "#22c55e" }
        }),
    )
    .unwrap();

    let rows = notes_get_property_definitions_inner(&conn).unwrap();
    let status = rows.into_iter().find(|r| r.name == "status").unwrap();
    let opts: Value = serde_json::from_str(status.options.as_deref().unwrap()).unwrap();
    assert_eq!(opts["categories"]["todo"]["options"][0]["value"], "queued");
    assert_eq!(opts["categories"]["done"]["options"][0]["value"], "shipped");
    assert!(opts["categories"]["in_progress"]["options"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn remove_property_option_drops_select_entry() {
    let conn = open_in_memory_with_migrations();
    notes_create_property_definition_inner(&conn, create_input("status", "select")).unwrap();
    notes_add_property_option_inner(
        &conn,
        &json!({ "propertyName": "status", "option": { "value": "active", "color": "#10b981" }}),
    )
    .unwrap();
    notes_add_property_option_inner(
        &conn,
        &json!({ "propertyName": "status", "option": { "value": "blocked", "color": "#ef4444" }}),
    )
    .unwrap();

    notes_remove_property_option_inner(
        &conn,
        &json!({ "propertyName": "status", "optionValue": "blocked" }),
    )
    .unwrap();

    let rows = notes_get_property_definitions_inner(&conn).unwrap();
    let status = rows.into_iter().find(|r| r.name == "status").unwrap();
    let opts = options_array(status.options.as_deref());
    assert_eq!(opts.len(), 1);
    assert_eq!(opts[0]["value"], "active");
}

#[test]
fn rename_property_option_renames_in_status_shape() {
    let conn = open_in_memory_with_migrations();
    notes_ensure_property_definition_inner(&conn, &json!({ "name": "status", "type": "status" }))
        .unwrap();
    notes_add_status_option_inner(
        &conn,
        &json!({
            "propertyName": "status",
            "categoryKey": "todo",
            "option": { "value": "queued", "color": "#94a3b8" }
        }),
    )
    .unwrap();

    notes_rename_property_option_inner(
        &conn,
        &json!({ "propertyName": "status", "oldValue": "queued", "newValue": "ready" }),
    )
    .unwrap();

    let rows = notes_get_property_definitions_inner(&conn).unwrap();
    let status = rows.into_iter().find(|r| r.name == "status").unwrap();
    let opts: Value = serde_json::from_str(status.options.as_deref().unwrap()).unwrap();
    assert_eq!(opts["categories"]["todo"]["options"][0]["value"], "ready");
}

#[test]
fn update_option_color_updates_value() {
    let conn = open_in_memory_with_migrations();
    notes_create_property_definition_inner(&conn, create_input("status", "select")).unwrap();
    notes_add_property_option_inner(
        &conn,
        &json!({ "propertyName": "status", "option": { "value": "active", "color": "#10b981" }}),
    )
    .unwrap();

    notes_update_option_color_inner(
        &conn,
        &json!({ "propertyName": "status", "optionValue": "active", "newColor": "#3b82f6" }),
    )
    .unwrap();

    let rows = notes_get_property_definitions_inner(&conn).unwrap();
    let status = rows.into_iter().find(|r| r.name == "status").unwrap();
    let opts = options_array(status.options.as_deref());
    assert_eq!(opts[0]["color"], "#3b82f6");
}

#[test]
fn delete_property_definition_removes_row() {
    let conn = open_in_memory_with_migrations();
    notes_create_property_definition_inner(&conn, create_input("status", "select")).unwrap();

    notes_delete_property_definition_inner(&conn, &json!({ "name": "status" })).unwrap();

    assert!(notes_get_property_definitions_inner(&conn).unwrap().is_empty());
}

#[test]
fn option_mutations_validate_property_name_field() {
    let conn = open_in_memory_with_migrations();

    let err = notes_add_property_option_inner(
        &conn,
        &json!({ "option": { "value": "x", "color": "#000" } }),
    )
    .expect_err("missing propertyName must error");
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
}
