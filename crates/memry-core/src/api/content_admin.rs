//! Settings › Tags, Properties and Templates on the [`Tasks`] object (spec 006
//! ST16–ST18). On `Tasks` because every call needs the same database and
//! device identity, and a tag rename rewrites tasks as well as notes.

use crate::api::errors::StorageError;
use crate::api::tasks::Tasks;
use crate::api::tasks_write::now_ms;
use crate::domain::{property_admin, tag_admin, template_admin};

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TagItem {
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub notes: i64,
    pub journals: i64,
    pub tasks: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PropertyOptionItem {
    pub value: String,
    pub color: Option<String>,
    pub category: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PropertyDefinitionItem {
    pub name: String,
    pub type_name: String,
    pub options: Vec<PropertyOptionItem>,
    pub used_in: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TemplateItem {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub tags: Vec<String>,
    pub content: String,
    pub is_built_in: bool,
    pub modified_at: Option<String>,
}

/// The template editor's fields, all written. `icon` / `description` `nil`
/// clear.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TemplateDraft {
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub tags: Vec<String>,
    pub content: String,
}

#[uniffi::export]
impl Tasks {
    // ---- tags ---------------------------------------------------------------

    pub fn tag_list(&self) -> Result<Vec<TagItem>, StorageError> {
        self.db.call_blocking(|conn| {
            Ok(tag_admin::list(conn)?
                .into_iter()
                .map(|t| TagItem {
                    name: t.name,
                    color: t.color,
                    icon: t.icon,
                    notes: t.notes,
                    journals: t.journals,
                    tasks: t.tasks,
                })
                .collect())
        })
    }

    /// Returns the number of items rewritten.
    pub fn rename_tag(&self, old_name: String, new_name: String) -> Result<u32, StorageError> {
        let device = self.device_id.clone();
        self.db
            .call_blocking(move |c| tag_admin::rename(c, &old_name, &new_name, &device, now_ms()))
    }

    pub fn merge_tag(&self, source: String, target: String) -> Result<u32, StorageError> {
        let device = self.device_id.clone();
        self.db
            .call_blocking(move |c| tag_admin::merge(c, &source, &target, &device, now_ms()))
    }

    pub fn delete_tag(&self, tag: String) -> Result<u32, StorageError> {
        let device = self.device_id.clone();
        self.db
            .call_blocking(move |c| tag_admin::delete(c, &tag, &device, now_ms()))
    }

    pub fn set_tag_color(&self, tag: String, color: String) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db
            .call_blocking(move |c| tag_admin::set_color(c, &tag, &color, &device, now_ms()))
    }

    pub fn set_tag_icon(&self, tag: String, icon: Option<String>) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |c| {
            tag_admin::set_icon(c, &tag, icon.as_deref(), &device, now_ms())
        })
    }

    // ---- properties ---------------------------------------------------------

    pub fn property_definitions(&self) -> Result<Vec<PropertyDefinitionItem>, StorageError> {
        self.db.call_blocking(|conn| {
            Ok(property_admin::list(conn)?
                .into_iter()
                .map(|p| PropertyDefinitionItem {
                    name: p.name,
                    type_name: p.type_name,
                    used_in: p.used_in,
                    options: p
                        .options
                        .into_iter()
                        .map(|o| PropertyOptionItem {
                            value: o.value,
                            color: o.color,
                            category: o.category,
                        })
                        .collect(),
                })
                .collect())
        })
    }

    pub fn add_property_option(
        &self,
        name: String,
        value: String,
        color: String,
        category: Option<String>,
    ) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |c| {
            property_admin::add_option(
                c,
                &name,
                &value,
                &color,
                category.as_deref(),
                &device,
                now_ms(),
            )
        })
    }

    pub fn rename_property_option(
        &self,
        name: String,
        old_value: String,
        new_value: String,
    ) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |c| {
            property_admin::rename_option(c, &name, &old_value, &new_value, &device, now_ms())
        })
    }

    pub fn set_property_option_color(
        &self,
        name: String,
        value: String,
        color: String,
    ) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |c| {
            property_admin::set_option_color(c, &name, &value, &color, &device, now_ms())
        })
    }

    pub fn remove_property_option(&self, name: String, value: String) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |c| {
            property_admin::remove_option(c, &name, &value, &device, now_ms())
        })
    }

    pub fn reorder_property_options(
        &self,
        name: String,
        values: Vec<String>,
    ) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |c| {
            property_admin::reorder_options(c, &name, &values, &device, now_ms())
        })
    }

    pub fn delete_property_definition(&self, name: String) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db
            .call_blocking(move |c| property_admin::delete_definition(c, &name, &device, now_ms()))
    }

    // ---- templates ----------------------------------------------------------

    pub fn template_list(&self) -> Result<Vec<TemplateItem>, StorageError> {
        self.db.call_blocking(|conn| {
            Ok(template_admin::list(conn)?
                .into_iter()
                .map(|t| TemplateItem {
                    id: t.id,
                    name: t.name,
                    description: t.description,
                    icon: t.icon,
                    tags: t.tags,
                    content: t.content,
                    is_built_in: t.is_built_in,
                    modified_at: t.modified_at,
                })
                .collect())
        })
    }

    /// A new, empty template named `name`. Returns its id.
    pub fn create_template(&self, name: String) -> Result<String, StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |c| {
            let name = name.trim().to_owned();
            if name.is_empty() {
                return Err(StorageError::Invalid {
                    what: "a template needs a name".into(),
                });
            }
            let id = crate::domain::tasks::model::new_task_id();
            crate::domain::templates::create(
                c,
                &crate::domain::templates::NewTemplate {
                    id: &id,
                    name: &name,
                    description: None,
                    icon: None,
                    content: "",
                },
                &device,
                now_ms(),
            )?
            .acknowledge();
            Ok(id)
        })
    }

    /// Returns the new template's id.
    pub fn duplicate_template(&self, id: String, name: String) -> Result<String, StorageError> {
        let device = self.device_id.clone();
        self.db
            .call_blocking(move |c| template_admin::duplicate(c, &id, &name, &device, now_ms()))
    }

    pub fn update_template(&self, id: String, draft: TemplateDraft) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |c| {
            template_admin::update(
                c,
                &id,
                &template_admin::TemplateEdit {
                    name: Some(draft.name),
                    description: Some(draft.description),
                    icon: Some(draft.icon),
                    tags: Some(draft.tags),
                    content: Some(draft.content),
                },
                &device,
                now_ms(),
            )
        })
    }

    pub fn delete_template(&self, id: String) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db
            .call_blocking(move |c| template_admin::delete(c, &id, &device, now_ms()))
    }
}
