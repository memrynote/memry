//! Project, saved-filter and task-settings methods of [`Tasks`] (spec 004
//! TP028; D2 makes projects fully writable on the phone).

use serde_json::Value;

use crate::api::errors::StorageError;
use crate::api::task_records::{ProjectLinkItem, ProjectStats};
use crate::api::tasks::Tasks;
use crate::api::tasks_write::now_ms;
use crate::domain::projects::{
    self, LinkItemType, NewProject, ProjectEdit, StatusInput, StatusType, TaskDisposition,
};
use crate::domain::saved_filters::{self, NewSavedFilter};
use crate::domain::task_settings;

/// One status in a project editor.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct StatusDraft {
    /// `nil` for a new status.
    pub id: Option<String>,
    pub name: String,
    pub color: String,
    /// `todo`, `in_progress` or `done`.
    pub status_type: String,
    pub order: i64,
}

/// A project editor's contents: the **whole** form, as it stands when saved.
///
/// On update every text field is the form's value, so `nil` description or
/// icon is the user's clear (an explicit `null` on the wire). `color` is
/// never cleared (a project always has one): `nil` keeps the stored colour.
/// A field equal to the stored value is not written and keeps its clock, so
/// re-sending an untouched field never beats another device's edit to it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ProjectDraft {
    pub name: String,
    pub description: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    /// `nil` on create is desktop's three default statuses; on update it
    /// leaves the statuses alone.
    pub statuses: Option<Vec<StatusDraft>>,
}

/// One saved filter.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SavedFilterItem {
    pub id: String,
    pub name: String,
    /// The full `config` JSON (`{filters, sort?, starred?}`), verbatim.
    pub config_json: String,
    pub starred: bool,
    pub position: i64,
}

/// The task settings desktop has.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskSettingsItem {
    pub default_project_id: Option<String>,
    pub default_sort_order: String,
    pub default_view: String,
    pub stale_inbox_days: i64,
}

impl From<task_settings::TaskSettings> for TaskSettingsItem {
    fn from(settings: task_settings::TaskSettings) -> Self {
        Self {
            default_project_id: settings.default_project_id,
            default_sort_order: settings.default_sort_order,
            default_view: settings.default_view,
            stale_inbox_days: settings.stale_inbox_days,
        }
    }
}

fn invalid(what: String) -> StorageError {
    StorageError::Invalid { what }
}

fn status_inputs(drafts: &[StatusDraft]) -> Result<Vec<StatusInput<'_>>, StorageError> {
    drafts
        .iter()
        .map(|draft| {
            Ok(StatusInput {
                id: draft.id.as_deref(),
                name: &draft.name,
                color: &draft.color,
                status_type: StatusType::parse(&draft.status_type).ok_or_else(|| {
                    invalid(format!("`{}` is not a status type", draft.status_type))
                })?,
                order: draft.order,
            })
        })
        .collect()
}

fn link_type(item_type: &str) -> Result<LinkItemType, StorageError> {
    LinkItemType::parse(item_type).ok_or_else(|| invalid(format!("`{item_type}` cannot be linked")))
}

fn parse_config(config_json: &str) -> Result<Value, StorageError> {
    serde_json::from_str(config_json).map_err(|error| invalid(format!("filter config: {error}")))
}

impl From<saved_filters::SavedFilter> for SavedFilterItem {
    fn from(filter: saved_filters::SavedFilter) -> Self {
        Self {
            starred: filter.starred(),
            config_json: filter.config.to_string(),
            id: filter.id,
            name: filter.name,
            position: filter.position,
        }
    }
}

