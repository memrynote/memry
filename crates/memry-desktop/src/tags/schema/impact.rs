//! `tags:preview-impact` (`tags/schema/impact.ts`): what a schema change would reach, counted
//! before its dialog asks. It writes no record and no outbox row; reading the property
//! definitions first takes pulled definitions into `properties.md`, as the snapshot's read
//! does (`PropertyDefinitions::list`).
//!
//! A tag's objects are the markdown notes, not journal days, whose file header carries the tag
//! in any spelling (`headerObjectNoteIds`); a tag's members are the tag and the tags that extend
//! it. A note holds a field when the note index read a value of that exact name from its file
//! (`note_properties`, `notesWithProperty`); a task when its `fields` map holds a value for it.

use std::collections::HashSet;

use memry_core::domain::task_records::TaskFieldHolder;
use memry_core::domain::tag_schema::{ResolvedTag, descendants_of};
use memry_core::domain::tags::tag_key;
use serde::{Deserialize, Serialize};

use super::edit::{field_name, tag_name};
use super::{SchemaError, Schemas};

/// `ImpactQuery`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ImpactQuery {
    RemoveField { tag: String, name: String },
    RenameField { name: String },
    DeleteTag { tag: String },
    SetExtends { tag: String, parent: Option<String> },
    BecomeObjects { tag: String },
}

/// `ImpactResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ImpactView {
    RemoveField {
        filled: u32,
        empty: u32,
    },
    RenameField {
        notes: u32,
        tasks: u32,
        tags: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    DeleteTag {
        notes: u32,
        tasks: u32,
        values: u32,
        fields: u32,
        template_name: Option<String>,
    },
    SetExtends {
        notes: u32,
        gained: Vec<String>,
        lost: Vec<String>,
    },
    BecomeObjects {
        notes: u32,
    },
}

impl Schemas {
    /// `previewTagImpact`.
    pub fn preview_impact(&self, query: ImpactQuery) -> Result<ImpactView, SchemaError> {
        let resolved = self.resolved()?;
        let members = |tag: &str| {
            let mut keys = vec![tag_key(tag)];
            keys.extend(descendants_of(tag, &resolved));
            keys
        };
        Ok(match query {
            ImpactQuery::RemoveField { tag, name } => {
                let (tag, name) = (tag_name(&tag)?, field_name(&name)?);
                let tags = members(&tag);
                let notes = self.objects_of(&tags)?;
                let filled_notes = self.holders(&name)?.intersection(&notes).count();
                let tasks: Vec<TaskFieldHolder> = self
                    .task_holders()?
                    .into_iter()
                    .filter(|task| carries(task, &tags))
                    .collect();
                let filled_tasks = tasks.iter().filter(|task| holds(task, &name)).count();
                let filled = filled_notes + filled_tasks;
                ImpactView::RemoveField {
                    filled: count(filled),
                    empty: count((notes.len() + tasks.len()).saturating_sub(filled)),
                }
            }
            ImpactQuery::RenameField { name } => {
                let name = field_name(&name)?;
                let tasks = self.task_holders()?;
                ImpactView::RenameField {
                    notes: count(self.holders(&name)?.len()),
                    tasks: count(tasks.iter().filter(|task| holds(task, &name)).count()),
                    tags: resolved
                        .values()
                        .filter(|tag| tag.own_fields.iter().any(|f| f.name == name))
                        .map(|tag| tag.key.clone())
                        .collect(),
                }
            }
            ImpactQuery::DeleteTag { tag } => {
                let key = tag_key(&tag_name(&tag)?);
                let this = resolved.get(&key);
                let tags = [key.clone()];
                let notes = self.objects_of(&tags)?;
                let mut values = 0;
                for name in names(this).into_iter().collect::<HashSet<_>>() {
                    values += self.holders(&name)?.intersection(&notes).count();
                }
                let own_template = this
                    .and_then(|tag| tag.template.as_ref())
                    .filter(|template| template.inherited_from.is_none());
                let template_name = match own_template {
                    Some(template) => self.templates.get(&template.id)?.map(|t| t.name),
                    None => None,
                };
                let tasks = self.task_holders()?;
                ImpactView::DeleteTag {
                    notes: count(notes.len()),
                    tasks: count(tasks.iter().filter(|task| carries(task, &tags)).count()),
                    values: count(values),
                    fields: count(this.map_or(0, |tag| tag.own_fields.len())),
                    template_name,
                }
            }
            ImpactQuery::SetExtends { tag, parent } => {
                let tag = tag_name(&tag)?;
                let parent = parent.as_deref().map(tag_name).transpose()?;
                let this = resolved.get(&tag_key(&tag));
                let own: HashSet<String> = this
                    .map(|t| t.own_fields.iter().map(|f| f.name.to_lowercase()).collect())
                    .unwrap_or_default();
                let inherited = |tag: Option<&ResolvedTag>| -> Vec<String> {
                    names(tag)
                        .into_iter()
                        .filter(|name| !own.contains(&name.to_lowercase()))
                        .collect()
                };
                let before = inherited(this);
                let after = inherited(parent.and_then(|p| resolved.get(&tag_key(&p))));
                ImpactView::SetExtends {
                    notes: count(self.objects_of(&members(&tag))?.len()),
                    gained: after
                        .iter()
                        .filter(|n| !before.contains(n))
                        .cloned()
                        .collect(),
                    lost: before
                        .iter()
                        .filter(|n| !after.contains(n))
                        .cloned()
                        .collect(),
                }
            }
            ImpactQuery::BecomeObjects { tag } => {
                let tag = tag_name(&tag)?;
                ImpactView::BecomeObjects {
                    notes: count(self.objects_of(&members(&tag))?.len()),
                }
            }
        })
    }

    /// The notes whose header carries one of `tags` (keys), markdown and not journal days.
    fn objects_of(&self, tags: &[String]) -> Result<HashSet<String>, SchemaError> {
        Ok(self
            .open
            .search
            .object_headers()?
            .into_iter()
            .filter(|(_, header)| header.iter().any(|tag| tags.contains(&tag_key(tag))))
            .map(|(id, _)| id)
            .collect())
    }

    /// Every live task's tags and filled fields; a task whose payload does not read is in no
    /// count, and named in a warning.
    fn task_holders(&self) -> Result<Vec<TaskFieldHolder>, SchemaError> {
        let read = self.tasks.field_holders()?;
        if !read.unreadable.is_empty() {
            tracing::warn!(
                scope = "TagSchema",
                tasks = ?read.unreadable,
                "tasks whose payload does not read are left out of a tag schema change's counts"
            );
        }
        Ok(read.holders)
    }

    /// The notes the index read a value named `name` from.
    fn holders(&self, name: &str) -> Result<HashSet<String>, SchemaError> {
        let holders = self
            .open
            .search
            .notes_holding_properties(vec![name.to_owned()])?;
        Ok(holders.into_iter().collect())
    }
}

/// The tag's fields, its ancestors' first.
fn names(tag: Option<&ResolvedTag>) -> Vec<String> {
    tag.map(|tag| {
        tag.effective_fields
            .iter()
            .map(|f| f.name.clone())
            .collect()
    })
    .unwrap_or_default()
}

fn carries(task: &TaskFieldHolder, tags: &[String]) -> bool {
    task.tags.iter().any(|tag| tags.contains(&tag_key(tag)))
}

fn holds(task: &TaskFieldHolder, name: &str) -> bool {
    task.fields.iter().any(|field| field == name)
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}
