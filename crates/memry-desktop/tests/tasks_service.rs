//! `TasksService` over a real vault in a temp dir: the task reads, `tasks:update` with each
//! refusal key of Electron's `updateTask`, the status commands with theirs, the zod bounds of
//! `tasks-api.ts`, and the outbox rows the sync push reads.

use std::sync::Arc;

use memry_core::api::projects::ProjectDraft;
use memry_core::api::tasks::Tasks;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::api::vault::Vault;
use memry_core::domain::calendar::{CivilDate, LocalDateTime};
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::sync::events::{ItemOperation, PulledItem};
use memry_desktop::tasks::contract::{
    StatusCreateInput, StatusMutation, StatusReorderInput, StatusUpdateInput, TaskListInput,
    TaskUpdateInput,
};
use memry_desktop::tasks::service::{
    STATUS_CREATE_FAILED, STATUS_NOT_FOUND, TasksService, activity_task_ids,
};
use serde_json::json;

use crate::device_key;

struct Fixture {
    _dir: tempfile::TempDir,
    vault: Vault,
    tasks: Arc<Tasks>,
    service: TasksService,
    project: String,
}

/// 2026-03-10 09:30, local.
fn tuesday() -> LocalDateTime {
    LocalDateTime::new(CivilDate::new(2026, 3, 10).unwrap(), 9, 30, 0, 0)
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open("vault-1".to_owned(), dir.path().display().to_string()).unwrap();
        let store: Arc<dyn SecureStore> = device_key::with_device_key();
        let tasks = vault.tasks(store.clone()).unwrap();
        let service = TasksService::new(vault.task_store(&store).unwrap()).with_clock(tuesday);
        let project = tasks.create_project(draft("Work")).unwrap();
        Self {
            _dir: dir,
            vault,
            tasks,
            service,
            project,
        }
    }

    fn task(&self, title: &str, due: Option<&str>, linked: &[&str]) -> String {
        let change = self
            .tasks
            .create(NewTaskInput {
                title: title.to_owned(),
                project_id: self.project.clone(),
                status_id: None,
                parent_id: None,
                priority: 0,
                description: None,
                due_date: due.map(str::to_owned),
                due_time: None,
                start_date: None,
                repeat: None,
                repeat_from: None,
                tags: Vec::new(),
                linked_note_ids: linked.iter().map(|id| (*id).to_owned()).collect(),
                linked_canvas_ids: Vec::new(),
                source_note_id: None,
                position: None,
            })
            .unwrap();
        change.created[0].clone()
    }

    /// Empties the outbox, so a test sees only its own writes.
    fn pushed(&self) {
        self.vault
            .db_handle()
            .call_blocking(|conn| {
                conn.execute("DELETE FROM outbox", []).unwrap();
                Ok(())
            })
            .unwrap();
    }

    /// Outbox rows queued for `item_id`: what the sync push sends.
    fn outbox(&self, item_id: &str) -> i64 {
        let id = item_id.to_owned();
        self.vault
            .db_handle()
            .call_blocking(move |conn| {
                Ok(conn
                    .query_row(
                        "SELECT COUNT(*) FROM outbox WHERE item_id = ?1",
                        [id],
                        |row| row.get(0),
                    )
                    .unwrap())
            })
            .unwrap()
    }

    fn update(&self, id: &str, patch: serde_json::Value) -> TaskUpdateInput {
        let mut input = json!({ "id": id });
        input
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        serde_json::from_value(input).unwrap()
    }
}

fn draft(name: &str) -> ProjectDraft {
    ProjectDraft {
        name: name.to_owned(),
        description: None,
        color: None,
        icon: None,
        statuses: None,
    }
}

fn list(input: serde_json::Value) -> TaskListInput {
    serde_json::from_value(input).unwrap()
}

#[test]
fn tasks_update_writes_the_task_queues_one_push_and_answers_the_envelope() {
    let f = Fixture::new();
    let id = f.task("Plan", None, &[]);
    f.pushed();

    let written = f
        .service
        .update(f.update(&id, json!({ "title": "Plan the week", "tags": ["Home"] })))
        .unwrap();

    assert!(written.mutation.success);
    assert_eq!(written.mutation.error, None);
    let task = written.mutation.task.clone().expect("the updated task");
    assert_eq!(task.task.title, "Plan the week");
    assert_eq!(task.task.tags, vec!["Home".to_owned()]);
    assert_eq!(written.updated.as_deref(), Some(id.as_str()));
    assert!(written.tags_changed);
    assert_eq!(f.outbox(&id), 1, "the push path picks the edit up");
    let wire = serde_json::to_value(&written.mutation).unwrap();
    assert_eq!(wire["task"]["title"], "Plan the week");
    assert_eq!(wire["task"]["hasSubtasks"], false);
    assert!(wire.get("error").is_none(), "{wire}");
}

