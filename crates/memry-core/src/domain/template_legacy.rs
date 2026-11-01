//! Templates of the pre-sync builds, `<vault>/.memry/templates/<id>.md`, brought into the
//! database once per vault (Step 13l), after desktop `vault/templates-migration.ts`.
//!
//! - [`parse`] is `parseTemplate`: gray-matter's frontmatter and body, the file name standing
//!   in for a missing id, the trimmed body. A value Electron's insert would refuse (a boolean,
//!   a list or a map where text goes) makes the file one that never imports, as there.
//! - [`import`] is the insert: the id is kept, so a vault copied between devices converges
//!   instead of doubling, and an id the database has ever held, live or deleted, is left alone
//!   (Electron's `onConflictDoNothing`, which a tombstone also answers here).
//! - [`IMPORTED_META_KEY`] is the one-shot flag (`templates.importedFromFiles`), a `meta` row
//!   of this device's database: it never syncs.
//!
//! Two departures from Electron, both keeping a template it would drop: an unquoted date
//! (`createdAt: 2025-01-01T00:00:00Z`, a YAML timestamp) imports as its ISO text, where
//! Electron's driver refuses to bind a `Date`; and the tags are text, case variants collapsed
//! as on every other template write, where Electron stores the YAML list as it is.

use rusqlite::{Connection, OptionalExtension as _, params};
use serde_json::{Map, Number, Value, json};

use crate::api::errors::StorageError;
use crate::markdown::frontmatter::js::{js_trim, number_to_string};
use crate::markdown::frontmatter::{YamlValue, gray_matter_data, gray_matter_parts};
use crate::storage::repositories::sync_items;
use crate::sync::outbox;

use super::notes::identity::{ELECTRON_IMPORT_META_KEY, mints_beside_electron};
use super::notes::{insert_local, iso, next_clock, object};
use super::tags;
use super::template_admin::is_built_in;
use super::templates::ITEM_TYPE;

/// The `meta` key set once every template file of the vault landed.
pub const IMPORTED_META_KEY: &str = "templates.importedFromFiles";

/// A template file's template.
#[derive(Debug, Clone, PartialEq)]
pub struct LegacyTemplate {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub tags: Vec<String>,
    pub properties: Vec<Value>,
    pub content: String,
    pub created_at: String,
    pub modified_at: String,
}

/// What a template file holds.
#[derive(Debug, Clone, PartialEq)]
pub enum Parsed {
    Template(LegacyTemplate),
    /// A built-in, which the code holds: never imported.
    BuiltIn,
    /// A file no build will import: frontmatter that does not parse, or a value Electron's
    /// insert refuses. The reason names which.
    Refused(String),
}

/// A number as the text column holds it: Electron binds it as a REAL, which SQLite's text
/// affinity writes `2024.0`. Exact for whole numbers under 10^15; any other is written as
/// JavaScript prints it, where SQLite may give more digits.
fn real_text(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e15 {
        #[allow(clippy::cast_possible_truncation)]
        return format!("{}.0", x as i64);
    }
    number_to_string(x)
}

/// A frontmatter value where the row holds text: `None` for `null`. A number reads as SQLite
/// stores Electron's ([`real_text`]) and a date as its ISO text; anything else is refused.
fn text(value: &YamlValue) -> Result<Option<String>, ()> {
    match value {
        YamlValue::Null => Ok(None),
        YamlValue::String(text) => Ok(Some(text.clone())),
        YamlValue::Number(x) => Ok(Some(real_text(*x))),
        YamlValue::Date(ms) => iso(*ms).map(Some).map_err(drop),
        _ => Err(()),
    }
}

/// `JSON.stringify` of a frontmatter value: a date as its ISO text, a number that is not
/// finite and a buffer as `null`.
fn to_json(value: &YamlValue) -> Value {
    match value {
        YamlValue::Null | YamlValue::Binary(_) => Value::Null,
        YamlValue::Bool(b) => Value::Bool(*b),
        YamlValue::Number(x) if x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_992.0 =>
        {
            #[allow(clippy::cast_possible_truncation)]
            Value::Number(Number::from(*x as i64))
        }
        YamlValue::Number(x) => Number::from_f64(*x).map_or(Value::Null, Value::Number),
        YamlValue::String(text) => Value::String(text.clone()),
        YamlValue::Date(ms) => iso(*ms).map_or(Value::Null, Value::String),
        YamlValue::Seq(items) => Value::Array(items.iter().map(to_json).collect()),
        YamlValue::Map(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.to_owned(), to_json(value)))
                .collect::<Map<_, _>>(),
        ),
    }
}