#[uniffi::export]
impl Tasks {
    /// Creates a project and returns its id.
    pub fn create_project(&self, draft: ProjectDraft) -> Result<String, StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let statuses = draft.statuses.as_deref().map(status_inputs).transpose()?;
            let project = NewProject {
                id: None,
                name: &draft.name,
                description: draft.description.as_deref(),
                color: draft.color.as_deref(),
                icon: draft.icon.as_deref(),
                statuses: statuses.as_deref(),
            };
            Ok(projects::create(conn, &project, &device, now_ms())?.acknowledge())
        })
    }

    /// Saves a project editor: name, description, color, icon and (when
    /// given) the status list, reconciled as desktop does.
    pub fn update_project(&self, id: String, draft: ProjectDraft) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let statuses = draft.statuses.as_deref().map(status_inputs).transpose()?;
            let edit = ProjectEdit {
                name: Some(&draft.name),
                description: Some(draft.description.as_deref()),
                color: draft.color.as_deref(),
                icon: Some(draft.icon.as_deref()),
                statuses: statuses.as_deref(),
            };
            projects::update(conn, &id, &edit, &device, now_ms())?.acknowledge();
            Ok(())
        })
    }

    pub fn set_project_archived(&self, id: String, archived: bool) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            projects::set_archived(conn, &id, archived, &device, now_ms())?.acknowledge();
            Ok(())
        })
    }

    /// New positions, one per id, in the order given.
    pub fn reorder_projects(&self, ids: Vec<String>) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let positions: Vec<(&str, i64)> = ids
                .iter()
                .enumerate()
                .map(|(index, id)| (id.as_str(), i64::try_from(index).unwrap_or(i64::MAX)))
                .collect();
            for durable in projects::reorder(conn, &positions, &device, now_ms())? {
                durable.acknowledge();
            }
            Ok(())
        })
    }

    /// Deletes a project, moving its tasks to the Inbox or deleting them.
    pub fn delete_project(
        &self,
        id: String,
        move_tasks_to_inbox: bool,
    ) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        let disposition = if move_tasks_to_inbox {
            TaskDisposition::MoveToInbox
        } else {
            TaskDisposition::Delete
        };
        self.db.call_blocking(move |conn| {
            projects::delete(conn, &id, disposition, &device, now_ms())?.acknowledge();
            Ok(())
        })
    }

    pub fn set_project_home_note(
        &self,
        id: String,
        note_id: Option<String>,
    ) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            projects::set_home_note(conn, &id, note_id.as_deref(), &device, now_ms())?
                .acknowledge();
            Ok(())
        })
    }

    /// The items linked to a project's hub, in position order.
    pub fn project_links(&self, id: String) -> Result<Vec<ProjectLinkItem>, StorageError> {
        self.db.call_blocking(move |conn| {
            Ok(projects::links(conn, &id)?
                .into_iter()
                .map(ProjectLinkItem::from)
                .collect())
        })
    }

    /// `item_type` is `note`, `calendar_event` or `file`.
    pub fn link_to_project(
        &self,
        id: String,
        item_type: String,
        item_id: String,
    ) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            projects::link(
                conn,
                &id,
                link_type(&item_type)?,
                &item_id,
                &device,
                now_ms(),
            )?
            .acknowledge();
            Ok(())
        })
    }

    pub fn unlink_from_project(
        &self,
        id: String,
        item_type: String,
        item_id: String,
    ) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            projects::unlink(
                conn,
                &id,
                link_type(&item_type)?,
                &item_id,
                &device,
                now_ms(),
            )?
            .acknowledge();
            Ok(())
        })
    }

    pub fn set_project_link_pinned(
        &self,
        id: String,
        item_id: String,
        pinned: bool,
    ) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            projects::set_link_pinned(conn, &id, &item_id, pinned, &device, now_ms())?
                .acknowledge();
            Ok(())
        })
    }

    /// Open/done/overdue numbers per project. `today` is `YYYY-MM-DD`.
    pub fn project_stats(
        &self,
        include_archived: bool,
        today: String,
    ) -> Result<Vec<ProjectStats>, StorageError> {
        self.db.call_blocking(move |conn| {
            Ok(projects::summaries(conn, include_archived, &today)?
                .into_iter()
                .map(ProjectStats::from)
                .collect())
        })
    }

    // ---- saved filters -------------------------------------------------------

    pub fn saved_filters(&self) -> Result<Vec<SavedFilterItem>, StorageError> {
        self.db.call_blocking(|conn| {
            Ok(saved_filters::list(conn)?
                .into_iter()
                .map(SavedFilterItem::from)
                .collect())
        })
    }

    /// `config_json` is desktop's `{filters, sort?, starred?}`. Returns the id.
    pub fn create_saved_filter(
        &self,
        name: String,
        config_json: String,
    ) -> Result<String, StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let config = parse_config(&config_json)?;
            let filter = NewSavedFilter {
                id: None,
                name: &name,
                config: &config,
            };
            Ok(saved_filters::create(conn, &filter, &device, now_ms())?
                .acknowledge()
                .id)
        })
    }

    /// Renames and/or replaces parts of the config (deep-merged).
    pub fn update_saved_filter(
        &self,
        id: String,
        name: Option<String>,
        config_json: Option<String>,
    ) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let config = config_json.as_deref().map(parse_config).transpose()?;
            saved_filters::update(
                conn,
                &id,
                name.as_deref(),
                config.as_ref(),
                &device,
                now_ms(),
            )?
            .acknowledge();
            Ok(())
        })
    }

    pub fn set_saved_filter_starred(&self, id: String, starred: bool) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            saved_filters::set_starred(conn, &id, starred, &device, now_ms())?.acknowledge();
            Ok(())
        })
    }

    pub fn delete_saved_filter(&self, id: String) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            saved_filters::delete(conn, &id, &device, now_ms())?.acknowledge();
            Ok(())
        })
    }

    /// New positions, one per id, in the order given.
    pub fn reorder_saved_filters(&self, ids: Vec<String>) -> Result<(), StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let positions: Vec<i64> = (0..ids.len())
                .map(|index| i64::try_from(index).unwrap_or(i64::MAX))
                .collect();
            saved_filters::reorder(conn, &ids, &positions, &device, now_ms())?;
            Ok(())
        })
    }

    // ---- task settings -------------------------------------------------------

    pub fn task_settings(&self) -> Result<TaskSettingsItem, StorageError> {
        self.db
            .call_blocking(|conn| Ok(task_settings::read(conn)?.into()))
    }

    pub fn set_default_project(
        &self,
        project_id: Option<String>,
    ) -> Result<TaskSettingsItem, StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            Ok(
                task_settings::set_default_project(conn, project_id.as_deref(), &device, now_ms())?
                    .into(),
            )
        })
    }

    pub fn set_default_sort_order(&self, order: String) -> Result<TaskSettingsItem, StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            Ok(task_settings::set_default_sort_order(conn, &order, &device, now_ms())?.into())
        })
    }

    pub fn set_stale_inbox_days(&self, days: i64) -> Result<TaskSettingsItem, StorageError> {
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            Ok(task_settings::set_stale_inbox_days(conn, days, &device, now_ms())?.into())
        })
    }

    /// Local to this device, as on desktop.
    pub fn set_default_view(&self, view: String) -> Result<TaskSettingsItem, StorageError> {
        self.db
            .call_blocking(move |conn| Ok(task_settings::set_default_view(conn, &view)?.into()))
    }
}
