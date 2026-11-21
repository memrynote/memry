//! The project commands of desktop's `tasks:project-*` handlers on [`TaskStore`]. Each write is
//! core's [`projects`] write: one transaction per project write with its outbox row and its field
//! clocks ticked. A write that changes linked markdown notes or the project's tasks writes each
//! of them through its own type's path, after or before the project as [`projects`] orders them.

use rusqlite::{Connection, params};

use super::TaskStore;
use crate::api::errors::StorageError;
use crate::api::tasks_write::{after, now_ms, source_notes};
use crate::domain::notes::failed;
use crate::domain::projects::{
    self, LinkItemType, NewProject, Project, ProjectContents, ProjectEdit, ProjectLink, ProjectRef,
    ProjectSummary, Status, TaskDisposition,
};
use crate::domain::tasks::{self, Removed, TaskWrite};
use crate::storage::repositories::{StoredPayload, instants, sync_items};

/// Why a project write did not land, answered by desktop as `{ success: false, error }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectRefusal {
    /// No live project has the id (`Project not found`).
    NotFound,
    /// The Inbox cannot be archived or deleted (`archiveProject`, `deleteProject` throw).
    Inbox,
}

/// A project with the two stamps desktop's `Project` carries and core's [`Project`] does not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredProject {
    pub project: Project,
    /// ISO 8601; `None` when the row carries no readable stamp.
    pub created_at: Option<String>,
    pub modified_at: Option<String>,
}

type Answer<T> = Result<Result<T, ProjectRefusal>, StorageError>;

impl TaskStore {
    /// `tasks:project-list` (`getProjectsWithStats`): the projects that are not archived, in
    /// position order, each with its task counts on `today` (`YYYY-MM-DD`).
    pub fn projects(
        &self,
        today: &str,
    ) -> Result<Vec<(StoredProject, ProjectSummary)>, StorageError> {
        self.db.read_blocking(|conn| {
            let summaries = projects::summaries(conn, false, today)?;
            projects::list(conn, false)?
                .into_iter()
                .map(|project| {
                    let summary = summaries
                        .iter()
                        .find(|summary| summary.project_id == project.id)
                        .cloned()
                        .unwrap_or_else(|| ProjectSummary {
                            project_id: project.id.clone(),
                            task_count: 0,
                            completed_count: 0,
                            overdue_count: 0,
                        });
                    Ok((stored(conn, project)?, summary))
                })
                .collect()
        })
    }

    /// `tasks:project-get` (`getProjectWithStatuses`), archived or not.
    pub fn project(&self, id: &str) -> Result<Option<(StoredProject, Vec<Status>)>, StorageError> {
        self.db.read_blocking(|conn| with_statuses(conn, id))
    }

    /// `tasks:project-create` (`createProject`): the new project with its statuses.
    pub fn create_project(
        &self,
        project: NewProject<'_>,
    ) -> Result<(StoredProject, Vec<Status>), StorageError> {
        self.project_write(move |conn, device, now| {
            let id = projects::create(conn, &project, device, now)?.acknowledge();
            with_statuses(conn, &id)?.ok_or_else(|| StorageError::Failed {
                what: format!("project {id} not found after create"),
            })
        })
    }

    /// `tasks:project-update` (`updateProject` with `reconcileProjectStatuses`); a rename
    /// rewrites every linked markdown note (core's pass, after the project write).
    pub fn update_project(
        &self,
        id: &str,
        edit: ProjectEdit<'_>,
    ) -> Answer<(StoredProject, Vec<Status>)> {
        self.live_write(id, move |conn, device, now| {
            projects::update(conn, id, &edit, device, now)?.map(|written| written.acknowledge());
            Ok(Ok(()))
        })
        .and_then(|landed| self.then_read(id, landed))
    }

    /// `tasks:project-archive` (`archiveProject`). Archiving an archived project keeps its first
    /// `archivedAt` and writes nothing.
    pub fn archive_project(&self, id: &str) -> Answer<()> {
        self.live_write(id, move |conn, device, now| {
            if projects::get(conn, id)?.is_some_and(|project| project.is_inbox) {
                return Ok(Err(ProjectRefusal::Inbox));
            }
            projects::set_archived(conn, id, true, device, now)?.map(|w| w.acknowledge());
            Ok(Ok(()))
        })
    }

