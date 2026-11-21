//! The project commands of `TasksService` (`tasks:project-*` of `ipc/tasks-handlers.ts`, other
//! than `capture-url` and `import-files`). Core decides each rule; this layer checks the zod
//! bounds core does not, answers Electron's envelopes and lists the events
//! `commands-projects.ts` publishes, in its order.

use std::path::Path;

use memry_core::api::errors::StorageError;
use memry_core::api::task_store::{NoteNames, ProjectRefusal};
use memry_core::api::vault::Vault;
use memry_core::domain::projects::{
    LinkItemType, NewProject, ProjectEdit, StatusInput, StatusType,
};

use super::project_contract::{
    ProjectContentsView, ProjectCreateInput, ProjectLinkItemInput, ProjectLinkView,
    ProjectListForItemInput, ProjectListView, ProjectMutation, ProjectRefView, ProjectReorderInput,
    ProjectSetHomeNoteInput, ProjectSetLinkPinnedInput, ProjectStatusInput, ProjectUpdateInput,
    ProjectWithStatusesView,
};
use super::project_notes::{NoteWrite, ProjectWrite};
use super::service::{TaskEvent, TaskWritten, TasksService, invalid};
use super::writes::deleted;
use crate::shell::file_open::Resolution;
use crate::vault::paths::resolve_vault_file;

/// The refusal of a write on a project no vault holds.
pub const PROJECT_NOT_FOUND: &str = "Project not found";
/// The message `archiveProject` throws for the Inbox, which `withDb` answers.
pub const INBOX_ARCHIVE: &str = "Cannot archive the inbox project";
/// The message `deleteProject` throws for the Inbox, which `withDb` answers.
pub const INBOX_DELETE: &str = "Cannot delete the inbox project";
/// `tasks:project-reorder`'s `withDb` fallback, for lists of different lengths.
pub const PROJECT_REORDER_FAILED: &str = "errors:project.reorderFailed";
/// `StatusInputSchema`'s colour default.
const STATUS_COLOR: &str = "#6b7280";

type ProjectWritten = TaskWritten<ProjectMutation>;

impl TasksService {
    /// `tasks:project-list`: the projects that are not archived, with their task counts.
    pub fn projects(&self) -> Result<ProjectListView, StorageError> {
        let today = (self.now)().date().to_string();
        let projects = self.store.projects(&today)?;
        Ok(ProjectListView {
            projects: projects.into_iter().map(Into::into).collect(),
        })
    }

    /// `tasks:project-get`.
    pub fn project(&self, id: &str) -> Result<Option<ProjectWithStatusesView>, StorageError> {
        Ok(self.store.project(id)?.map(Into::into))
    }

    /// `tasks:project-create`: default statuses unless a list is given.
    pub fn create_project(
        &self,
        input: ProjectCreateInput,
    ) -> Result<ProjectWritten, StorageError> {
        let statuses = input.statuses.as_deref().map(status_inputs).transpose()?;
        let created = self.store.create_project(NewProject {
            id: None,
            name: &input.name,
            description: input.description.as_deref(),
            color: input.color.as_deref(),
            icon: input.icon.as_deref(),
            statuses: statuses.as_deref(),
        })?;
        let project = ProjectWithStatusesView::from(created);
        Ok(TaskWritten {
            events: vec![TaskEvent::ProjectCreated(project.project.id.clone())],
            mutation: ProjectMutation::ok(Some(project)),
        })
    }

    /// `tasks:project-update`: metadata and statuses in one write; a rename then reaches every
    /// linked markdown note's file ([`ProjectWrite::finish`]).
    pub fn update_project(&self, input: ProjectUpdateInput) -> Result<ProjectWrite, StorageError> {
        let statuses = input.statuses.as_deref().map(status_inputs).transpose()?;
        let edit = ProjectEdit {
            name: input.name.as_deref(),
            description: input.description.as_ref().map(Option::as_deref),
            color: input.color.as_deref(),
            icon: input.icon.as_ref().map(Option::as_deref),
            statuses: statuses.as_deref(),
        };
        Ok(match self.store.update_project(&input.id, edit)? {
            Ok((project, notes)) => ProjectWrite {
                written: updated(&input.id, Some(project.into())),
                notes: notes.map_or(NoteWrite::None, NoteWrite::Propagation),
            },
            Err(refusal) => {
                ProjectWrite::without_notes(TaskWritten::quiet(refused(refusal, INBOX_ARCHIVE)))
            }
        })
    }

