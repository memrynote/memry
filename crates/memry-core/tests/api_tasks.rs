//! The exported task surface end to end (spec 004 TP029): `Vault::tasks`
//! over real SQLite, real clocks and the real outbox.
//!
//! | Test                                                      | Rule              |
//! | --------------------------------------------------------- | ----------------- |
//! | create, edit, complete and undo through the API           | TP028             |
//! | a repeating task rolls and its undo removes the next one  | D3                |
//! | an older desktop's task (missing fields) reads and edits  | D7, 13 §13.3      |
//! | a newer desktop's unknown fields survive a local edit     | D7, 13 §13.2      |
//! | the view answers tabs, counts and done like desktop       | D4                |
//! | projects, saved filters and settings round-trip           | D2, TP022, TP023  |
//! | quick add and date parsing cross the FFI                  | D1                |
//! | undoing a delete brings the task and subtasks back        | TP051             |

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use http_fakes::FakeSecureStore;
use memry_core::api::projects::ProjectDraft;
use memry_core::api::task_extras::{parse_task_date, repeat_preview};
use memry_core::api::task_records::RepeatRule;
use memry_core::api::tasks::{TaskViewQuery, Tasks};
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use serde_json::{Value, json};

static SCRATCH: AtomicU64 = AtomicU64::new(0);
const NOW: &str = "2026-01-14T12:00:00";

