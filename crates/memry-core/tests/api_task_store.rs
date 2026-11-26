//! Desktop's task surface ([`TaskStore`]) over a real vault: the after-commit
//! activity rows of a `fields` update.
//!
//! | Test                                              | Desktop reference                      |
//! | ------------------------------------------------- | -------------------------------------- |
//! | a `fields` update logs one plain row per entry    | `fieldRows` (`activity-log.test.ts`)   |
//! | reads run on the pooled readers                   | `createTasksQueries`                   |

#[allow(unused_imports)]
use crate::http_fakes;

use std::sync::Arc;

use http_fakes::FakeSecureStore;
use memry_core::api::projects::ProjectDraft;
use memry_core::api::task_store::TaskStore;
use memry_core::api::tasks::Tasks;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::domain::calendar::LocalDateTime;
use memry_core::domain::tasks::TaskPatch;
use memry_core::domain::tasks::list::ListQuery;
use memry_core::domain::tasks::stats::TaskStats;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use serde_json::{Map, Value, json};

/// A vault with one project holding one task titled "Plan", due `due`.
fn one_task(due: Option<&str>) -> (Vault, Arc<Tasks>, TaskStore, String) {
    let dir = tempfile::Builder::new()
        .prefix("memry-api-task-store-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    let (_public, secret) = sodium::sign_seed_keypair(&[3u8; 32]).expect("a keypair");
    let store: Arc<dyn SecureStore> = FakeSecureStore::new();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");
    let tasks = vault.tasks(store.clone()).expect("the task surface");
    let task_store = vault.task_store(&store).expect("the task store");
    let project = tasks
        .create_project(ProjectDraft {
            name: "Fields".to_string(),
            description: None,
            color: None,
            icon: None,
            statuses: None,
        })
        .expect("create project");
    let id = tasks
        .create(NewTaskInput {
            title: "Plan".to_string(),
            project_id: project,
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
            linked_note_ids: Vec::new(),
            linked_canvas_ids: Vec::new(),
            source_note_id: None,
            position: None,
        })
        .expect("create")
        .created[0]
        .clone();
    (vault, tasks, task_store, id)
}

#[test]
fn a_fields_update_logs_one_plain_row_per_changed_entry() {
    let (_vault, tasks, task_store, id) = one_task(None);
    let now = LocalDateTime::parse("2026-01-14T12:00:00").expect("a local instant");
    let patch = |pairs: &[(&str, Value)]| TaskPatch {
        fields: Some(
            pairs
                .iter()
                .map(|(name, value)| ((*name).to_owned(), value.clone()))
                .collect::<Map<String, Value>>(),
        ),
        ..TaskPatch::default()
    };
    let rows = || -> Vec<(Option<String>, Option<String>, Option<String>)> {
        let mut rows: Vec<_> = tasks
            .activity(id.clone(), vec!["updated".to_string()], 50, 0)
            .expect("activity")
            .entries
            .into_iter()
            .map(|entry| (entry.field, entry.old_value, entry.new_value))
            .collect();
        rows.sort();
        rows
    };

    task_store
        .update(id.clone(), patch(&[("Owner", json!("Ahmet"))]), now, true)
        .expect("update")
        .expect("not refused");
    task_store
        .update(
            id.clone(),
            patch(&[("Owner", json!("Deniz")), ("Effort", json!(3))]),
            now,
            true,
        )
        .expect("update")
        .expect("not refused");
    assert_eq!(
        rows(),
        [
            (Some("fields.Effort".into()), None, Some("3".into())),
            (Some("fields.Owner".into()), None, Some("\"Ahmet\"".into())),
            (
                Some("fields.Owner".into()),
                Some("\"Ahmet\"".into()),
                Some("\"Deniz\"".into())
            ),
        ]
    );
}

#[test]
fn reads_run_on_the_pooled_readers_and_see_the_last_commit() {
    let (_vault, _tasks, task_store, id) = one_task(Some("2026-01-14"));
    let now = LocalDateTime::parse("2026-01-14T12:00:00").expect("a local instant");

    let page = task_store.list(&ListQuery::default()).expect("list");
    assert_eq!(page.tasks.len(), 1);
    assert_eq!(page.tasks[0].task.id, id);
    assert_eq!(
        task_store.get(&id).expect("get").expect("live").task.title,
        "Plan"
    );
    assert!(task_store.subtasks(&id).expect("subtasks").is_empty());
    assert!(task_store.tag_counts().expect("tags").is_empty());
    assert_eq!(
        task_store.stats(now).expect("stats"),
        TaskStats {
            total: 1,
            completed: 0,
            overdue: 0,
            due_today: 1,
            due_this_week: 1
        }
    );
    assert_eq!(task_store.today(now).expect("today").len(), 1);
    assert_eq!(task_store.upcoming(now, 7).expect("upcoming").len(), 1);
    assert!(task_store.overdue(now).expect("overdue").is_empty());
}
