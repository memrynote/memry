//! Property-definition command coverage for M5 Phase G.
//!
//! Mirrors the inner-helper pattern from `commands_folders_test.rs` so we
//! exercise the DB slice without spinning up a Tauri AppHandle. Acceptance
//! gate per plan: ≥10 tests pass after Task 37 lands.

use memry_desktop_tauri_lib::commands::properties::{
    notes_create_property_definition_inner, notes_ensure_property_definition_inner,
    notes_get_property_definitions_inner, notes_update_property_definition_inner,
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

    let err = notes_update_property_definition_inner(
        &conn,
        &json!({ "name": "ghost", "type": "select" }),
    )
    .expect_err("missing definition must error");
    assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
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
