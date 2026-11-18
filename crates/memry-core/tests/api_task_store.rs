//! Desktop's task surface ([`TaskStore`]) over a real vault: the after-commit
//! activity rows of a `fields` update.
//!
//! | Test                                              | Desktop reference                      |
//! | ------------------------------------------------- | -------------------------------------- |
//! | a `fields` update logs one plain row per entry    | `fieldRows` (`activity-log.test.ts`)   |

#[allow(unused_imports)]
use crate::http_fakes;

use std::sync::Arc;

use http_fakes::FakeSecureStore;
use memry_core::api::projects::ProjectDraft;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::domain::calendar::LocalDateTime;
use memry_core::domain::tasks::TaskPatch;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use serde_json::{Map, Value, json};

#[test]
fn a_fields_update_logs_one_plain_row_per_changed_entry() {
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
            due_date: None,
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
