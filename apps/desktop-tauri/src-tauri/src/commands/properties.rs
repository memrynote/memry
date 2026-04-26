//! Property-definition commands. Thin wrappers over `db::property_definitions`.
//!
//! Definition CRUD is typed (`CreatePropertyDefinitionInput`); update/ensure
//! and option-mutation payloads stay permissive `JsonUnknown` to match the
//! loose renderer contract (`{ propertyName, option, optionValue, oldValue,
//! newValue, newColor, ... }`). Inner helpers take `&Connection` so tests
//! exercise behaviour without the Tauri runtime.

use crate::app_state::AppState;
use crate::commands::notes::{now_iso, JsonUnknown};
use crate::db::property_definitions as db;
use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ops::Deref;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatePropertyDefinitionInput {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub options: Option<JsonUnknown>,
    pub default_value: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertySimpleSuccess {
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatePropertyDefinitionResponse {
    pub success: bool,
    pub definition: Option<db::PropertyDefinitionRow>,
    pub error: Option<String>,
}

// ---- Inner helpers (called from tests, runtime, and Tauri wrappers) -------

pub fn notes_get_property_definitions_inner(
    conn: &Connection,
) -> AppResult<Vec<db::PropertyDefinitionRow>> {
    db::list(conn)
}

pub fn notes_create_property_definition_inner(
    conn: &Connection,
    input: CreatePropertyDefinitionInput,
) -> AppResult<db::PropertyDefinitionRow> {
    let row = db::PropertyDefinitionRow {
        name: input.name.clone(),
        ty: input.ty,
        options: input.options.map(|value| value.deref().to_string()),
        default_value: input.default_value,
        color: input.color,
        created_at: now_iso(),
    };
    db::create(conn, &row)?;
    db::get(conn, &input.name)?
        .ok_or_else(|| AppError::Internal("just-inserted property definition missing".into()))
}

pub fn notes_update_property_definition_inner(
    conn: &Connection,
    input: &Value,
) -> AppResult<db::PropertyDefinitionRow> {
    let name = require_str(input, "name")?;
    let mut row =
        db::get(conn, name)?.ok_or_else(|| AppError::NotFound(format!("property {name}")))?;

    if let Some(new_type) = input.get("type").and_then(Value::as_str) {
        row.ty = new_type.to_string();
    }
    if let Some(options) = input.get("options") {
        row.options = json_field_to_db_string(options)?;
    }
    if let Some(default_value) = input.get("defaultValue") {
        row.default_value = json_field_to_db_string(default_value)?;
    }
    if let Some(color) = input.get("color") {
        row.color = json_field_to_db_string(color)?;
    }

    db::update(conn, &row)?;
    db::get(conn, name)?.ok_or_else(|| AppError::NotFound(format!("property {name}")))
}

pub fn notes_create_property_definition_response_inner(
    conn: &Connection,
    input: CreatePropertyDefinitionInput,
) -> AppResult<CreatePropertyDefinitionResponse> {
    let definition = notes_create_property_definition_inner(conn, input)?;
    Ok(property_definition_response(definition))
}

pub fn notes_update_property_definition_response_inner(
    conn: &Connection,
    input: &Value,
) -> AppResult<CreatePropertyDefinitionResponse> {
    let definition = notes_update_property_definition_inner(conn, input)?;
    Ok(property_definition_response(definition))
}

pub fn notes_ensure_property_definition_inner(
    conn: &Connection,
    input: &Value,
) -> AppResult<db::PropertyDefinitionRow> {
    let name = require_str(input, "name")?;
    let ty = input.get("type").and_then(Value::as_str).unwrap_or("text");
    let default_value = input.get("defaultValue").and_then(Value::as_str);
    db::ensure(conn, name, ty, default_value)?;
    db::get(conn, name)?.ok_or_else(|| AppError::NotFound(format!("property {name}")))
}

pub fn notes_add_property_option_inner(conn: &Connection, input: &Value) -> AppResult<()> {
    let property_name = require_str(input, "propertyName")?;
    let option = require_object(input, "option")?;
    let value = require_field_str(option, "option.value")?;
    let color = option.get("color").and_then(Value::as_str);
    db::add_option(conn, property_name, value, color)
}

pub fn notes_add_status_option_inner(conn: &Connection, input: &Value) -> AppResult<()> {
    let property_name = require_str(input, "propertyName")?;
    let category = require_str(input, "categoryKey")?;
    let option = require_object(input, "option")?;
    let value = require_field_str(option, "option.value")?;
    let color = option.get("color").and_then(Value::as_str);
    db::add_status_option(conn, property_name, category, value, color)
}

pub fn notes_remove_property_option_inner(conn: &Connection, input: &Value) -> AppResult<()> {
    let property_name = require_str(input, "propertyName")?;
    let option_value = require_str(input, "optionValue")?;
    db::remove_option(conn, property_name, option_value)
}

pub fn notes_rename_property_option_inner(conn: &Connection, input: &Value) -> AppResult<()> {
    let property_name = require_str(input, "propertyName")?;
    let old_value = require_str(input, "oldValue")?;
    let new_value = require_str(input, "newValue")?;
    db::rename_option(conn, property_name, old_value, new_value)
}

pub fn notes_update_option_color_inner(conn: &Connection, input: &Value) -> AppResult<()> {
    let property_name = require_str(input, "propertyName")?;
    let option_value = require_str(input, "optionValue")?;
    let new_color = require_str(input, "newColor")?;
    db::update_option_color(conn, property_name, option_value, new_color)
}

pub fn notes_delete_property_definition_inner(conn: &Connection, input: &Value) -> AppResult<()> {
    let name = require_str(input, "name")?;
    db::delete(conn, name)
}

// ---- Tauri commands -------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub fn notes_get_property_definitions(
    state: State<'_, AppState>,
) -> AppResult<Vec<db::PropertyDefinitionRow>> {
    let conn = state.db.conn()?;
    notes_get_property_definitions_inner(&conn)
}

#[tauri::command]
#[specta::specta]
pub fn notes_create_property_definition(
    state: State<'_, AppState>,
    input: CreatePropertyDefinitionInput,
) -> AppResult<CreatePropertyDefinitionResponse> {
    let conn = state.db.conn()?;
    notes_create_property_definition_response_inner(&conn, input)
}

#[tauri::command]
#[specta::specta]
pub fn notes_update_property_definition(
    state: State<'_, AppState>,
    input: JsonUnknown,
) -> AppResult<CreatePropertyDefinitionResponse> {
    let conn = state.db.conn()?;
    notes_update_property_definition_response_inner(&conn, &input)
}

#[tauri::command]
#[specta::specta]
pub fn notes_ensure_property_definition(
    state: State<'_, AppState>,
    input: JsonUnknown,
) -> AppResult<db::PropertyDefinitionRow> {
    let conn = state.db.conn()?;
    notes_ensure_property_definition_inner(&conn, &input)
}

#[tauri::command]
#[specta::specta]
pub fn notes_add_property_option(
    state: State<'_, AppState>,
    input: JsonUnknown,
) -> AppResult<PropertySimpleSuccess> {
    let conn = state.db.conn()?;
    notes_add_property_option_inner(&conn, &input)?;
    Ok(PropertySimpleSuccess { success: true })
}

#[tauri::command]
#[specta::specta]
pub fn notes_add_status_option(
    state: State<'_, AppState>,
    input: JsonUnknown,
) -> AppResult<PropertySimpleSuccess> {
    let conn = state.db.conn()?;
    notes_add_status_option_inner(&conn, &input)?;
    Ok(PropertySimpleSuccess { success: true })
}

#[tauri::command]
#[specta::specta]
pub fn notes_remove_property_option(
    state: State<'_, AppState>,
    input: JsonUnknown,
) -> AppResult<PropertySimpleSuccess> {
    let conn = state.db.conn()?;
    notes_remove_property_option_inner(&conn, &input)?;
    Ok(PropertySimpleSuccess { success: true })
}

#[tauri::command]
#[specta::specta]
pub fn notes_rename_property_option(
    state: State<'_, AppState>,
    input: JsonUnknown,
) -> AppResult<PropertySimpleSuccess> {
    let conn = state.db.conn()?;
    notes_rename_property_option_inner(&conn, &input)?;
    Ok(PropertySimpleSuccess { success: true })
}

#[tauri::command]
#[specta::specta]
pub fn notes_update_option_color(
    state: State<'_, AppState>,
    input: JsonUnknown,
) -> AppResult<PropertySimpleSuccess> {
    let conn = state.db.conn()?;
    notes_update_option_color_inner(&conn, &input)?;
    Ok(PropertySimpleSuccess { success: true })
}

#[tauri::command]
#[specta::specta]
pub fn notes_delete_property_definition(
    state: State<'_, AppState>,
    input: JsonUnknown,
) -> AppResult<PropertySimpleSuccess> {
    let conn = state.db.conn()?;
    notes_delete_property_definition_inner(&conn, &input)?;
    Ok(PropertySimpleSuccess { success: true })
}

// ---- Internal helpers -----------------------------------------------------

fn property_definition_response(
    definition: db::PropertyDefinitionRow,
) -> CreatePropertyDefinitionResponse {
    CreatePropertyDefinitionResponse {
        success: true,
        definition: Some(definition),
        error: None,
    }
}

fn json_field_to_db_string(value: &Value) -> AppResult<Option<String>> {
    if value.is_null() {
        return Ok(None);
    }
    if let Some(text) = value.as_str() {
        return Ok(Some(text.to_string()));
    }
    Ok(Some(serde_json::to_string(value)?))
}

fn require_str<'a>(value: &'a Value, field: &str) -> AppResult<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Validation(format!("{field} must be a non-empty string")))
        .and_then(|s| {
            if s.is_empty() {
                Err(AppError::Validation(format!("{field} must not be empty")))
            } else {
                Ok(s)
            }
        })
}

fn require_object<'a>(value: &'a Value, field: &str) -> AppResult<&'a Value> {
    let inner = value
        .get(field)
        .ok_or_else(|| AppError::Validation(format!("{field} is required")))?;
    if !inner.is_object() {
        return Err(AppError::Validation(format!("{field} must be an object")));
    }
    Ok(inner)
}

fn require_field_str<'a>(value: &'a Value, field: &str) -> AppResult<&'a str> {
    let leaf = field.rsplit_once('.').map(|(_, leaf)| leaf).unwrap_or(field);
    value
        .get(leaf)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Validation(format!("{field} must be a non-empty string")))
        .and_then(|s| {
            if s.is_empty() {
                Err(AppError::Validation(format!("{field} must not be empty")))
            } else {
                Ok(s)
            }
        })
}