#[test]
fn tasks_update_refuses_with_each_electron_error_key_and_writes_nothing() {
    let f = Fixture::new();
    let id = f.task("Plan", None, &[]);
    f.pushed();

    for (patch, key, target) in [
        (json!({ "title": "x" }), "Task not found", "missing"),
        (
            json!({ "projectId": "no-such-project" }),
            "errors:task.projectMissing",
            id.as_str(),
        ),
        (
            json!({ "parentId": id }),
            "errors:task.invalidParent",
            id.as_str(),
        ),
    ] {
        let written = f.service.update(f.update(target, patch)).unwrap();
        assert!(!written.mutation.success, "{key}");
        assert_eq!(written.mutation.error.as_deref(), Some(key));
        assert_eq!(written.mutation.task, None);
        assert_eq!(written.updated, None);
    }
    assert_eq!(f.outbox(&id), 0, "a refusal queues nothing");
}

#[test]
fn tasks_update_rejects_what_task_update_schema_rejects() {
    let f = Fixture::new();
    let id = f.task("Plan", None, &[]);
    for patch in [
        json!({ "title": "" }),
        json!({ "priority": 5 }),
        json!({ "dueTime": "9am" }),
        json!({ "durationMinutes": 0 }),
    ] {
        assert!(
            f.service.update(f.update(&id, patch.clone())).is_err(),
            "{patch}"
        );
    }
}

#[test]
fn a_done_status_through_tasks_update_reports_the_next_occurrence() {
    let f = Fixture::new();
    let id = f.task("Water plants", Some("2026-03-10"), &[]);
    let repeat = json!({
        "frequency": "daily", "interval": 1, "endType": "never",
        "completedCount": 0, "createdAt": "2026-03-01T00:00:00.000Z"
    });
    let set = f
        .service
        .update(f.update(&id, json!({ "repeatConfig": repeat })))
        .unwrap();
    assert!(set.mutation.task.unwrap().task.is_repeating);
    let done = f
        .service
        .statuses(&f.project)
        .unwrap()
        .into_iter()
        .find(|status| status.is_done)
        .unwrap();

    let written = f
        .service
        .update(f.update(&id, json!({ "statusId": done.id })))
        .unwrap();

    let next = written.created.expect("the next occurrence");
    assert_eq!(
        f.service
            .get(&next)
            .unwrap()
            .unwrap()
            .task
            .due_date
            .as_deref(),
        Some("2026-03-11")
    );
}

#[test]
fn tasks_list_keeps_the_task_list_schema_bounds() {
    let f = Fixture::new();
    f.task("A", None, &[]);
    f.task("B", None, &[]);
    for bad in [
        json!({ "limit": 0 }),
        json!({ "limit": 1001 }),
        json!({ "offset": -1 }),
    ] {
        assert!(f.service.list(list(bad.clone())).is_err(), "{bad}");
    }
    let page = f.service.list(list(json!({ "limit": 1 }))).unwrap();
    assert_eq!((page.tasks.len(), page.total, page.has_more), (1, 2, true));
    let wire = serde_json::to_value(&page).unwrap();
    assert!(wire.get("hasMore").is_some(), "{wire}");
    let status = page.tasks[0]
        .task
        .status_id
        .clone()
        .expect("the default status");
    let page = f.service.list(list(json!({ "statusId": status }))).unwrap();
    assert_eq!(page.tasks.len(), 2);
    let page = f.service.list(list(json!({ "statusId": null }))).unwrap();
    assert!(
        page.tasks.is_empty(),
        "null matches only a task with no status"
    );
}

