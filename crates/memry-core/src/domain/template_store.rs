//! The templates of one vault for the Rust desktop shell (Step 13l), after desktop
//! `vault/templates.ts`: the list, one whole template, and the writes, each refused as desktop
//! refuses it. A built-in (`template_admin::BUILT_INS`) is read from code and never written; a
//! stored template whose id is a built-in's is never read, the built-in wins.
//!
//! **The stored payload is the template** (§13.2 rule 4), so [`get`] reads `sync_items` and not
//! the `templates` projection: a field the projection does not keep still reaches the editor.
//!
//! **A name is unique on local writes only.** [`create`] and a rename through [`update`] refuse
//! a name whose [`name_key`] (NFC, whitespace collapsed, case folded) a built-in or another
//! listed template has ([`TemplateWriteError::NameTaken`]), as Electron's `assertNameFree`.
//! Templates that arrive by sync or by the legacy import never pass here, so duplicates already
//! in a vault stay as they are and still sync.

use std::sync::Arc;

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::{AuthError, StorageError};
use crate::api::tasks::Tasks;
use crate::seams::secure_store::SecureStore;
use crate::storage::Db;
use crate::storage::repositories::sync_items;

use super::notes::names::name_key;
use super::reads::{self, TemplateSummary};
use super::tasks::model::new_task_id;
use super::template_admin::{self, BUILT_INS, BuiltIn, TemplateEdit, is_built_in};
#[cfg(feature = "markdown")]
use super::template_legacy;
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

/// A local template write refused by a rule of this module, or failed in storage.
#[derive(Debug, thiserror::Error)]
pub enum TemplateWriteError {
    /// A built-in or another listed template already has the name key of `name`.
    #[error("a template named `{name}` already exists")]
    NameTaken { name: String },
    #[error(transparent)]
    Storage(#[from] StorageError),
}

/// Whether a built-in or a listed template other than `except` has the [`name_key`] of `name`.
fn name_taken(conn: &Connection, name: &str, except: Option<&str>) -> Result<bool, StorageError> {
    let Some(key) = name_key(name) else {
        return Ok(false);
    };
    Ok(reads::templates(conn)?
        .iter()
        .any(|t| Some(t.id.as_str()) != except && name_key(&t.name).as_ref() == Some(&key)))
}

fn refuse_taken(
    conn: &Connection,
    name: &str,
    except: Option<&str>,
) -> Result<(), TemplateWriteError> {
    if name_taken(conn, name, except)? {
        return Err(TemplateWriteError::NameTaken {
            name: name.trim().to_owned(),
        });
    }
    Ok(())
}

/// `name` trimmed when no template has its name key, else the first free of `name 2`,
/// `name 3`, ... (`uniqueTemplateName`).
pub fn free_name(conn: &Connection, name: &str) -> Result<String, StorageError> {
    let name = name.trim();
    let mut candidate = name.to_owned();
    let mut n = 2;
    while name_taken(conn, &candidate, None)? {
        candidate = format!("{name} {n}");
        n += 1;
    }
    Ok(candidate)
}

fn not_found(id: &str) -> StorageError {
    StorageError::NotFound {
        what: format!("template {id}"),
    }
}

/// A stored template the user can change: refused for a built-in, not found when not live.
fn require_custom(conn: &Connection, id: &str) -> Result<Template, StorageError> {
    if is_built_in(id) {
        return Err(StorageError::Invalid {
            what: format!("built-in template `{id}` cannot be changed"),
        });
    }
    get(conn, id)?.ok_or_else(|| not_found(id))
}

/// Creates a template from `fields`; returns its id. A name another template has is refused.
pub fn create(
    conn: &Connection,
    fields: &TemplateFields,
    device_id: &str,
    now_ms: i64,
) -> Result<String, TemplateWriteError> {
    let name = fields.name.trim();
    if name.is_empty() {
        return Err(StorageError::Invalid {
            what: "a template needs a name".into(),
        }
        .into());
    }
    refuse_taken(conn, name, None)?;
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

/// Saves `edit` over a live stored template. Only a rename (another name key) is checked, so a
/// template that shares its name with a synced one can still be edited, its name sent back.
pub fn update(
    conn: &Connection,
    id: &str,
    edit: &TemplateEdit,
    device_id: &str,
    now_ms: i64,
) -> Result<(), TemplateWriteError> {
    let current = require_custom(conn, id)?;
    if let Some(name) = &edit.name
        && name_key(name) != name_key(&current.name)
    {
        refuse_taken(conn, name, Some(id))?;
    }
    Ok(template_admin::update(conn, id, edit, device_id, now_ms)?)
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

    /// The template a tag of `tags` names, and whether it fills an empty body
    /// ([`super::tag_fields::tag_template`]).
    pub fn tag_template(
        &self,
        tags: &[String],
    ) -> Result<Option<super::tag_fields::TagTemplate>, StorageError> {
        self.db
            .read_blocking(|conn| super::tag_fields::tag_template(conn, tags))
    }

    /// The id of the template a tag of `tags` names ([`super::tag_fields::template_of`]).
    pub fn of_tags(&self, tags: &[String]) -> Result<Option<String>, StorageError> {
        self.db
            .read_blocking(|conn| super::tag_fields::template_of(conn, tags))
    }

    pub fn create(
        &self,
        fields: &TemplateFields,
        now_ms: i64,
    ) -> Result<String, TemplateWriteError> {
        self.db
            .call_blocking(|conn| Ok(create(conn, fields, &self.device_id, now_ms)))?
    }

    /// [`create`] under [`free_name`] of `fields.name`, in one write.
    pub fn create_numbered(
        &self,
        fields: &TemplateFields,
        now_ms: i64,
    ) -> Result<String, TemplateWriteError> {
        self.db.call_blocking(|conn| {
            let numbered = TemplateFields {
                name: free_name(conn, &fields.name)?,
                ..fields.clone()
            };
            Ok(create(conn, &numbered, &self.device_id, now_ms))
        })?
    }

    pub fn update(
        &self,
        id: &str,
        edit: &TemplateEdit,
        now_ms: i64,
    ) -> Result<(), TemplateWriteError> {
        self.db
            .call_blocking(|conn| Ok(update(conn, id, edit, &self.device_id, now_ms)))?
    }

    pub fn delete(&self, id: &str, now_ms: i64) -> Result<(), StorageError> {
        self.db
            .call_blocking(|conn| delete(conn, id, &self.device_id, now_ms))
    }
}

/// The pre-sync template files' import ([`super::template_legacy`]).
#[cfg(feature = "markdown")]
impl TemplateStore {
    pub fn legacy_imported(&self) -> Result<bool, StorageError> {
        self.db.read_blocking(template_legacy::imported)
    }

    pub fn mark_legacy_imported(&self) -> Result<(), StorageError> {
        self.db
            .call_blocking(|conn| template_legacy::mark_imported(conn))
    }

    pub fn beside_electron(&self) -> Result<template_legacy::BesideElectron, StorageError> {
        self.db.read_blocking(template_legacy::beside_electron)
    }

    /// `false` when the database has ever held the template's id.
    pub fn import_legacy(
        &self,
        template: &template_legacy::LegacyTemplate,
        now_ms: i64,
    ) -> Result<bool, StorageError> {
        self.db
            .call_blocking(|conn| template_legacy::import(conn, template, &self.device_id, now_ms))
    }
}
