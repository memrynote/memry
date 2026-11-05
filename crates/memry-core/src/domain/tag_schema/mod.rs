//! Tag schemas (§13.7.7.1) as desktop resolves and edits them: the `schema` key of a
//! `tag_definition` payload, read into one [`ResolvedTag`] per tag that has one ([`resolve`])
//! and changed by one [`SchemaEdit`] at a time ([`edit::apply`]).
//!
//! Twin of `resolveTagSchemas` and `applySchemaEdit` in `packages/app-core/src/tag-schema.ts`.
//! A field carries no type: the vault-wide property definition owns it, so the resolver takes
//! the definitions as a lookup ([`PropertyInfo`]). A schema this build cannot read (a newer
//! build wrote it) resolves read-only with no fields, and is never rewritten.
//!
//! [`crate::domain::tag_fields`] is the narrower read iOS draws a note's fields from.

pub mod edit;
mod resolve;

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::domain::tag_admin;
use crate::domain::tag_fields::readable;
use crate::sync::first_sync_store::{read_meta, write_meta};

pub use edit::{NewField, SchemaEdit, SchemaEditError, Stamped};
pub use resolve::{descendants_of, primary_object_tag, resolve};

/// The preset keys this build knows (`PRESET_KEYS`). A stored preset outside them round-trips
/// and resolves as none.
pub const PRESET_KEYS: [&str; 4] = ["person", "company", "meeting", "book"];

/// A stored `schema` value (`parseSchemaColumn`).
#[derive(Debug, Clone, PartialEq)]
pub enum StoredSchema {
    /// It parses as `TagSchemaWire`.
    Readable(Map<String, Value>),
    /// A newer build's shape: shown, never edited.
    Unreadable,
}

impl StoredSchema {
    /// `None` for an absent or `null` schema; a value that is not a readable object is
    /// [`StoredSchema::Unreadable`].
    pub fn parse(value: Option<&Value>) -> Option<Self> {
        match value? {
            Value::Null => None,
            Value::Object(map) if readable(map) => Some(Self::Readable(map.clone())),
            _ => Some(Self::Unreadable),
        }
    }

    pub fn readable(&self) -> Option<&Map<String, Value>> {
        match self {
            Self::Readable(map) => Some(map),
            Self::Unreadable => None,
        }
    }
}

/// One tag definition as the resolver reads it (`TagDefinitionInput`).
#[derive(Debug, Clone, PartialEq)]
pub struct DefinitionInput {
    /// The stored spelling.
    pub name: String,
    pub color: String,
    pub icon: Option<String>,
    pub schema: Option<StoredSchema>,
}

/// What a property definition gives the field of the same name (`PropertyTypeLookup`).
#[derive(Debug, Clone, PartialEq)]
pub struct PropertyInfo {
    pub type_name: String,
    /// A select's or multiselect's option list, as stored.
    pub options: Option<Value>,
    pub show_on_calendar: Option<bool>,
}

/// A relation field's config (`RelationConfig`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relation {
    /// The tag key the picker is restricted to; `None` = any note.
    pub target: Option<String>,
    pub many: bool,
    /// The inverse list's label on the target; `None` = the source tag's name.
    pub inverse: Option<String>,
}

