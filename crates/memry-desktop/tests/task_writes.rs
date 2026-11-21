//! The task writes of `TasksService` over a real vault in a temp dir: Electron's refusal keys
//! with nothing queued, the recurrence roll on complete, bulk writes as one transaction, the
//! outbox rows the sync push reads, and the events in `publisher.ts`'s order.

use memry_desktop::tasks::service::TaskEvent;
use memry_desktop::tasks::write_contract::{
    BulkIdsInput, BulkMoveInput, ConvertToSubtaskInput, TaskActivityListInput, TaskCompleteInput,
    TaskCreateInput, TaskMoveInput, TaskReorderInput,
};
use memry_desktop::tasks::{MOVE_MANY_FAILED, REORDER_FAILED, TASK_NOT_FOUND};
use serde_json::json;

use crate::tasks_service::{Fixture, draft};

fn create(project: &str, extra: serde_json::Value) -> TaskCreateInput {
    let mut input = json!({ "projectId": project, "title": "Plan" });
    input
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(input).unwrap()
}

fn moved(input: serde_json::Value) -> TaskMoveInput {
    serde_json::from_value(input).unwrap()
}

fn ids(ids: &[&str]) -> BulkIdsInput {
    BulkIdsInput {
        ids: ids.iter().map(|id| (*id).to_owned()).collect(),
    }
}

impl Fixture {
    fn status(&self, project: &str, done: bool) -> String {
        self.service
            .statuses(project)
            .unwrap()
            .into_iter()
            .find(|status| status.is_done == done)
            .unwrap()
            .id
    }

    fn view(&self, id: &str) -> memry_desktop::tasks::contract::TaskView {
        self.service.get(id).unwrap().expect("live task").task
    }

    fn subtask(&self, parent: &str) -> String {
        let input = create(
            &self.project,
            json!({ "title": "Step", "parentId": parent }),
        );
        let written = self.service.create(input).unwrap();
        written.mutation.task.unwrap().task.id
    }

    fn daily(&self, title: &str) -> String {
        let input = create(
            &self.project,
            json!({
                "title": title,
                "dueDate": "2026-03-10",
                "repeatConfig": {
                    "frequency": "daily", "interval": 1, "endType": "never",
                    "completedCount": 0, "createdAt": "2026-03-01T00:00:00.000Z"
                }
            }),
        );
        self.service
            .create(input)
            .unwrap()
            .mutation
            .task
            .unwrap()
            .task
            .id
    }
}

#[test]
fn tasks_create_lands_the_task_queues_its_push_and_announces_it_with_its_tags() {
    let f = Fixture::new();
    let written = f
        .service
        .create(create(
            &f.project,
            json!({ "tags": ["home"], "priority": 2 }),
        ))
        .unwrap();

    let task = written.mutation.task.expect("the created task").task;
    assert!(written.mutation.success);
    assert_eq!((task.title.as_str(), task.priority), ("Plan", 2));
    assert_eq!(task.tags, ["home"]);
    assert_eq!(
        written.events,
        [TaskEvent::Created(task.id.clone()), TaskEvent::TagsChanged]
    );
    assert_eq!(f.outbox(&task.id), 1, "one row for the push");
}