    /// `tasks:project-delete` (`deleteProject`): every live task of the project is deleted
    /// (parents first), then the project is tombstoned and its name leaves each linked markdown
    /// note. Answers the task deletions with their last payloads, after [`after`]'s bookkeeping.
    /// A project no vault holds deletes nothing and still succeeds, as desktop's does.
    pub fn delete_project(&self, id: &str) -> Answer<TaskWrite> {
        self.project_write(move |conn, device, now| {
            let Some(project) = projects::get(conn, id)? else {
                return Ok(Ok(TaskWrite::default()));
            };
            if project.is_inbox {
                return Ok(Err(ProjectRefusal::Inbox));
            }
            let before = source_notes(conn)?;
            let removed = live_tasks(conn, id)?;
            projects::delete(conn, id, TaskDisposition::Delete, device, now)?.acknowledge();
            let mut write = TaskWrite::default();
            for task in removed {
                if !is_live(conn, &task.task_id)? {
                    write.deleted.push(task.task_id.clone());
                    write.removed.push(task);
                }
            }
            after(conn, &write, &before, device, now);
            Ok(Ok(write))
        })
    }

    /// `tasks:project-reorder` (`reorderProjects`): each live project takes its position, one
    /// write per project; an id no vault holds is skipped, as desktop's update matches no row.
    /// Answers the ids that are live, in the order given.
    pub fn reorder_projects(
        &self,
        ids: &[String],
        positions: &[i64],
    ) -> Result<Vec<String>, StorageError> {
        self.project_write(move |conn, device, now| {
            let mut live = Vec::new();
            for (id, position) in ids.iter().zip(positions) {
                if projects::get(conn, id)?.is_some() {
                    live.push((id.as_str(), *position));
                }
            }
            for written in projects::reorder(conn, &live, device, now)? {
                written.acknowledge();
            }
            Ok(live.into_iter().map(|(id, _)| id.to_owned()).collect())
        })
    }

    /// `tasks:project-link-item` (`linkProjectItem`): a markdown note through its `project`
    /// property and a mirrored `links` entry, anything else through `links` alone.
    pub fn link_project_item(
        &self,
        id: &str,
        item_type: LinkItemType,
        item_id: &str,
    ) -> Answer<()> {
        self.live_write(id, move |conn, device, now| {
            projects::link(conn, id, item_type, item_id, device, now)?.map(|w| w.acknowledge());
            Ok(Ok(()))
        })
    }

    /// `tasks:project-unlink-item` (`unlinkProjectItem`).
    pub fn unlink_project_item(
        &self,
        id: &str,
        item_type: LinkItemType,
        item_id: &str,
    ) -> Answer<()> {
        self.live_write(id, move |conn, device, now| {
            projects::unlink(conn, id, item_type, item_id, device, now)?.map(|w| w.acknowledge());
            Ok(Ok(()))
        })
    }

    /// `tasks:project-set-link-pinned` (`setProjectLinkPinned`). An item the project does not
    /// link writes nothing and succeeds, as desktop's update matches no row.
    pub fn set_project_link_pinned(&self, id: &str, item_id: &str, pinned: bool) -> Answer<()> {
        self.live_write(id, move |conn, device, now| {
            match projects::set_link_pinned(conn, id, item_id, pinned, device, now) {
                Ok(written) => drop(written.map(|w| w.acknowledge())),
                Err(StorageError::NotFound { .. }) => {}
                Err(error) => return Err(error),
            }
            Ok(Ok(()))
        })
    }

    /// `tasks:project-set-home-note` (`setProjectHomeNote`); `None` clears it.
    pub fn set_project_home_note(
        &self,
        id: &str,
        note_id: Option<&str>,
    ) -> Answer<(StoredProject, Vec<Status>)> {
        self.live_write(id, move |conn, device, now| {
            projects::set_home_note(conn, id, note_id, device, now)?.map(|w| w.acknowledge());
            Ok(Ok(()))
        })
        .and_then(|landed| self.then_read(id, landed))
    }

