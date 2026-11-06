//! Tags with fields (`ipc/tag-schema-handlers.ts`, `tags/schema/*`, `tags/presets.ts`): the
//! snapshot the renderer draws every tag's fields, objects and ready-made tags from, and the
//! schema commands.
//!
//! The rules live in the core: how a schema resolves and how an edit changes it
//! ([`memry_core::domain::tag_schema`]). A field carries no type, so the snapshot types each one
//! by the vault's property definitions ([`PropertyDefinitions`], `properties.md` and the
//! records). A schema edit writes the `tag_definition` record only, never a note file; a new
//! field's definition and a preset's template are written through their own owners first.
//! `rename-field`, which rewrites note files, is 13j-3d's. The object search and Linked here
//! read the same resolved tags ([`objects`]).

mod catalog;
mod edit;
pub mod objects;
mod presets;
pub mod view;

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use memry_core::api::errors::{AuthError, StorageError};
use memry_core::api::tag_hub::TagHub;
use memry_core::api::tag_schemas::TagSchemas;
use memry_core::domain::tag_schema::{self, PropertyInfo, ResolvedTag};
use memry_core::seams::secure_store::SecureStore;

use crate::error::{CoreError, FailureKind};
use crate::i18n::{self, Args};
use crate::notes::property_definitions::{
    DefinitionType, DefinitionsError, PropertyDefinitionView, PropertyDefinitions,
};
use crate::session::OpenVault;
use crate::templates::Templates;
pub use edit::{Effects, Ran};
use view::{ResolvedTagView, TagSchemaSnapshotView};

#[derive(Debug, thiserror::Error)]
pub enum SchemaError {
    /// A refused edit, in the UI language (`errors:tagFields.*`).
    #[error("{message}")]
    Refused { code: &'static str, message: String },
    #[error(transparent)]
    Definitions(#[from] DefinitionsError),
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Auth(#[from] AuthError),
}

impl CoreError for SchemaError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::Refused { code, .. } => (FailureKind::Invalid, code),
            Self::Definitions(error) => error.kind_and_code(),
            Self::Storage(error) => error.kind_and_code(),
            Self::Auth(error) => error.kind_and_code(),
        }
    }
}

/// The schemas of one open vault, written under this device's identity.
pub struct Schemas {
    open: OpenVault,
    schemas: TagSchemas,
    hub: TagHub,
    definitions: PropertyDefinitions,
    templates: Templates,
    locale: String,
}

impl Schemas {
    pub fn open(
        open: &OpenVault,
        store: Arc<dyn SecureStore>,
        locale: &str,
    ) -> Result<Self, SchemaError> {
        Ok(Self {
            schemas: open.vault.tag_schemas(store.clone())?,
            hub: open.vault.tag_hub(store.clone())?,
            definitions: PropertyDefinitions::open(open, store.clone())?,
            templates: Templates::open(open, store)?,
            open: open.clone(),
            locale: locale.to_owned(),
        })
    }

    fn t(&self, key: &str) -> String {
        i18n::t(&self.locale, key, &Args::new())
    }

    /// Each of `definitions`' type, options and calendar flag, by name.
    fn types(&self, definitions: Vec<PropertyDefinitionView>) -> HashMap<String, PropertyInfo> {
        let calendar = self.definitions.calendar_names();
        definitions
            .into_iter()
            .map(|definition| {
                let type_name = definition.type_name;
                let options = match type_name {
                    DefinitionType::Select | DefinitionType::Multiselect => definition
                        .options
                        .as_deref()
                        .and_then(|text| serde_json::from_str(text).ok()),
                    _ => None,
                };
                let info = PropertyInfo {
                    type_name: type_label(type_name).to_owned(),
                    options,
                    show_on_calendar: (type_name == DefinitionType::Date)
                        .then(|| calendar.contains(&definition.name)),
                };
                (definition.name, info)
            })
            .collect()
    }

    /// The resolved tags, typed by the vault's property definitions (`loadResolvedTags`), a
    /// pulled definition settled into the file first.
    fn resolved(&self) -> Result<BTreeMap<String, ResolvedTag>, SchemaError> {
        self.resolved_by(self.definitions.list()?)
    }

    /// [`Self::resolved`] typed by `definitions`.
    fn resolved_by(
        &self,
        definitions: Vec<PropertyDefinitionView>,
    ) -> Result<BTreeMap<String, ResolvedTag>, SchemaError> {
        let types = self.types(definitions);
        let definitions = self.open.vault.tag_schema_definitions()?;
        Ok(tag_schema::resolve(&definitions, &|name| {
            types.get(name).cloned()
        }))
    }

    /// `tags:get-schema-snapshot`.
    pub fn snapshot(&self) -> Result<TagSchemaSnapshotView, SchemaError> {
        let resolved = self.resolved()?;
        let headers = self.open.search.object_headers()?;
        let objects = headers
            .iter()
            .filter_map(|(id, tags)| {
                Some((id.clone(), tag_schema::primary_object_tag(tags, &resolved)?))
            })
            .collect();
        Ok(TagSchemaSnapshotView {
            presets: self.offers(&resolved, &headers)?,
            tags: resolved
                .iter()
                .map(|(key, tag)| (key.clone(), ResolvedTagView::from(tag)))
                .collect(),
            objects,
            preset_strip_dismissed: self.open.vault.tag_preset_offer_dismissed()?,
        })
    }
}

fn type_label(type_name: DefinitionType) -> &'static str {
    match type_name {
        DefinitionType::Text => "text",
        DefinitionType::Number => "number",
        DefinitionType::Checkbox => "checkbox",
        DefinitionType::Date => "date",
        DefinitionType::Url => "url",
        DefinitionType::Status => "status",
        DefinitionType::Select => "select",
        DefinitionType::Multiselect => "multiselect",
        DefinitionType::Project => "project",
    }
}