    /// `tasks:project-delete`: the project's tasks go with it. `tasks:project-deleted`, then a
    /// `tasks:deleted` (and its tags-changed) for each task, as `deleteProject` publishes them.
    /// The name then leaves every linked markdown note's file ([`ProjectWrite::finish`]).
    pub fn delete_project(&self, id: &str) -> Result<ProjectWrite, StorageError> {
        Ok(match self.store.delete_project(id)? {
            Ok((write, notes)) => {
                let mut events = vec![TaskEvent::ProjectDeleted(id.to_owned())];
                events.extend(deleted(&write, &[]));
                ProjectWrite {
                    written: TaskWritten {
                        mutation: ProjectMutation::ok(None),
                        events,
                    },
                    notes: notes.map_or(NoteWrite::None, NoteWrite::Propagation),
                }
            }
            Err(refusal) => {
                ProjectWrite::without_notes(TaskWritten::quiet(refused(refusal, INBOX_DELETE)))
            }
        })
    }

    /// `tasks:project-archive`.
    pub fn archive_project(&self, id: &str) -> Result<ProjectWritten, StorageError> {
        Ok(match self.store.archive_project(id)? {
            Ok(()) => updated(id, None),
            Err(refusal) => TaskWritten::quiet(refused(refusal, INBOX_ARCHIVE)),
        })
    }

    /// `tasks:project-reorder`: a `tasks:project-updated` for each live project, in the order
    /// given. Lists of different lengths write nothing.
    pub fn reorder_projects(
        &self,
        input: ProjectReorderInput,
    ) -> Result<ProjectWritten, StorageError> {
        if input.project_ids.len() != input.positions.len() {
            return Ok(TaskWritten::quiet(ProjectMutation::refused(
                PROJECT_REORDER_FAILED,
            )));
        }
        let live = self
            .store
            .reorder_projects(&input.project_ids, &input.positions)?;
        Ok(TaskWritten {
            mutation: ProjectMutation::ok(None),
            events: live.into_iter().map(TaskEvent::ProjectUpdated).collect(),
        })
    }

    /// `tasks:project-link-item`; a markdown note through its file ([`NoteWrite::Membership`]).
    pub fn link_project_item(
        &self,
        input: ProjectLinkItemInput,
    ) -> Result<ProjectWrite, StorageError> {
        let kind = link_type(&input.item_type)?;
        let landed = self
            .store
            .link_project_item(&input.project_id, kind, &input.item_id)?;
        Ok(membership(&input.project_id, landed))
    }

    /// `tasks:project-unlink-item`, a markdown note as in [`Self::link_project_item`].
    pub fn unlink_project_item(
        &self,
        input: ProjectLinkItemInput,
    ) -> Result<ProjectWrite, StorageError> {
        let kind = link_type(&input.item_type)?;
        let landed = self
            .store
            .unlink_project_item(&input.project_id, kind, &input.item_id)?;
        Ok(membership(&input.project_id, landed))
    }

    /// `tasks:project-set-link-pinned`.
    pub fn set_project_link_pinned(
        &self,
        input: ProjectSetLinkPinnedInput,
    ) -> Result<ProjectWritten, StorageError> {
        let landed =
            self.store
                .set_project_link_pinned(&input.project_id, &input.item_id, input.pinned)?;
        Ok(acked(&input.project_id, landed))
    }

    /// `tasks:project-set-home-note`: answers the project.
    pub fn set_project_home_note(
        &self,
        input: ProjectSetHomeNoteInput,
    ) -> Result<ProjectWritten, StorageError> {
        let id = &input.project_id;
        Ok(
            match self
                .store
                .set_project_home_note(id, input.note_id.as_deref())?
            {
                Ok(project) => updated(id, Some(project.into())),
                Err(refusal) => TaskWritten::quiet(refused(refusal, INBOX_ARCHIVE)),
            },
        )
    }