    /// `tasks:project-list-links` (`getProjectLinks`); empty for a project no vault holds.
    pub fn project_links(&self, id: &str) -> Result<Vec<ProjectLink>, StorageError> {
        self.db
            .read_blocking(|conn| match projects::get(conn, id)? {
                Some(_) => projects::links(conn, id),
                None => Ok(Vec::new()),
            })
    }

    /// `tasks:project-list-contents` (`getProjectContents`).
    pub fn project_contents(&self, id: &str) -> Result<ProjectContents, StorageError> {
        self.db.read_blocking(|conn| projects::contents(conn, id))
    }

    /// `tasks:project-list-for-item` (`getProjectsForItem`).
    pub fn projects_for_item(
        &self,
        item_type: &str,
        item_id: &str,
    ) -> Result<Vec<ProjectRef>, StorageError> {
        self.db
            .read_blocking(|conn| projects::projects_for_item(conn, item_type, item_id))
    }

    /// One project write on the vault's writer.
    fn project_write<T, F>(&self, work: F) -> Result<T, StorageError>
    where
        F: FnOnce(&Connection, &str, i64) -> Result<T, StorageError>,
    {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| work(conn, &device_id, now_ms()))
    }

    /// [`Self::project_write`] on a live project; `NotFound` when no vault holds it.
    fn live_write<T, F>(&self, id: &str, work: F) -> Answer<T>
    where
        F: FnOnce(&Connection, &str, i64) -> Answer<T>,
    {
        self.project_write(move |conn, device, now| {
            if projects::get(conn, id)?.is_none() {
                return Ok(Err(ProjectRefusal::NotFound));
            }
            work(conn, device, now)
        })
    }

    /// The project as it reads after a write that landed.
    fn then_read(
        &self,
        id: &str,
        landed: Result<(), ProjectRefusal>,
    ) -> Answer<(StoredProject, Vec<Status>)> {
        if let Err(refusal) = landed {
            return Ok(Err(refusal));
        }
        Ok(self.project(id)?.ok_or(ProjectRefusal::NotFound))
    }
}

fn with_statuses(
    conn: &Connection,
    id: &str,
) -> Result<Option<(StoredProject, Vec<Status>)>, StorageError> {
    let Some(project) = projects::get(conn, id)? else {
        return Ok(None);
    };
    let statuses = projects::statuses(conn, id)?;
    Ok(Some((stored(conn, project)?, statuses)))
}

fn stored(conn: &Connection, project: Project) -> Result<StoredProject, StorageError> {
    let (created, modified): (Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT created_at, modified_at FROM projects WHERE id = ?1",
            params![project.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(failed)?;
    Ok(StoredProject {
        project,
        created_at: created.and_then(instants::to_iso8601),
        modified_at: modified.and_then(instants::to_iso8601),
    })
}

/// The project's live tasks with their payloads, in the order core's delete takes them.
fn live_tasks(conn: &Connection, project_id: &str) -> Result<Vec<Removed>, StorageError> {
    let ids: Vec<String> = conn
        .prepare(
            "SELECT id FROM tasks
              WHERE project_id = ?1 AND deleted_at IS NULL
              ORDER BY parent_id IS NOT NULL, position, id",
        )
        .and_then(|mut statement| {
            statement
                .query_map(params![project_id], |row| row.get(0))?
                .collect()
        })
        .map_err(failed)?;
    ids.into_iter()
        .map(|task_id| {
            let raw = sync_items::load(conn, tasks::ITEM_TYPE, &task_id)?
                .and_then(|row| row.payload)
                .unwrap_or_else(|| "{}".to_owned());
            let payload = StoredPayload::parse(&raw).map_err(|error| StorageError::Failed {
                what: format!("task {task_id} payload will not parse: {error}"),
            })?;
            Ok(Removed {
                payload: payload.object().clone(),
                task_id,
            })
        })
        .collect()
}

fn is_live(conn: &Connection, task_id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE id = ?1 AND deleted_at IS NULL)",
        params![task_id],
        |row| row.get(0),
    )
    .map_err(failed)
}
