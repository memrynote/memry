//! property_definitions persistence helpers.

use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDefinition {
    pub name: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub options: Option<String>,
    pub default_value: Option<String>,
    pub color: Option<String>,
    pub created_at: String,
}

impl PropertyDefinition {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            name: row.get("name")?,
            r#type: row.get("type")?,
            options: row.get("options")?,
            default_value: row.get("default_value")?,
            color: row.get("color")?,
            created_at: row.get("created_at")?,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDefinitionRow {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub options: Option<String>,
    pub default_value: Option<String>,
    pub color: Option<String>,
    pub created_at: String,
}

const SELECT_COLS: &str = "name, type, options, default_value, color, created_at";

pub fn list(conn: &Connection) -> AppResult<Vec<PropertyDefinitionRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM property_definitions ORDER BY name"
    ))?;
    let rows = stmt.query_map([], map_row)?;
    collect_rows(rows)
}

pub fn get(conn: &Connection, name: &str) -> AppResult<Option<PropertyDefinitionRow>> {
    optional_row(conn.query_row(
        &format!("SELECT {SELECT_COLS} FROM property_definitions WHERE name = ?1"),
        [name],
        map_row,
    ))
}

pub fn create(conn: &Connection, def: &PropertyDefinitionRow) -> AppResult<()> {
    conn.execute(
        "INSERT INTO property_definitions (name, type, options, default_value, color, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            def.name.as_str(),
            def.ty.as_str(),
            def.options.as_deref(),
            def.default_value.as_deref(),
            def.color.as_deref(),
            def.created_at.as_str(),
        ],
    )?;
    Ok(())
}

pub fn update(conn: &Connection, def: &PropertyDefinitionRow) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE property_definitions
            SET type = ?1,
                options = ?2,
                default_value = ?3,
                color = ?4
          WHERE name = ?5",
        params![
            def.ty.as_str(),
            def.options.as_deref(),
            def.default_value.as_deref(),
            def.color.as_deref(),
            def.name.as_str(),
        ],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("property {}", def.name)));
    }
    Ok(())
}

pub fn update_type(conn: &Connection, name: &str, new_type: &str) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE property_definitions SET type = ?1 WHERE name = ?2",
        params![new_type, name],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("property {name}")));
    }
    Ok(())
}

pub fn ensure(
    conn: &Connection,
    name: &str,
    ty: &str,
    default_value: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO property_definitions (name, type, default_value)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(name) DO NOTHING",
        params![name, ty, default_value],
    )?;
    Ok(())
}

pub fn add_option(
    conn: &Connection,
    name: &str,
    option_name: &str,
    color: Option<&str>,
) -> AppResult<()> {
    let mut options = read_options_array(conn, name)?;
    if options
        .iter()
        .any(|option| option.get("name").and_then(Value::as_str) == Some(option_name))
    {
        return Ok(());
    }

    options.push(json!({
        "name": option_name,
        "color": color,
    }));
    write_options_array(conn, name, &options)
}

pub fn remove_option(conn: &Connection, name: &str, option_name: &str) -> AppResult<()> {
    let mut options = read_options_array(conn, name)?;
    options.retain(|option| option.get("name").and_then(Value::as_str) != Some(option_name));
    write_options_array(conn, name, &options)
}

pub fn rename_option(conn: &Connection, name: &str, old: &str, new: &str) -> AppResult<()> {
    let mut options = read_options_array(conn, name)?;
    for option in &mut options {
        if option.get("name").and_then(Value::as_str) == Some(old) {
            option["name"] = json!(new);
        }
    }
    write_options_array(conn, name, &options)
}

pub fn update_option_color(
    conn: &Connection,
    name: &str,
    option_name: &str,
    color: &str,
) -> AppResult<()> {
    let mut options = read_options_array(conn, name)?;
    for option in &mut options {
        if option.get("name").and_then(Value::as_str) == Some(option_name) {
            option["color"] = json!(color);
        }
    }
    write_options_array(conn, name, &options)
}

pub fn add_status_option(
    conn: &Connection,
    name: &str,
    category: &str,
    option_name: &str,
    color: Option<&str>,
) -> AppResult<()> {
    let mut options = read_options_array(conn, name)?;
    if options.iter().any(|option| {
        option.get("name").and_then(Value::as_str) == Some(option_name)
            && option.get("category").and_then(Value::as_str) == Some(category)
    }) {
        return Ok(());
    }

    options.push(json!({
        "name": option_name,
        "color": color,
        "category": category,
    }));
    write_options_array(conn, name, &options)
}

pub fn delete(conn: &Connection, name: &str) -> AppResult<()> {
    conn.execute("DELETE FROM property_definitions WHERE name = ?1", [name])?;
    Ok(())
}

fn read_options_array(conn: &Connection, name: &str) -> AppResult<Vec<Value>> {
    let row = get(conn, name)?.ok_or_else(|| AppError::NotFound(format!("property {name}")))?;
    let Some(options) = row.options else {
        return Ok(Vec::new());
    };

    match serde_json::from_str::<Value>(&options)? {
        Value::Array(items) => Ok(items),
        _ => Err(AppError::Validation(format!(
            "property {name} options must be a JSON array"
        ))),
    }
}

fn write_options_array(conn: &Connection, name: &str, options: &[Value]) -> AppResult<()> {
    let options = serde_json::to_string(options)?;
    let changed = conn.execute(
        "UPDATE property_definitions SET options = ?1 WHERE name = ?2",
        params![options, name],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("property {name}")));
    }
    Ok(())
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PropertyDefinitionRow> {
    Ok(PropertyDefinitionRow {
        name: row.get(0)?,
        ty: row.get(1)?,
        options: row.get(2)?,
        default_value: row.get(3)?,
        color: row.get(4)?,
        created_at: row.get(5)?,
    })
}

fn optional_row<T>(result: rusqlite::Result<T>) -> AppResult<Option<T>> {
    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn collect_rows<T>(rows: impl Iterator<Item = rusqlite::Result<T>>) -> AppResult<Vec<T>> {
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}