    /// `tasks:project-list-links`.
    pub fn project_links(&self, id: &str) -> Result<Vec<ProjectLinkView>, StorageError> {
        Ok(self
            .store
            .project_links(id)?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    /// `tasks:project-list-contents`, with Electron's `withoutMissingVaultItems`: a note or file
    /// the vault cannot open (no listed file row, or its file gone from under `root`) is left
    /// out and the counts follow, so the hub lists only what it can open.
    pub fn project_contents(
        &self,
        id: &str,
        vault: &Vault,
        root: &Path,
    ) -> Result<ProjectContentsView, StorageError> {
        let mut contents = self.store.project_contents(id)?;
        let files = vault.note_files();
        let openable = |note_id: &str| -> Result<bool, StorageError> {
            let Some(listed) = files.listed_by_id(note_id)? else {
                return Ok(false);
            };
            match resolve_vault_file(root, &listed.path) {
                Ok(Resolution::Inside(_)) => Ok(true),
                Ok(Resolution::Missing | Resolution::Outside) => Ok(false),
                Err(error) => Err(StorageError::Failed {
                    what: format!("note {note_id} file: {error}"),
                }),
            }
        };
        contents.notes = keep(contents.notes, |note| openable(&note.id))?;
        contents.files = keep(contents.files, |file| openable(&file.id))?;
        Ok(contents.into())
    }

    /// `tasks:project-list-for-item`.
    pub fn projects_for_item(
        &self,
        input: ProjectListForItemInput,
    ) -> Result<Vec<ProjectRefView>, StorageError> {
        link_type(&input.item_type)?;
        Ok(self
            .store
            .projects_for_item(&input.item_type, &input.item_id)?
            .into_iter()
            .map(Into::into)
            .collect())
    }
}

/// A landed write announced as `tasks:project-updated`.
fn updated(id: &str, project: Option<ProjectWithStatusesView>) -> ProjectWritten {
    TaskWritten {
        mutation: ProjectMutation::ok(project),
        events: vec![TaskEvent::ProjectUpdated(id.to_owned())],
    }
}

fn acked(id: &str, landed: Result<(), ProjectRefusal>) -> ProjectWritten {
    match landed {
        Ok(()) => updated(id, None),
        Err(refusal) => TaskWritten::quiet(refused(refusal, INBOX_ARCHIVE)),
    }
}

fn membership(id: &str, landed: Result<Option<NoteNames>, ProjectRefusal>) -> ProjectWrite {
    match landed {
        Ok(notes) => ProjectWrite {
            written: updated(id, None),
            notes: notes.map_or(NoteWrite::None, NoteWrite::Membership),
        },
        Err(refusal) => {
            ProjectWrite::without_notes(TaskWritten::quiet(refused(refusal, INBOX_ARCHIVE)))
        }
    }
}

/// The envelope of a refusal; `inbox` is the message the command throws for the Inbox.
fn refused(refusal: ProjectRefusal, inbox: &str) -> ProjectMutation {
    ProjectMutation::refused(match refusal {
        ProjectRefusal::NotFound => PROJECT_NOT_FOUND,
        ProjectRefusal::Inbox => inbox,
    })
}

/// `ProjectLinkItemSchema`'s `itemType` enum.
fn link_type(item_type: &str) -> Result<LinkItemType, StorageError> {
    LinkItemType::parse(item_type)
        .ok_or_else(|| invalid("itemType must be note, calendar_event or file"))
}

/// `StatusInputSchema` / `StatusUpsertSchema`: the type enum, `order` at least 0 and the colour
/// default. Core checks the name, the colour and the list's length.
fn status_inputs(inputs: &[ProjectStatusInput]) -> Result<Vec<StatusInput<'_>>, StorageError> {
    inputs
        .iter()
        .map(|input| {
            if input.order < 0 {
                return Err(invalid("status order must be at least 0"));
            }
            Ok(StatusInput {
                id: input.id.as_deref(),
                name: &input.name,
                color: input.color.as_deref().unwrap_or(STATUS_COLOR),
                status_type: StatusType::parse(&input.status_type)
                    .ok_or_else(|| invalid("status type must be todo, in_progress or done"))?,
                order: input.order,
            })
        })
        .collect()
}

fn keep<T>(
    items: Vec<T>,
    mut openable: impl FnMut(&T) -> Result<bool, StorageError>,
) -> Result<Vec<T>, StorageError> {
    let mut kept = Vec::with_capacity(items.len());
    for item in items {
        if openable(&item)? {
            kept.push(item);
        }
    }
    Ok(kept)
}
