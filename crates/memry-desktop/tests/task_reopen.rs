//! `tasks:uncomplete` and the repeating roll of `tasks:complete` over a real vault: the open
//! status they pick is Electron's `openStatusIdOnReopen` (`packages/domain-tasks/src/
//! completion.ts:39-49`) and `defaultOpenStatusId` (`repeat-completion.ts:47-53`).

use memry_desktop::tasks::contract::{StatusReorderInput, TaskUpdateInput};
use memry_desktop::tasks::service::TaskEvent;
use memry_desktop::tasks::write_contract::{TaskCompleteInput, TaskCompletion, TaskCreateInput};
use serde_json::json;

use crate::tasks_service::Fixture;

impl Fixture {
    fn status_named(&self, name: &str) -> String {
        self.service
            .statuses(&self.project)
            .unwrap()
            .into_iter()
            .find(|status| status.name == name)
            .unwrap()
            .id
    }

    /// `tasks:status-reorder` to In Progress, To Do, Done.
    fn in_progress_first(&self) {
        let order = ["In Progress", "To Do", "Done"].map(|name| self.status_named(name));
        self.service
            .reorder_statuses(StatusReorderInput {
                status_ids: order.to_vec(),
                positions: vec![0, 1, 2],
            })
            .unwrap();
    }

    fn status_of(&self, id: &str) -> Option<String> {
        self.service
            .get(id)
            .unwrap()
            .expect("live task")
            .task
            .status_id
    }

    fn complete(&self, id: &str) -> TaskCompletion {
        self.service
            .complete(TaskCompleteInput {
                id: id.to_owned(),
                ..TaskCompleteInput::default()
            })
            .unwrap()
            .mutation
    }
}

#[test]
fn uncomplete_after_a_status_reorder_moves_the_task_out_of_done() {
    let f = Fixture::new();
    let id = f.task("Plan", None, &[]);
    f.in_progress_first();
    f.complete(&id);
    assert_eq!(f.status_of(&id), Some(f.status_named("Done")));

    let reopened = f.service.uncomplete(&id).unwrap();
    assert_eq!(reopened.events, [TaskEvent::Updated(id.clone())]);
    assert_eq!(f.status_of(&id), Some(f.status_named("To Do")));
    let view = f.service.get(&id).unwrap().unwrap().task;
    assert_eq!(view.completed_at, None);
}

#[test]
fn uncomplete_leaves_an_in_progress_task_in_progress() {
    let f = Fixture::new();
    let id = f.task("Plan", None, &[]);
    let doing = f.status_named("In Progress");
    let update: TaskUpdateInput =
        serde_json::from_value(json!({ "id": id, "statusId": doing })).unwrap();
    f.service.update(update).unwrap();

    f.service.uncomplete(&id).unwrap();
    assert_eq!(f.status_of(&id), Some(doing));
}

#[test]
fn a_repeating_completion_puts_the_next_occurrence_in_the_default_open_status() {
    let f = Fixture::new();
    f.in_progress_first();
    let input: TaskCreateInput = serde_json::from_value(json!({
        "projectId": f.project,
        "title": "Water plants",
        "statusId": f.status_named("In Progress"),
        "dueDate": "2026-03-10",
        "repeatConfig": {
            "frequency": "daily", "interval": 1, "endType": "never",
            "completedCount": 0, "createdAt": "2026-03-01T00:00:00.000Z"
        }
    }))
    .unwrap();
    let id = f
        .service
        .create(input)
        .unwrap()
        .mutation
        .task
        .unwrap()
        .task
        .id;

    let next = f
        .complete(&id)
        .next_occurrence
        .expect("the next occurrence")
        .task;
    assert_eq!(next.status_id, Some(f.status_named("To Do")));
}
