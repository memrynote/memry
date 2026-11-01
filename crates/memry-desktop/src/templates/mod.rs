//! Note templates (`vault/templates.ts`, `ipc/templates-handlers.ts`): the 8 built-ins, which
//! live in code and never sync, and the vault's own, which are core `template` records
//! (`memry_core::domain::template_store`).
//!
//! What this module adds to the core is Electron's shape of a template and its rules at the
//! door: a name of 1 to 200 UTF-16 units, property objects of `TemplatePropertySchema`, task
//! block suffixes stripped from every body written and read (`stripTaskBlockSuffixes`), and the
//! built-ins' fixed timestamp. A duplicate is a create from the source as read, as Electron's.
//!
//! A delete also removes the template's pre-sync file, `.memry/templates/<id>.md`, once the
//! tombstone is committed: left behind, the file would be imported again by a vault whose
//! import flag is gone. Only a regular file reached through no link is removed.
//!
//! Every function blocks (SQLite, files); an async caller runs it on a blocking thread.

pub mod legacy;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::{AuthError, StorageError};
use memry_core::domain::template_admin::{TemplateEdit, is_built_in};
use memry_core::domain::template_store::{Template, TemplateFields, TemplateStore};
use memry_core::markdown::shared::task_block::strip_task_block_suffixes;
use memry_core::seams::secure_store::SecureStore;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::session::OpenVault;
use crate::shell::file_open::{Resolution, is_plain_segment, resolve_under_root};
use crate::vault::layout::MEMRY_DIR;

/// `BUILT_IN_TIMESTAMP`: built-ins never look modified.
pub const BUILT_IN_TIMESTAMP: &str = "2025-01-01T00:00:00.000Z";
/// `TemplateCreateSchema.name.max(200)`, counted in UTF-16 units as zod counts it.
pub const NAME_MAX_UNITS: usize = 200;
/// The pre-sync template files, `<id>.md` inside [`MEMRY_DIR`].
pub const LEGACY_DIR: &str = "templates";

/// `TemplatePropertyType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum TemplatePropertyType {
    Text,
    Number,
    Checkbox,
    Date,
    Select,
    Multiselect,
    Url,
    Rating,
    Project,
}

/// `TemplatePropertySchema`, as a write takes it.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct TemplateProperty {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: TemplatePropertyType,
    pub value: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = Vec<String>)]
    pub options: Option<Vec<String>>,
}

/// `value` is `z.unknown()`, so an editor may send none: it saves as `null`. Read by hand so the
/// TypeScript type keeps `value` required, as the contracts' `TemplateProperty` does; a
/// `#[serde(default)]` would make specta export it optional.
impl<'de> Deserialize<'de> for TemplateProperty {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Wire {
            name: String,
            #[serde(rename = "type")]
            kind: TemplatePropertyType,
            #[serde(default)]
            value: Value,
            #[serde(default)]
            options: Option<Vec<String>>,
        }
        let Wire {
            name,
            kind,
            value,
            options,
        } = Wire::deserialize(d)?;
        Ok(Self {
            name,
            kind,
            value,
            options,
        })
    }
}

/// One template (`Template`). `properties` are the stored objects as they are: a peer may hold
/// a type this build does not know.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TemplateView {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub description: Option<String>,
    pub icon: Option<String>,
    pub is_built_in: bool,
    pub tags: Vec<String>,
    /// Typed for the renderer as Electron's `rowToTemplate` types them; held as stored.
    #[specta(type = Vec<TemplateProperty>)]
    pub properties: Vec<Value>,
    pub content: String,
    pub created_at: String,
    pub modified_at: String,
}

/// One row of the list (`TemplateListItem`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TemplateListItem {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub description: Option<String>,
    pub icon: Option<String>,
    pub is_built_in: bool,
}

/// `TemplateCreateInput`.
#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TemplateCreateInput {
    pub name: String,
    #[serde(default)]
    #[specta(optional)]
    pub description: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub icon: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub tags: Vec<String>,
    #[serde(default)]
    #[specta(optional)]
    pub properties: Vec<TemplateProperty>,
    #[serde(default)]
    #[specta(optional)]
    pub content: String,
}

/// `TemplateUpdateInput`: an absent field stays; `icon: null` clears the icon.
#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TemplateUpdateInput {
    pub id: String,
    #[serde(default)]
    #[specta(optional)]
    pub name: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub icon: Option<Option<String>>,
    #[serde(default)]
    #[specta(optional)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    #[specta(optional)]
    pub properties: Option<Vec<TemplateProperty>>,
    #[serde(default)]
    #[specta(optional)]
    pub content: Option<String>,
}

/// A field that is present, `null` included; `#[serde(default)]` makes an absent one `None`.
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

fn invalid(what: impl Into<String>) -> StorageError {
    StorageError::Invalid { what: what.into() }
}

fn not_found(id: &str) -> StorageError {
    StorageError::NotFound {
        what: format!("template {id}"),
    }
}

/// `z.string().min(1).max(200)`.
fn check_name(name: &str) -> Result<(), StorageError> {
    let units = name.encode_utf16().count();
    if units == 0 || units > NAME_MAX_UNITS {
        return Err(invalid(format!(
            "a template name is 1 to {NAME_MAX_UNITS} characters"
        )));
    }
    Ok(())
}