#[test]
fn tasks_create_refuses_with_electrons_keys_and_writes_nothing() {
    let f = Fixture::new();
    let parent = f.task("Parent", None, &[]);
    let child = f.subtask(&parent);
    f.nested_subtasks(false);
    f.pushed();

    for (extra, key) in [
        (
            json!({ "projectId": "no-such-project" }),
            "errors:task.projectMissing",
        ),
        (
            json!({ "parentId": "no-such-task" }),
            "errors:task.invalidParent",
        ),
        (json!({ "parentId": child }), "errors:task.invalidParent"),
    ] {
        let written = f.service.create(create(&f.project, extra)).unwrap();
        assert_eq!(written.mutation.error.as_deref(), Some(key));
        assert!(
            !written.mutation.success && written.events.is_empty(),
            "{key}"
        );
    }
    let count = f
        .vault
        .db_handle()
        .read_blocking(|conn| {
            Ok(conn
                .query_row("SELECT COUNT(*) FROM outbox", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap())
        })
        .unwrap();
    assert_eq!(count, 0, "a refusal queues nothing");
    assert!(
        f.service
            .create(create(&f.project, json!({ "title": "" })))
            .is_err(),
        "TaskCreateSchema's title bound"
    );
}

#[test]
fn tasks_complete_rolls_a_repeating_task_and_leaves_its_subtasks_open() {
    let f = Fixture::new();
    let id = f.daily("Water plants");
    let step = f.subtask(&id);

    let written = f
        .service
        .complete(TaskCompleteInput {
            id: id.clone(),
            ..TaskCompleteInput::default()
        })
        .unwrap();

    let next = written
        .mutation
        .next_occurrence
        .expect("the next occurrence")
        .task;
    assert_eq!(next.due_date.as_deref(), Some("2026-03-11"));
    assert_eq!(
        written.events,
        [
            TaskEvent::Completed(id.clone()),
            TaskEvent::Created(next.id)
        ]
    );
    let done = f.view(&id);
    assert!(done.completed_at.is_some());
    assert_eq!(done.status_id, Some(f.status(&f.project, true)));
    assert_eq!(
        f.view(&step).completed_at,
        None,
        "tasks:complete does not cascade"
    );
}

#[test]
fn tasks_complete_record_only_keeps_the_series_and_stamps_the_given_time() {
    let f = Fixture::new();
    let id = f.daily("Water plants");
    let at = "2026-03-09T18:00:00.000Z";

    let written = f
        .service
        .complete(TaskCompleteInput {
            id: id.clone(),
            completed_at: Some(at.to_owned()),
            record_only: Some(true),
        })
        .unwrap();

    assert_eq!(written.mutation.next_occurrence, None);
    assert_eq!(written.events, [TaskEvent::Completed(id.clone())]);
    assert_eq!(f.view(&id).completed_at.as_deref(), Some(at));

    let missing = f
        .service
        .complete(TaskCompleteInput {
            id: "missing".to_owned(),
            ..TaskCompleteInput::default()
        })
        .unwrap();
    assert_eq!(missing.mutation.error.as_deref(), Some(TASK_NOT_FOUND));
    assert!(missing.events.is_empty());
    let bad = TaskCompleteInput {
        id,
        completed_at: Some("yesterday".to_owned()),
        record_only: None,
    };
    assert!(f.service.complete(bad).is_err(), "z.iso.datetime()");
}

#[test]
fn uncomplete_archive_and_unarchive_announce_an_update_or_refuse_a_missing_task() {
    let f = Fixture::new();
    let id = f.task("Plan", None, &[]);
    f.service
        .complete(TaskCompleteInput {
            id: id.clone(),
            ..TaskCompleteInput::default()
        })
        .unwrap();

    let reopened = f.service.uncomplete(&id).unwrap();
    assert_eq!(reopened.events, [TaskEvent::Updated(id.clone())]);
    assert_eq!(f.view(&id).completed_at, None);
    assert_eq!(f.view(&id).status_id, Some(f.status(&f.project, false)));

    let archived = f.service.set_archived(&id, true).unwrap();
    assert!(archived.mutation.success);
    assert!(f.view(&id).archived_at.is_some());
    f.service.set_archived(&id, false).unwrap();
    assert_eq!(f.view(&id).archived_at, None);

    assert_eq!(
        f.service
            .uncomplete("missing")
            .unwrap()
            .mutation
            .error
            .as_deref(),
        Some(TASK_NOT_FOUND)
    );
    let missing = f.service.set_archived("missing", true).unwrap();
    assert_eq!(missing.mutation.error.as_deref(), Some(TASK_NOT_FOUND));
    assert!(missing.events.is_empty());
}

#[test]
fn tasks_delete_takes_the_subtasks_and_announces_each_deepest_first() {
    let f = Fixture::new();
    let parent = f.task("Parent", None, &[]);
    let child = f.subtask(&parent);
    f.pushed();

    let written = f.service.delete(&parent).unwrap();

    assert!(written.mutation.success);
    assert_eq!(
        written.events,
        [
            TaskEvent::Deleted(child.clone()),
            TaskEvent::Deleted(parent.clone())
        ]
    );
    assert!(f.service.get(&child).unwrap().is_none());
    assert_eq!(
        (f.outbox(&parent), f.outbox(&child)),
        (1, 1),
        "a tombstone each"
    );
    let gone = f.service.delete("missing").unwrap();
    assert!(
        gone.mutation.success,
        "Electron's deleteTask succeeds on a missing id"
    );
    assert_eq!(gone.events, [TaskEvent::Deleted("missing".to_owned())]);
}

#[test]
fn tasks_move_keeps_a_named_status_and_takes_the_equivalent_one_otherwise() {
    let f = Fixture::new();
    let home = f.tasks.create_project(draft("Home")).unwrap();
    let home_done = f.status(&home, true);
    let a = f.task("A", None, &[]);
    let b = f.task("B", None, &[]);

    let named = f
        .service
        .move_task(moved(json!({
            "taskId": a, "targetProjectId": home, "targetStatusId": home_done, "position": 3
        })))
        .unwrap();
    let a_view = f.view(&a);
    assert_eq!(named.events, [TaskEvent::Moved(a.clone())]);
    assert_eq!(a_view.project_id, home);
    assert_eq!(
        a_view.status_id.as_ref(),
        Some(&home_done),
        "the named status wins"
    );
    assert!(
        a_view.completed_at.is_some(),
        "a done column completes the task"
    );
    assert_eq!(a_view.position, 3);

    f.service
        .move_task(moved(
            json!({ "taskId": b, "targetProjectId": home, "position": 0 }),
        ))
        .unwrap();
    assert_eq!(
        f.view(&b).status_id,
        Some(f.status(&home, false)),
        "equivalent todo"
    );

    for (input, key) in [
        (
            json!({ "taskId": b, "targetProjectId": "nope", "position": 0 }),
            "errors:task.projectMissing",
        ),
        (
            json!({ "taskId": b, "targetParentId": b, "position": 0 }),
            "errors:task.invalidParent",
        ),
        (
            json!({ "taskId": "missing", "position": 0 }),
            TASK_NOT_FOUND,
        ),
    ] {
        let refused = f.service.move_task(moved(input)).unwrap();
        assert_eq!(refused.mutation.error.as_deref(), Some(key));
        assert!(refused.events.is_empty(), "{key}");
    }
}

#[test]
fn tasks_move_into_a_done_status_rolls_a_repeating_task() {
    let f = Fixture::new();
    let id = f.daily("Water plants");
    let done = f.status(&f.project, true);

    let written = f
        .service
        .move_task(moved(
            json!({ "taskId": id, "targetStatusId": done, "position": 0 }),
        ))
        .unwrap();

    let [TaskEvent::Moved(moved_id), TaskEvent::Created(next)] = written.events.as_slice() else {
        panic!("moved, then the next occurrence: {:?}", written.events);
    };
    assert_eq!(moved_id, &id);
    assert_eq!(f.view(next).due_date.as_deref(), Some("2026-03-11"));
}

#[test]
fn tasks_reorder_refuses_lists_of_different_lengths_and_sends_no_event() {
    let f = Fixture::new();
    let a = f.task("A", None, &[]);
    f.pushed();

    let refused = f
        .service
        .reorder(TaskReorderInput {
            task_ids: vec![a.clone()],
            positions: vec![],
        })
        .unwrap();
    assert_eq!(refused.mutation.error.as_deref(), Some(REORDER_FAILED));
    assert_eq!(f.outbox(&a), 0);

    let written = f
        .service
        .reorder(TaskReorderInput {
            task_ids: vec![a.clone(), "missing".to_owned()],
            positions: vec![7, 8],
        })
        .unwrap();
    assert!(written.mutation.success && written.events.is_empty());
    assert_eq!(f.view(&a).position, 7);
}

#[test]
fn duplicate_and_the_subtask_conversions_announce_what_they_wrote() {
    let f = Fixture::new();
    let parent = f.task("Parent", None, &[]);
    f.subtask(&parent);
    let other = f.task("Other", None, &[]);

    let copy = f.service.duplicate(&parent).unwrap();
    let copy_task = copy.mutation.task.expect("the copy").task;
    assert_eq!(copy_task.title, "Copy of Parent");
    assert_eq!(copy.events.len(), 2, "the copy and its subtask's copy");
    assert_eq!(copy.events[0], TaskEvent::Created(copy_task.id));

    let input = ConvertToSubtaskInput {
        task_id: other.clone(),
        parent_id: parent.clone(),
    };
    let under = f.service.convert_to_subtask(input).unwrap();
    assert_eq!(under.events, [TaskEvent::Updated(other.clone())]);
    assert_eq!(f.view(&other).parent_id.as_ref(), Some(&parent));
    f.service.convert_to_task(&other).unwrap();
    assert_eq!(f.view(&other).parent_id, None);

    let refused = f
        .service
        .convert_to_subtask(ConvertToSubtaskInput {
            task_id: other.clone(),
            parent_id: other.clone(),
        })
        .unwrap();
    assert_eq!(
        refused.mutation.error.as_deref(),
        Some("errors:task.invalidParent")
    );
    assert_eq!(
        f.service
            .duplicate("missing")
            .unwrap()
            .mutation
            .error
            .as_deref(),
        Some(TASK_NOT_FOUND)
    );
}

#[test]
fn bulk_writes_answer_their_count_and_announce_each_selected_task() {
    let f = Fixture::new();
    let home = f.tasks.create_project(draft("Home")).unwrap();
    let a = f.task("A", None, &[]);
    let b = f.task("B", None, &[]);

    let completed = f.service.bulk_complete(ids(&[&a, &b, "missing"])).unwrap();
    assert_eq!(completed.mutation.count, 2);
    assert_eq!(
        completed.events,
        [
            TaskEvent::Completed(a.clone()),
            TaskEvent::Completed(b.clone())
        ]
    );

    let input = BulkMoveInput {
        ids: vec![a.clone()],
        project_id: home.clone(),
    };
    let moved = f.service.bulk_move(input).unwrap();
    assert_eq!(moved.events, [TaskEvent::Updated(a.clone())]);
    assert_eq!(f.view(&a).project_id, home);
    let nowhere = BulkMoveInput {
        ids: vec![b.clone()],
        project_id: "nope".to_owned(),
    };
    let refused = f.service.bulk_move(nowhere).unwrap();
    assert_eq!(refused.mutation.error.as_deref(), Some(MOVE_MANY_FAILED));
    assert!(refused.events.is_empty());

    let archived = f.service.bulk_archive(ids(&[&b])).unwrap();
    assert_eq!(archived.mutation.count, 1);
    let deleted = f.service.bulk_delete(ids(&[&a, &b])).unwrap();
    assert_eq!(deleted.mutation.count, 2);
    assert_eq!(
        deleted.events,
        [TaskEvent::Deleted(a), TaskEvent::Deleted(b)]
    );
}

#[test]
fn a_bulk_write_that_fails_midway_writes_none_of_the_selection() {
    let f = Fixture::new();
    let a = f.task("A", None, &[]);
    let b = f.task("B", None, &[]);
    f.pushed();
    let fail_on = b.clone();
    f.vault
        .db_handle()
        .call_blocking(move |conn| {
            conn.execute_batch(&format!(
                "CREATE TEMP TRIGGER fail_b BEFORE INSERT ON outbox WHEN NEW.item_id = '{fail_on}'
                 BEGIN SELECT RAISE(ABORT, 'disk full'); END;"
            ))
            .unwrap();
            Ok(())
        })
        .unwrap();

    assert!(f.service.bulk_archive(ids(&[&a, &b])).is_err());

    assert_eq!(
        f.view(&a).archived_at,
        None,
        "the first task rolled back with the second"
    );
    assert_eq!(f.outbox(&a), 0);
}

#[test]
fn tasks_get_activity_reads_the_feed_inside_the_schema_bounds() {
    let f = Fixture::new();
    let written = f.service.create(create(&f.project, json!({}))).unwrap();
    let id = written.mutation.task.unwrap().task.id;
    f.service
        .update(f.update(&id, json!({ "title": "Renamed" })))
        .unwrap();

    let input = |limit: Option<i64>| TaskActivityListInput {
        task_id: id.clone(),
        limit,
        ..TaskActivityListInput::default()
    };
    let page = f.service.activity(input(None)).unwrap();
    assert!(page.entries.len() >= 2, "created and the title edit");
    assert!(page.entries.iter().all(|entry| entry.is_this_device));
    assert!(!page.entries[0].created_at.is_empty());
    assert!(f.service.activity(input(Some(0))).is_err());
    assert!(f.service.activity(input(Some(201))).is_err());
}