#[test]
fn the_dated_reads_run_on_the_service_clock() {
    let f = Fixture::new();
    f.task("Late", Some("2026-03-09"), &[]);
    f.task("Now", Some("2026-03-10"), &[]);
    f.task("Soon", Some("2026-03-12"), &[]);
    let titles = |items: Vec<memry_desktop::tasks::contract::TaskListItemView>| {
        items
            .into_iter()
            .map(|item| item.task.title)
            .collect::<Vec<_>>()
    };
    assert_eq!(titles(f.service.overdue().unwrap()), ["Late"]);
    assert_eq!(titles(f.service.today().unwrap()), ["Now"]);
    assert!(titles(f.service.upcoming(Some(3)).unwrap()).contains(&"Soon".to_owned()));
    assert!(f.service.upcoming(Some(0)).is_err());
    assert!(f.service.upcoming(Some(366)).is_err());
    let stats = f.service.stats().unwrap();
    assert_eq!((stats.total, stats.overdue, stats.due_today), (3, 1, 1));
}

#[test]
fn tasks_get_linked_tasks_reads_the_task_links_of_a_note() {
    let f = Fixture::new();
    let linked = f.task("Linked", None, &["note-1"]);
    f.task("Other", None, &["note-2"]);
    let tasks = f.service.linked_tasks("note-1").unwrap();
    assert_eq!(
        tasks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        [linked.as_str()]
    );
    assert_eq!(tasks[0].linked_note_ids, ["note-1"]);
}

#[test]
fn the_status_commands_write_the_project_and_answer_electrons_envelopes() {
    let f = Fixture::new();
    f.pushed();
    let created = f
        .service
        .create_status(StatusCreateInput {
            project_id: f.project.clone(),
            name: "Review".to_owned(),
            color: None,
            is_done: None,
        })
        .unwrap();
    let status = created.status.clone().expect("the new status");
    assert!(created.success);
    assert_eq!(
        (status.color.as_str(), status.is_default),
        ("#6b7280", false)
    );
    assert_eq!(f.outbox(&f.project), 1, "a status write pushes its project");

    let updated = f
        .service
        .update_status(StatusUpdateInput {
            id: status.id.clone(),
            name: Some("In review".to_owned()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(updated.status.unwrap().name, "In review");

    let unchanged = f
        .service
        .update_status(StatusUpdateInput {
            id: status.id.clone(),
            name: Some("In review".to_owned()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(unchanged.status.unwrap().name, "In review");

    f.service
        .reorder_statuses(StatusReorderInput {
            status_ids: vec![status.id.clone()],
            positions: vec![0],
        })
        .unwrap();
    let listed = f.service.statuses(&f.project).unwrap();
    assert_eq!(
        listed.iter().find(|s| s.id == status.id).unwrap().position,
        0
    );

    assert_eq!(
        f.service.delete_status(&status.id).unwrap(),
        StatusMutation::ok(None)
    );
    assert!(
        f.service
            .statuses(&f.project)
            .unwrap()
            .iter()
            .all(|s| s.id != status.id)
    );
}

#[test]
fn the_status_commands_refuse_with_electrons_keys() {
    let f = Fixture::new();
    let missing_project = f
        .service
        .create_status(StatusCreateInput {
            project_id: "no-such-project".to_owned(),
            name: "Review".to_owned(),
            color: None,
            is_done: None,
        })
        .unwrap();
    assert_eq!(
        missing_project,
        StatusMutation::refused(STATUS_CREATE_FAILED)
    );

    let missing_status = f
        .service
        .update_status(StatusUpdateInput {
            id: "no-such-status".to_owned(),
            name: Some("x".to_owned()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(missing_status, StatusMutation::refused(STATUS_NOT_FOUND));
    let wire = serde_json::to_value(&missing_status).unwrap();
    assert_eq!(
        wire,
        json!({ "success": false, "error": "Status not found" })
    );

    assert_eq!(
        f.service.delete_status("no-such-status").unwrap(),
        StatusMutation::ok(None),
        "Electron deletes a missing status without complaint"
    );
}

#[test]
fn a_pulled_task_update_names_its_task_for_the_activity_refetch() {
    let item = |item_type: &str, item_id: &str, operation| PulledItem {
        item_type: item_type.into(),
        item_id: item_id.into(),
        operation,
    };
    let ids = activity_task_ids(&[
        item("task", "t1", ItemOperation::Update),
        item("task", "t2", ItemOperation::Create),
        item("project", "p1", ItemOperation::Update),
        item("task", "t3", ItemOperation::Delete),
    ]);
    assert_eq!(ids, ["t1"]);
}