/// `TemplatePropertySchema.name.min(1)`; the rest of the schema is the type's.
fn property_values(properties: &[TemplateProperty]) -> Result<Vec<Value>, StorageError> {
    properties
        .iter()
        .map(|property| {
            if property.name.is_empty() {
                return Err(invalid("a template property needs a name"));
            }
            serde_json::to_value(property).map_err(|error| invalid(error.to_string()))
        })
        .collect()
}

fn view(template: Template) -> TemplateView {
    let stamp = |at: Option<String>| {
        if template.is_built_in {
            BUILT_IN_TIMESTAMP.to_owned()
        } else {
            at.unwrap_or_default()
        }
    };
    TemplateView {
        created_at: stamp(template.created_at),
        modified_at: stamp(template.modified_at),
        content: strip_task_block_suffixes(&template.content),
        id: template.id,
        name: template.name,
        description: template.description,
        icon: template.icon,
        is_built_in: template.is_built_in,
        tags: template.tags,
        properties: template.properties,
    }
}

/// `<vault>/.memry/templates/<id>.md`, vault-relative, or `None` for an id that is not a plain
/// file name (a peer's id can be anything).
pub fn legacy_rel(id: &str) -> Option<String> {
    let file = format!("{id}.md");
    is_plain_segment(id)
        .then_some(())
        .filter(|()| is_plain_segment(&file))
        .map(|()| format!("{MEMRY_DIR}/{LEGACY_DIR}/{file}"))
}

/// Removes the pre-sync file of `id` when it is a regular file reached through no link: a link
/// anywhere on the path makes the real location differ from the path itself.
fn remove_legacy_file(vault: &Path, id: &str) {
    let Some(rel) = legacy_rel(id) else { return };
    let path = vault.join(&rel);
    if !std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file()) {
        return;
    }
    let removed = match resolve_under_root(vault, &rel) {
        Ok(Resolution::Inside(real)) if real == path => std::fs::remove_file(&path),
        Ok(_) => return,
        Err(error) => Err(error),
    };
    if let Err(error) = removed {
        tracing::warn!(
            scope = "Templates",
            id,
            "a deleted template's legacy file could not be removed: {error}"
        );
    }
}

/// The templates of one open vault.
pub struct Templates {
    vault: PathBuf,
    store: TemplateStore,
}

impl Templates {
    pub fn new(vault: PathBuf, store: TemplateStore) -> Self {
        Self { vault, store }
    }

    /// The templates of `open`, written under the device identity in `store` (minted on the
    /// first synced write of a profile; sign-in reuses it).
    pub fn open(open: &OpenVault, store: Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        ensure_device_identity(store.clone())?;
        Ok(Self::new(open.path.clone(), open.vault.templates(store)?))
    }

    /// Built-ins by name, then the vault's own by name (`listTemplates`).
    pub fn list(&self) -> Result<Vec<TemplateListItem>, StorageError> {
        Ok(self
            .store
            .list()?
            .into_iter()
            .map(|t| TemplateListItem {
                is_built_in: is_built_in(&t.id),
                id: t.id,
                name: t.name,
                description: t.description,
                icon: t.icon,
            })
            .collect())
    }

    /// A built-in or a live template of the vault; `None` otherwise.
    pub fn get(&self, id: &str) -> Result<Option<TemplateView>, StorageError> {
        Ok(self.store.get(id)?.map(view))
    }

    fn written(&self, id: &str) -> Result<TemplateView, StorageError> {
        self.get(id)?.ok_or_else(|| not_found(id))
    }

    pub fn create(
        &self,
        input: &TemplateCreateInput,
        now_ms: i64,
    ) -> Result<TemplateView, StorageError> {
        check_name(&input.name)?;
        let fields = TemplateFields {
            name: input.name.clone(),
            description: input.description.clone(),
            icon: input.icon.clone(),
            tags: input.tags.clone(),
            properties: property_values(&input.properties)?,
            content: strip_task_block_suffixes(&input.content),
        };
        let id = self.store.create(&fields, now_ms)?;
        self.written(&id)
    }

    pub fn update(
        &self,
        input: &TemplateUpdateInput,
        now_ms: i64,
    ) -> Result<TemplateView, StorageError> {
        if let Some(name) = &input.name {
            check_name(name)?;
        }
        let edit = TemplateEdit {
            name: input.name.clone(),
            description: input.description.clone().map(Some),
            icon: input.icon.clone(),
            tags: input.tags.clone(),
            properties: input
                .properties
                .as_deref()
                .map(property_values)
                .transpose()?,
            content: input.content.as_deref().map(strip_task_block_suffixes),
        };
        self.store.update(&input.id, &edit, now_ms)?;
        self.written(&input.id)
    }

    /// A new template named `name` from a built-in or a live one (`duplicateTemplate`).
    pub fn duplicate(
        &self,
        id: &str,
        name: &str,
        now_ms: i64,
    ) -> Result<TemplateView, StorageError> {
        check_name(name)?;
        let source = self.get(id)?.ok_or_else(|| not_found(id))?;
        let fields = TemplateFields {
            name: name.to_owned(),
            description: source.description,
            icon: source.icon,
            tags: source.tags,
            properties: source.properties,
            content: source.content,
        };
        let copy = self.store.create(&fields, now_ms)?;
        self.written(&copy)
    }

    /// Tombstones a template of the vault, then removes its pre-sync file.
    pub fn delete(&self, id: &str, now_ms: i64) -> Result<(), StorageError> {
        self.store.delete(id, now_ms)?;
        remove_legacy_file(&self.vault, id);
        Ok(())
    }
}
