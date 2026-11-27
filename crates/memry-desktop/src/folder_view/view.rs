//! The folder view commands' inputs and answers as the renderer sees them
//! (`@memry/contracts/folder-view-api`). Instants travel as ISO strings, as Electron's
//! `note_cache` text columns did; a view stays the JSON the renderer wrote.

use memry_core::domain::folder_view::{ItemKind, PropertyCount, Row, RowSet};
use memry_core::storage::repositories::instants::to_iso8601;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `ViewScope`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ViewScope {
    Folder {
        path: String,
    },
    Tag {
        tag: String,
        #[serde(default, rename = "andTags")]
        #[specta(optional)]
        and_tags: Option<Vec<String>>,
    },
}

/// `ListWithPropertiesRequestSchema.rows`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum RowSetInput {
    Objects,
    Mentions,
}

impl From<RowSetInput> for RowSet {
    fn from(set: RowSetInput) -> Self {
        match set {
            RowSetInput::Objects => Self::Objects,
            RowSetInput::Mentions => Self::Mentions,
        }
    }
}

/// `ListWithPropertiesRequestSchema`: 500 rows from the first when a field is absent.
/// `properties` is accepted and unused, as in Electron: every property is listed.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ListInput {
    pub scope: ViewScope,
    #[serde(default)]
    #[specta(optional)]
    pub properties: Option<Vec<String>>,
    #[serde(default)]
    #[specta(optional)]
    pub limit: Option<u32>,
    #[serde(default)]
    #[specta(optional)]
    pub offset: Option<u32>,
    #[serde(default)]
    #[specta(optional)]
    pub rows: Option<RowSetInput>,
}

/// `NoteWithProperties.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum RowKindView {
    Note,
    Task,
    Inbox,
}

/// `NoteWithProperties`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RowView {
    pub id: String,
    pub path: String,
    pub title: String,
    pub emoji: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub cover: Option<String>,
    pub folder: String,
    pub tags: Vec<String>,
    pub created: String,
    pub modified: String,
    pub word_count: u32,
    pub properties: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub kind: Option<RowKindView>,
    pub file_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub via_tag: Option<String>,
}

impl From<Row> for RowView {
    fn from(row: Row) -> Self {
        // An instant the record lacks reads as the other, as the note reads do.
        let created = row.created_at.or(row.modified_at);
        let modified = row.modified_at.or(created);
        let iso = |ms: Option<i64>| ms.and_then(to_iso8601).unwrap_or_default();
        Self {
            id: row.id,
            path: row.path,
            title: row.title,
            emoji: row.emoji,
            cover: row.cover,
            folder: row.folder,
            tags: row.tags,
            created: iso(created),
            modified: iso(modified),
            word_count: row.word_count,
            properties: row.properties,
            kind: row.kind.map(|kind| match kind {
                ItemKind::Note => RowKindView::Note,
                ItemKind::Task => RowKindView::Task,
                ItemKind::Inbox => RowKindView::Inbox,
            }),
            file_type: row.file_type,
            via_tag: row.via_tag,
        }
    }
}

/// `ListWithPropertiesResponse`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ListView {
    pub notes: Vec<RowView>,
    pub total: u32,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub complete: Option<bool>,
}

/// A built-in column (`GetAvailablePropertiesResponse.builtIn`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BuiltInColumnView {
    pub id: String,
    pub display_name: String,
    #[serde(rename = "type")]
    pub type_name: String,
}

/// `AvailableProperty`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AvailablePropertyView {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub usage_count: u32,
}

impl From<PropertyCount> for AvailablePropertyView {
    fn from(count: PropertyCount) -> Self {
        Self {
            name: count.name,
            type_name: count.type_name,
            usage_count: count.usage_count,
        }
    }
}

/// A folder's formula.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FormulaView {
    pub id: String,
    pub expression: String,
}

/// `GetAvailablePropertiesResponse`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AvailablePropertiesView {
    pub built_in: Vec<BuiltInColumnView>,
    pub properties: Vec<AvailablePropertyView>,
    pub formulas: Vec<FormulaView>,
}

/// A scope's saved views. With none saved, `views` is `None` and the renderer shows its
/// `DEFAULT_VIEW`, given `fieldColumns` (the fields of a tag with fields) as its middle
/// columns: the default view stays one constant of `@memry/contracts`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedViewsView {
    pub views: Option<Vec<Value>>,
    pub default_index: u32,
    pub field_columns: Option<Vec<String>>,
}