fn vault() -> Vault {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf =
        std::env::temp_dir().join(format!("memry-api-tasks-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open")
}

fn tasks(vault: &Vault) -> Arc<Tasks> {
    let (_public, secret) = sodium::sign_seed_keypair(&[3u8; 32]).expect("a keypair");
    let store = FakeSecureStore::new();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");
    vault.tasks(store).expect("the task surface")
}

fn input(title: &str, project: &str) -> NewTaskInput {
    NewTaskInput {
        title: title.to_string(),
        project_id: project.to_string(),
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
    }
}

fn project(tasks: &Tasks, name: &str) -> String {
    tasks
        .create_project(ProjectDraft {
            name: name.to_string(),
            description: None,
            color: None,
            icon: None,
            statuses: None,
        })
        .expect("create project")
}

/// Applies a record as a pull would, from a peer.
fn inbound(vault: &Vault, item_type: &str, id: &str, payload: Value) {
    let db = vault_db(vault);
    let payload = payload.to_string();
    let (item_type, id) = (item_type.to_string(), id.to_string());
    db.call_blocking(move |conn| {
        sync_items::apply_remote(
            conn,
            &InboundRecord {
                item_type,
                item_id: id,
                payload_json: payload,
                server_cursor: None,
                signer_device_id: None,
                updated_at: 1,
                deleted_at: None,
            },
            1,
        )?;
        Ok(())
    })
    .expect("apply");
}

fn vault_db(vault: &Vault) -> memry_core::storage::Db {
    vault.db_handle()
}

fn stored_payload(vault: &Vault, id: &str) -> Value {
    let id = id.to_string();
    vault_db(vault)
        .call_blocking(move |conn| {
            Ok(sync_items::load(conn, "task", &id)?
                .and_then(|row| row.payload)
                .map(|raw| serde_json::from_str::<Value>(&raw).expect("json"))
                .unwrap_or(Value::Null))
        })
        .expect("load")
}

fn query(tab: &str) -> TaskViewQuery {
    TaskViewQuery {
        tab: tab.to_string(),
        project_id: None,
        filters_json: None,
        sort_json: None,
        now: NOW.to_string(),
        week_starts_on: 1,
    }
}

#[test]
fn create_edit_complete_and_undo_through_the_api() {
    let vault = vault();
    let tasks = tasks(&vault);
    let work = project(&tasks, "Agent Test Work");

    let created = tasks.create(input("[agent] write", &work)).expect("create");
    let id = created.created[0].clone();
    let item = tasks.get(id.clone()).expect("get").expect("present");
    assert_eq!(
        item.status_id.as_deref(),
        Some(format!("{work}-todo").as_str())
    );
    assert_eq!(item.status_type.as_deref(), Some("todo"));

    let edit = tasks.set_priority(id.clone(), 3).expect("priority");
    assert_eq!(tasks.get(id.clone()).unwrap().unwrap().priority, 3);
    tasks.undo(edit).expect("undo");
    assert_eq!(tasks.get(id.clone()).unwrap().unwrap().priority, 0);

    let done = tasks
        .complete(id.clone(), NOW.to_string())
        .expect("complete");
    let item = tasks.get(id.clone()).unwrap().unwrap();
    assert!(item.is_done && item.completed_at.is_some());
    assert!(!done.repeating);
    tasks.undo(done.change).expect("undo complete");
    assert!(!tasks.get(id.clone()).unwrap().unwrap().is_done);

    let history = tasks
        .activity(id.clone(), Vec::new(), 50, 0)
        .expect("activity");
    let actions: Vec<&str> = history.entries.iter().map(|e| e.action.as_str()).collect();
    assert!(actions.contains(&"created"), "{actions:?}");
    assert!(actions.contains(&"completed"), "{actions:?}");
}

#[test]
fn a_repeating_task_rolls_and_its_undo_removes_the_next_occurrence() {
    let vault = vault();
    let tasks = tasks(&vault);
    let work = project(&tasks, "Agent Test Repeat");
    let mut new = input("[agent] daily", &work);
    new.due_date = Some("2026-01-14".into());
    new.repeat = Some(RepeatRule {
        frequency: "daily".into(),
        interval: 1,
        days_of_week: None,
        monthly_type: None,
        day_of_month: None,
        week_of_month: None,
        day_of_week_for_month: None,
        end_type: "never".into(),
        end_date: None,
        end_count: None,
        completed_count: 0,
        created_at: None,
    });
    let id = tasks.create(new).expect("create").created[0].clone();
    assert!(stored_payload(&vault, &id)["repeatConfig"]["createdAt"].is_string());

    let done = tasks
        .complete(id.clone(), NOW.to_string())
        .expect("complete");
    assert!(done.repeating);
    assert_eq!(done.next_due_date.as_deref(), Some("2026-01-15"));
    let next = done.next_task_id.clone().expect("a next occurrence");
    assert_eq!(
        stored_payload(&vault, &next)["repeatConfig"]["completedCount"],
        json!(1)
    );
    assert!(stored_payload(&vault, &id)["repeatConfig"].is_null());

    tasks.undo(done.change).expect("undo");
    assert!(
        tasks.get(next).expect("get").is_none(),
        "the next one is gone"
    );
    assert!(tasks.get(id).unwrap().unwrap().is_repeating);
}

#[test]
fn an_older_desktops_task_with_missing_fields_reads_and_edits() {
    let vault = vault();
    let tasks = tasks(&vault);
    inbound(
        &vault,
        "project",
        "p-old",
        json!({"name": "Old", "color": "#111111", "statuses": [
            {"id": "p-old-todo", "name": "To Do", "color": "#6b7280", "position": 0, "isDefault": true},
            {"id": "p-old-done", "name": "Done", "color": "#22c55e", "position": 1, "isDone": true}
        ], "clock": {"desktop": 1}}),
    );
    // No statusId, no priority, no position, no fieldClocks: what an older
    // build sends.
    inbound(
        &vault,
        "task",
        "t-old",
        json!({"title": "From an old desktop", "projectId": "p-old", "clock": {"desktop": 1}}),
    );
    let item = tasks.get("t-old".into()).unwrap().expect("reads");
    assert_eq!(item.priority, 0);
    assert!(item.status_id.is_none() && !item.is_done);
    tasks
        .set_title("t-old".into(), "Retitled on the phone".into())
        .expect("edit");
    let payload = stored_payload(&vault, "t-old");
    assert_eq!(payload["title"], json!("Retitled on the phone"));
    assert!(payload["fieldClocks"]["title"].is_object());
}

#[test]
fn a_newer_desktops_unknown_fields_survive_a_local_edit() {
    let vault = vault();
    let tasks = tasks(&vault);
    let work = project(&tasks, "Agent Test New");
    inbound(
        &vault,
        "task",
        "t-new",
        json!({"title": "From a newer desktop", "projectId": work, "priority": 2,
               "futureField": {"x": 1},
               "repeatConfig": {"frequency": "weekly", "interval": 1, "endType": "never",
                                "completedCount": 0, "createdAt": "2026-01-01T00:00:00.000Z",
                                "futureRepeatKey": true},
               "clock": {"desktop": 2}}),
    );
    tasks.set_priority("t-new".into(), 4).expect("edit");
    tasks
        .set_repeat(
            "t-new".into(),
            tasks.get("t-new".into()).unwrap().unwrap().repeat,
            Some("completion".into()),
        )
        .expect("repeat edit");
    let payload = stored_payload(&vault, "t-new");
    assert_eq!(payload["futureField"], json!({"x": 1}));
    assert_eq!(payload["priority"], json!(4));
    assert_eq!(payload["repeatConfig"]["futureRepeatKey"], json!(true));
    assert_eq!(payload["repeatFrom"], json!("completion"));
}

#[test]
fn the_view_answers_tabs_counts_and_done_like_desktop() {
    let vault = vault();
    let tasks = tasks(&vault);
    let work = project(&tasks, "Agent Test View");
    let mut overdue = input("[agent] overdue", &work);
    overdue.due_date = Some("2026-01-10".into());
    let mut today = input("[agent] today", &work);
    today.due_date = Some("2026-01-14".into());
    let mut tomorrow = input("[agent] tomorrow", &work);
    tomorrow.due_date = Some("2026-01-15".into());
    let overdue = tasks.create(overdue).unwrap().created[0].clone();
    let today = tasks.create(today).unwrap().created[0].clone();
    let tomorrow = tasks.create(tomorrow).unwrap().created[0].clone();
    tasks.create(input("[agent] undated", &work)).unwrap();

    let view = tasks.view(query("today")).expect("today");
    assert_eq!(view.task_ids, vec![overdue.clone(), today.clone()]);
    assert_eq!(view.counts.all, 4);
    assert_eq!(view.counts.today, 2);
    assert_eq!(view.counts.tomorrow, 1);
    assert_eq!(view.counts.next7, 3);
    assert_eq!(
        tasks.view(query("tomorrow")).unwrap().task_ids,
        vec![tomorrow]
    );

    tasks.complete(today.clone(), NOW.to_string()).unwrap();
    let all = tasks.view(query("all")).unwrap();
    assert!(!all.task_ids.contains(&today));
    assert!(all.done_ids.contains(&today));
    let labels: Vec<Option<String>> = all.groups.iter().map(|g| g.label_key.clone()).collect();
    assert!(
        labels.contains(&Some("dueDate.overdue".into())),
        "{labels:?}"
    );

    tasks.bulk_archive(vec![overdue.clone()]).unwrap();
    assert_eq!(
        tasks.view(query("archived")).unwrap().task_ids,
        vec![overdue]
    );
}

#[test]
fn projects_saved_filters_and_settings_round_trip() {
    let vault = vault();
    let tasks = tasks(&vault);
    let id = project(&tasks, "Agent Test Hub");
    let listed = tasks.projects(false).unwrap();
    let made = listed.iter().find(|p| p.id == id).expect("listed");
    assert_eq!(made.statuses.len(), 3);
    assert_eq!(made.statuses[1].status_type, "in_progress");

    tasks.set_project_archived(id.clone(), true).unwrap();
    assert!(tasks.projects(false).unwrap().iter().all(|p| p.id != id));

    let filter = tasks
        .create_saved_filter(
            "[agent] high".into(),
            json!({"filters": {"priorities": ["high"]}}).to_string(),
        )
        .unwrap();
    tasks
        .set_saved_filter_starred(filter.clone(), true)
        .unwrap();
    let saved = tasks.saved_filters().unwrap();
    assert!(saved.iter().any(|f| f.id == filter && f.starred));

    let settings = tasks.set_default_view("next7".into()).unwrap();
    assert_eq!(settings.default_view, "next7");
    assert_eq!(tasks.task_settings().unwrap().default_sort_order, "manual");
}

#[test]
fn quick_add_and_date_parsing_cross_the_ffi() {
    let vault = vault();
    let tasks = tasks(&vault);
    project(&tasks, "Work");
    let parsed = tasks
        .parse_quick_add(
            "[agent] meeting @may 17 3pm !high #test +work".into(),
            NOW.into(),
        )
        .unwrap();
    assert_eq!(parsed.title, "[agent] meeting");
    assert_eq!(parsed.due_date.as_deref(), Some("2026-05-17"));
    assert_eq!(parsed.due_time.as_deref(), Some("15:00"));
    assert_eq!(parsed.priority, 3);
    assert_eq!(parsed.tags, vec!["test".to_string()]);
    assert!(parsed.project_id.is_some());
    assert!(parsed.spans.iter().any(|s| s.kind == "datePhrase"));

    let date = parse_task_date("next friday".into(), NOW.into()).expect("a date");
    assert_eq!(date.date, "2026-01-16");
    let rule = RepeatRule {
        frequency: "weekly".into(),
        interval: 1,
        days_of_week: Some(vec![1, 3]),
        monthly_type: None,
        day_of_month: None,
        week_of_month: None,
        day_of_week_for_month: None,
        end_type: "never".into(),
        end_date: None,
        end_count: None,
        completed_count: 0,
        created_at: None,
    };
    assert_eq!(
        repeat_preview(rule, "2026-01-14".into(), 3),
        vec!["2026-01-14", "2026-01-19", "2026-01-21"]
    );
}

#[test]
fn undoing_a_delete_brings_the_task_and_its_subtasks_back() {
    let vault = vault();
    let tasks = tasks(&vault);
    let work = project(&tasks, "Agent Test Undo");
    inbound(
        &vault,
        "task",
        "t-parent",
        json!({"title": "[agent] parent", "projectId": work, "priority": 3,
               "tags": ["keep"], "futureField": 7, "clock": {"desktop": 1}}),
    );
    let mut child = input("[agent] child", &work);
    child.parent_id = Some("t-parent".into());
    tasks.create(child).expect("child");

    let removed = tasks.delete("t-parent".into(), false).expect("delete");
    assert_eq!(removed.deleted.len(), 2);
    assert!(tasks.all().expect("all").is_empty());

    let back = tasks.undo(removed).expect("undo");
    assert_eq!(back.created.len(), 2);
    let all = tasks.all().expect("all");
    let parent = all
        .iter()
        .find(|t| t.title == "[agent] parent")
        .expect("parent back");
    let child = all
        .iter()
        .find(|t| t.title == "[agent] child")
        .expect("child back");
    assert_ne!(parent.id, "t-parent", "a tombstoned id is never reused");
    assert_eq!(parent.priority, 3);
    assert_eq!(parent.tags, ["keep"]);
    assert_eq!(child.parent_id.as_deref(), Some(parent.id.as_str()));
    assert_eq!(stored_payload(&vault, &parent.id)["futureField"], json!(7));

    tasks.undo(back).expect("undo the undo");
    assert!(tasks.all().expect("all").is_empty());
}