impl Relation {
    pub fn to_value(&self) -> Value {
        let text = |s: &Option<String>| s.clone().map_or(Value::Null, Value::String);
        serde_json::json!({
            "target": text(&self.target),
            "many": self.many,
            "inverse": text(&self.inverse),
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedField {
    pub name: String,
    /// A property type other than `project`, or `relation`.
    pub type_name: String,
    pub options: Option<Value>,
    pub show_on_calendar: Option<bool>,
    pub relation: Option<Relation>,
    /// The tag key whose schema lists it.
    pub defined_by: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InheritedFields {
    pub from: String,
    pub fields: Vec<ResolvedField>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedTemplate {
    pub id: String,
    pub autofill: bool,
    /// The ancestor whose schema names it; `None` for the tag's own.
    pub inherited_from: Option<String>,
}

/// One resolved tag (`ResolvedTag` of `@memry/contracts/tag-schema`).
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedTag {
    pub name: String,
    pub key: String,
    pub color: String,
    pub icon: Option<String>,
    pub editable: bool,
    pub own_fields: Vec<ResolvedField>,
    /// Nearest ancestor first; a name listed closer is dropped.
    pub inherited: Vec<InheritedFields>,
    /// Farthest ancestor first, own fields last.
    pub effective_fields: Vec<ResolvedField>,
    pub has_fields: bool,
    /// The parent as stored, as a key; may name a missing tag.
    pub extends: Option<String>,
    /// Nearest first, cut at the first repeat or missing definition.
    pub ancestors: Vec<String>,
    pub template: Option<ResolvedTemplate>,
    pub preset: Option<String>,
    pub own_preset: Option<String>,
}

/// Every live definition by tag key, with its stored schema (`loadTagDefinitions`).
pub fn definitions(conn: &Connection) -> Result<BTreeMap<String, DefinitionInput>, StorageError> {
    let mut out = BTreeMap::new();
    for (key, definition) in tag_admin::definitions(conn)? {
        let payload = tag_admin::live_definition(conn, &definition.id)?;
        let schema = StoredSchema::parse(payload.as_ref().and_then(|p| p.get("schema")));
        out.insert(
            key,
            DefinitionInput {
                name: definition.id,
                color: definition.color,
                icon: definition.icon,
                schema,
            },
        );
    }
    Ok(out)
}

/// The resolved tags of the open vault, typed by `types`.
pub fn resolved(
    conn: &Connection,
    types: &dyn Fn(&str) -> Option<PropertyInfo>,
) -> Result<BTreeMap<String, ResolvedTag>, StorageError> {
    Ok(resolve(&definitions(conn)?, types))
}

/// The local `data.db` setting that hides the tag hub's ready-made tags
/// (`PRESET_OFFER_DISMISSED_SETTING`). Device-local: kept in `meta`, never synced.
const OFFER_DISMISSED: &str = "tagFields.presetOfferDismissed";

/// Whether this device dismissed the ready-made tags (`presetStripDismissed`).
pub fn preset_offer_dismissed(conn: &Connection) -> Result<bool, StorageError> {
    Ok(read_meta(conn, OFFER_DISMISSED)?.as_deref() == Some("1"))
}

/// `dismissPresetOffer`.
pub fn dismiss_preset_offer(conn: &Connection) -> Result<(), StorageError> {
    write_meta(conn, OFFER_DISMISSED, "1")
}

/// Why [`save`] wrote nothing.
#[derive(Debug, thiserror::Error)]
pub enum SaveError {
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error("the tag schema edit was refused: {0:?}")]
    Edit(SchemaEditError),
}

/// Applies `edit` to `tag`'s schema and writes it through the definition writer, which ticks
/// its clock and queues it for sync (`saveSchemaEdit`). A tag with no definition gets one under
/// its key, as desktop's `getOrCreateTag(key)` makes it. Nothing is written when the edit
/// changes nothing.
pub fn save(
    conn: &Connection,
    tag: &str,
    edit: &SchemaEdit,
    device_id: &str,
    now_ms: i64,
) -> Result<Stamped, SaveError> {
    let key = crate::domain::tags::tag_key(tag);
    let defs = definitions(conn)?;
    let current = match defs.get(&key).and_then(|def| def.schema.as_ref()) {
        Some(StoredSchema::Unreadable) => {
            return Err(SaveError::Edit(SchemaEditError::UnreadableSchema));
        }
        Some(StoredSchema::Readable(schema)) => Some(schema),
        None => None,
    };
    let stamped =
        edit::apply(current, edit, &key, &resolve(&defs, &|_| None)).map_err(SaveError::Edit)?;
    if stamped.changed {
        tag_admin::upsert_definition(
            conn,
            &key,
            None,
            vec![(
                "schema",
                crate::storage::repositories::Change::Set(Value::Object(stamped.next.clone())),
            )],
            device_id,
            now_ms,
        )?;
    }
    Ok(stamped)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

#[cfg(test)]
#[path = "save_tests.rs"]
mod save_tests;
