//! Property-definition commands. Thin wrappers over `db::property_definitions`.
//!
//! Definition CRUD is typed (`CreatePropertyDefinitionInput`); update/ensure
//! payloads stay permissive `JsonUnknown` to match the loose renderer
//! contract. Inner helpers take `&Connection` so tests exercise behaviour
//! without the Tauri runtime.

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
    let new_type = require_str(input, "type")?;
    db::update_type(conn, name, new_type)?;
    db::get(conn, name)?.ok_or_else(|| AppError::NotFound(format!("property {name}")))
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
) -> AppResult<db::PropertyDefinitionRow> {
    let conn = state.db.conn()?;
    notes_create_property_definition_inner(&conn, input)
}

#[tauri::command]
#[specta::specta]
pub fn notes_update_property_definition(
    state: State<'_, AppState>,
    input: JsonUnknown,
) -> AppResult<db::PropertyDefinitionRow> {
    let conn = state.db.conn()?;
    notes_update_property_definition_inner(&conn, &input)
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

// ---- Internal helpers -----------------------------------------------------

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