/// `parseTemplate` of the file `<stem>.md` holding `file`; `now` stands in for a missing date.
pub fn parse(stem: &str, file: &str, now: &str) -> Parsed {
    let data = match gray_matter_data(file) {
        Ok(data) => data,
        Err(error) => return Parsed::Refused(format!("frontmatter: {error}")),
    };
    let none = YamlValue::Null;
    let field = |key: &str| match &data {
        YamlValue::Map(map) => map.get(key).unwrap_or(&none),
        _ => &none,
    };
    let refused = |key: &str| Parsed::Refused(format!("`{key}` is not text"));
    macro_rules! text_of {
        ($key:literal) => {
            match text(field($key)) {
                Ok(value) => value,
                Err(()) => return refused($key),
            }
        };
    }
    let id = text_of!("id").unwrap_or_else(|| stem.to_owned());
    if id.is_empty() {
        return Parsed::Refused("the id is empty".into());
    }
    if matches!(field("isBuiltIn"), YamlValue::Bool(true)) || is_built_in(&id) {
        return Parsed::BuiltIn;
    }
    let name = text_of!("name").unwrap_or_else(|| id.clone());
    let description = text_of!("description");
    let icon = text_of!("icon");
    let created_at = text_of!("createdAt").unwrap_or_else(|| now.to_owned());
    let modified_at = text_of!("modifiedAt").unwrap_or_else(|| now.to_owned());
    let tags = match field("tags") {
        // Electron keeps the list as JSON; here a tag is text, so a number or a boolean is
        // written as JavaScript prints it and anything else is dropped.
        YamlValue::Seq(items) => tags::dedupe(items.iter().filter_map(|tag| match tag {
            YamlValue::Bool(b) => Some(b.to_string()),
            YamlValue::Number(x) => Some(number_to_string(*x)),
            other => text(other).ok().flatten(),
        })),
        _ => Vec::new(),
    };
    let properties = match field("properties") {
        YamlValue::Seq(items) => items.iter().map(to_json).collect(),
        _ => Vec::new(),
    };
    let body = match gray_matter_parts(file) {
        Some((_, body)) => body,
        None => file.strip_prefix('\u{FEFF}').unwrap_or(file),
    };
    Parsed::Template(LegacyTemplate {
        id,
        name,
        description,
        icon,
        tags,
        properties,
        content: js_trim(body).to_owned(),
        created_at,
        modified_at,
    })
}

/// Inserts `template` under its own id and queues its push, in one transaction. `false`, and
/// nothing written, when the database has ever held that id (live or deleted).
pub fn import(
    conn: &Connection,
    template: &LegacyTemplate,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    let failed = |e: rusqlite::Error| StorageError::Failed {
        what: e.to_string(),
    };
    let tx = conn.unchecked_transaction().map_err(failed)?;
    if sync_items::load(&tx, ITEM_TYPE, &template.id)?.is_some() {
        return Ok(false);
    }
    let payload = object(json!({
        "name": template.name,
        "description": template.description,
        "icon": template.icon,
        "tags": template.tags,
        "properties": template.properties,
        "content": template.content,
        "clock": next_clock(&Default::default(), device_id)?,
        "createdAt": template.created_at,
        "modifiedAt": template.modified_at,
    }));
    insert_local(&tx, ITEM_TYPE, &template.id, payload, now_ms)?;
    outbox::enqueue(
        &tx,
        &outbox::Change::upsert(ITEM_TYPE, &template.id),
        now_ms,
    )?;
    tx.commit().map_err(failed)?;
    Ok(true)
}

/// Whether every template file of this vault already landed.
pub fn imported(conn: &Connection) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT 1 FROM meta WHERE key = ?1",
        params![IMPORTED_META_KEY],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|e| StorageError::Failed {
        what: e.to_string(),
    })
}

/// Records that every template file landed; once set, it stays.
pub fn mark_imported(conn: &Connection) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, '1') ON CONFLICT(key) DO NOTHING",
        params![IMPORTED_META_KEY],
    )
    .map(drop)
    .map_err(|e| StorageError::Failed {
        what: e.to_string(),
    })
}

/// Where this database stands beside Electron's (`<vault>/.memry/data.db`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BesideElectron {
    /// The Electron import (Step 36) brought Electron's rows, its templates among them.
    pub imported: bool,
    /// A new id may be minted beside it ([`mints_beside_electron`]).
    pub mints: bool,
}

pub fn beside_electron(conn: &Connection) -> Result<BesideElectron, StorageError> {
    let imported = conn
        .query_row(
            "SELECT 1 FROM meta WHERE key = ?1",
            params![ELECTRON_IMPORT_META_KEY],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| StorageError::Failed {
            what: e.to_string(),
        })?
        .is_some();
    Ok(BesideElectron {
        imported,
        mints: mints_beside_electron(conn)?,
    })
}
