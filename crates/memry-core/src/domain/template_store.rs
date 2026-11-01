//! The templates of one vault for the Rust desktop shell (Step 13l), after desktop
//! `vault/templates.ts`: the list, one whole template, and the writes, each refused as desktop
//! refuses it. A built-in (`template_admin::BUILT_INS`) is read from code and never written; a
//! stored template whose id is a built-in's is never read, the built-in wins.
//!
//! **The stored payload is the template** (§13.2 rule 4), so [`get`] reads `sync_items` and not
//! the `templates` projection: a field the projection does not keep still reaches the editor.

use std::sync::Arc;

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::{AuthError, StorageError};
use crate::api::tasks::Tasks;
use crate::seams::secure_store::SecureStore;
use crate::storage::Db;
use crate::storage::repositories::sync_items;

use super::reads::{self, TemplateSummary};
use super::tasks::model::new_task_id;
use super::template_admin::{self, BUILT_INS, BuiltIn, TemplateEdit, is_built_in};
use super::templates::{self, ITEM_TYPE, NewTemplate};

/// One whole template (`Template` of `templates-api.ts`).
#[derive(Debug, Clone, PartialEq)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub is_built_in: bool,
    pub tags: Vec<String>,
    /// The `TemplatePropertySchema` objects as stored.
    pub properties: Vec<Value>,
    pub content: String,
    /// ISO-8601, as the payload holds it; `None` for a built-in.
    pub created_at: Option<String>,
    pub modified_at: Option<String>,
}

/// What a new template holds.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TemplateFields {
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub tags: Vec<String>,
    pub properties: Vec<Value>,
    pub content: String,
}

fn from_built_in(b: &BuiltIn) -> Template {
    Template {
        id: b.id.to_owned(),
        name: b.name.to_owned(),
        description: Some(b.description.to_owned()),
        icon: Some(b.icon.to_owned()),
        is_built_in: true,
        tags: b.tags.iter().map(|t| (*t).to_owned()).collect(),
        properties: serde_json::from_str(b.properties).unwrap_or_default(),
        content: b.content.to_owned(),
        created_at: None,
        modified_at: None,
    }
}

/// Desktop's `rowToTemplate`: `tags` and `properties` that are not arrays read as empty, as a
/// peer can push any JSON there, and a tag that is not a string is left out.
fn from_payload(id: &str, payload: &Value) -> Template {
    let text = |key: &str| payload.get(key).and_then(Value::as_str).map(str::to_owned);
    let array = |key: &str| payload.get(key).and_then(Value::as_array).cloned();
    Template {
        id: id.to_owned(),
        name: text("name").unwrap_or_default(),
        description: text("description"),
        icon: text("icon"),
        is_built_in: false,
        tags: array("tags")
            .unwrap_or_default()
            .into_iter()
            .filter_map(|tag| tag.as_str().map(str::to_owned))
            .collect(),
        properties: array("properties").unwrap_or_default(),
        content: text("content").unwrap_or_default(),
        created_at: text("createdAt"),
        modified_at: text("modifiedAt"),
    }
}

/// The template `id`: a built-in, or a live stored one whose payload has arrived. `None`
/// otherwise, a deleted or a metadata-only one included.
pub fn get(conn: &Connection, id: &str) -> Result<Option<Template>, StorageError> {
    if let Some(b) = BUILT_INS.iter().find(|b| b.id == id) {
        return Ok(Some(from_built_in(b)));
    }
    let Some(row) = sync_items::load(conn, ITEM_TYPE, id)? else {
        return Ok(None);
    };
    if row.deleted_at.is_some() || row.corrupt_at.is_some() {
        return Ok(None);
    }
    let payload = row
        .payload
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    Ok(payload.map(|payload| from_payload(id, &payload)))
}

fn not_found(id: &str) -> StorageError {
    StorageError::NotFound {
        what: format!("template {id}"),
    }
}

/// A stored template the user can change: refused for a built-in, not found when not live.
fn require_custom(conn: &Connection, id: &str) -> Result<(), StorageError> {
    if is_built_in(id) {
        return Err(StorageError::Invalid {
            what: format!("built-in template `{id}` cannot be changed"),
        });
    }
    match get(conn, id)? {
        Some(_) => Ok(()),
        None => Err(not_found(id)),
    }
}

/// Creates a template from `fields`; returns its id.
pub fn create(
    conn: &Connection,
    fields: &TemplateFields,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let name = fields.name.trim();
    if name.is_empty() {
        return Err(StorageError::Invalid {
            what: "a template needs a name".into(),
        });
    }
    let id = new_task_id();
    templates::create(
        conn,
        &NewTemplate {
            id: &id,
            name,
            description: fields.description.as_deref(),
            icon: fields.icon.as_deref(),
            tags: &fields.tags,
            properties: &fields.properties,
            content: &fields.content,
        },
        device_id,
        now_ms,
    )?
    .acknowledge();
    Ok(id)
}

/// Saves `edit` over a live stored template.
pub fn update(
    conn: &Connection,
    id: &str,
    edit: &TemplateEdit,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    require_custom(conn, id)?;
    template_admin::update(conn, id, edit, device_id, now_ms)
}

/// Tombstones a live stored template.
pub fn delete(
    conn: &Connection,
    id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    require_custom(conn, id)?;
    template_admin::delete(conn, id, device_id, now_ms)
}

/// The functions above over one vault's database, writing under this device's identity. Built
/// by `Vault::templates`; each call blocks.
pub struct TemplateStore {
    db: Db,
    device_id: String,
}

impl TemplateStore {
    pub(crate) fn over(db: Db, store: &Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        let tasks = Tasks::over(db, store)?;
        Ok(Self {
            db: tasks.db,
            device_id: tasks.device_id,
        })
    }

    /// Built-ins by name, then the vault's own by name.
    pub fn list(&self) -> Result<Vec<TemplateSummary>, StorageError> {
        self.db.read_blocking(reads::templates)
    }

    pub fn get(&self, id: &str) -> Result<Option<Template>, StorageError> {
        self.db.read_blocking(|conn| get(conn, id))
    }

    pub fn create(&self, fields: &TemplateFields, now_ms: i64) -> Result<String, StorageError> {
        self.db
            .call_blocking(|conn| create(conn, fields, &self.device_id, now_ms))
    }

    pub fn update(&self, id: &str, edit: &TemplateEdit, now_ms: i64) -> Result<(), StorageError> {
        self.db
            .call_blocking(|conn| update(conn, id, edit, &self.device_id, now_ms))
    }

    pub fn delete(&self, id: &str, now_ms: i64) -> Result<(), StorageError> {
        self.db
            .call_blocking(|conn| delete(conn, id, &self.device_id, now_ms))
    }
}
