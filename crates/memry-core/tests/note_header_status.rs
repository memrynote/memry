//! A note's header status follows the tasks in its body (#3176).
//!
//! Real SQLite, a real CRDT body, and task writes through the exported task
//! surface (`Vault::tasks`), so the status the tasks imply is written into the
//! note's property by the same funnel iOS writes tasks through. A user's own
//! pick is an ordinary property write and stays until a task changes again.
//!
//! | Test                                                   | Rule                                  |
//! | ------------------------------------------------------ | ------------------------------------- |
//! | all to-do, in progress, all done write the status      | `note-status.ts` `deriveStatusCategory` |
//! | a status the user picked stays, then a task overwrites | last writer wins                      |
//! | a title edit is no status change                       | a pick is not clobbered by noise      |
//! | a done task moved back to In Progress is in progress   | status wins over a stale completedAt  |
//! | a status named Status follows the tasks too            | the picker names a new one `Status`   |
//! | a note without tasks, or another type, is left alone   | the stored value stands               |

mod http_fakes;

use std::sync::Arc;

use http_fakes::FakeSecureStore;
use memry_core::api::errors::StorageError;
use memry_core::api::projects::ProjectDraft;
use memry_core::api::tasks::Tasks;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::api::vault::Vault;
use memry_core::crdt::update_log;
use memry_core::crypto::sodium;
use memry_core::domain::notes::{self, NewNote};
use memry_core::domain::properties;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::storage::Db;
use rusqlite::Connection;
use serde_json::{Map, Value, json};
use yrs::{Any, Doc, ReadTxn as _, Transact as _, Xml as _, XmlElementPrelim, XmlFragment as _};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";
const NOTE: &str = "note-1";
const LOCAL_NOW: &str = "2026-01-14T12:00:00";

struct World {
    vault: Vault,
    tasks: Arc<Tasks>,
    project: String,
}

fn world() -> World {
    let dir = tempfile::Builder::new()
        .prefix("memry-header-status-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    let (_public, secret) = sodium::sign_seed_keypair(&[3u8; 32]).expect("a keypair");
    let store = FakeSecureStore::new();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");
    let tasks = vault.tasks(store).expect("the task surface");
    let project = tasks
        .create_project(ProjectDraft {
            name: "P".to_string(),
            description: None,
            color: None,
            icon: None,
            statuses: None,
        })
        .expect("create project");
    World {
        vault,
        tasks,
        project,
    }
}

impl World {
    fn db(&self) -> Db {
        self.vault.db_handle()
    }

    /// A task sourced from the note, as one the editor makes is.
    fn task(&self, title: &str) -> String {
        let change = self
            .tasks
            .create(NewTaskInput {
                title: title.to_string(),
                project_id: self.project.clone(),
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
                source_note_id: Some(NOTE.to_string()),
                position: None,
            })
            .expect("create task");
        change.created[0].clone()
    }

    fn status(&self, kind: &str) -> String {
        format!("{}-{kind}", self.project)
    }

    /// A note whose body holds `task_ids`, with `name` declared as `type_name`.
    fn note(&self, name: &str, stored: Option<&str>, type_name: &str, task_ids: &[String]) {
        let ids: Vec<String> = task_ids.to_vec();
        let (name, type_name) = (name.to_string(), type_name.to_string());
        let stored = stored.map(str::to_owned);
        self.db()
            .call_blocking(move |conn: &mut Connection| {
                let mut properties = Map::new();
                if let Some(stored) = stored {
                    properties.insert(name.clone(), json!(stored));
                }
                notes::create(
                    conn,
                    &NewNote {
                        id: NOTE,
                        title: "Plan",
                        folder_path: None,
                        content: "",
                        tags: &[],
                        properties: Some(&properties),
                        emoji: None,
                    },
                    DEVICE,
                    NOW,
                )?;
                conn.execute(
                    "INSERT INTO property_definitions (name, type, options, default_value, color) \
                     VALUES (?1, ?2, NULL, NULL, NULL)",
                    [&name, &type_name],
                )
                .expect("the definition");
                update_log::append_server_update(conn, NOTE, 1, &body(&ids), NOW)
                    .expect("seed the body");
                Ok(())
            })
            .expect("the note");
    }

    fn stored(&self, name: &str) -> Option<String> {
        let name = name.to_string();
        self.db()
            .call_blocking(move |conn: &mut Connection| {
                properties::values(conn, notes::ITEM_TYPE, NOTE)
            })
            .expect("the payload")
            .get(&name)
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    /// The user picking a value in the property row.
    fn pick(&self, name: &str, value: &str) {
        let (name, value) = (name.to_string(), value.to_string());
        self.db()
            .call_blocking(move |conn: &mut Connection| {
                properties::set(
                    conn,
                    notes::ITEM_TYPE,
                    NOTE,
                    &name,
                    json!(value),
                    DEVICE,
                    NOW,
                )
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
            })
            .expect("the pick");
    }
}

/// A body holding one `taskBlock` per id.
fn body(task_ids: &[String]) -> Vec<u8> {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut txn = doc.transact_mut();
    let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
    for (index, task_id) in task_ids.iter().enumerate() {
        let container = group.insert(
            &mut txn,
            index as u32,
            XmlElementPrelim::empty("blockContainer"),
        );
        container.insert_attribute(&mut txn, "id", format!("b{index}"));
        let block = container.insert(&mut txn, 0, XmlElementPrelim::empty("taskBlock"));
        block.insert_attribute(&mut txn, "checked", Any::Bool(false));
        block.insert_attribute(&mut txn, "parentTaskId", Any::String("".into()));
        block.insert_attribute(&mut txn, "taskId", Any::String(task_id.as_str().into()));
        block.insert_attribute(&mut txn, "title", Any::String(task_id.as_str().into()));
    }
    txn.encode_state_as_update_v1(&yrs::StateVector::default())
}

#[test]
fn a_task_write_puts_the_status_the_tasks_imply_into_the_note() {
    let w = world();
    let (a, b) = (w.task("A"), w.task("B"));
    w.note(
        "status",
        Some("Abandoned"),
        "status",
        &[a.clone(), b.clone()],
    );

    w.tasks.complete(a.clone(), LOCAL_NOW.to_string()).unwrap();
    assert_eq!(w.stored("status").as_deref(), Some("In Progress"));

    w.tasks.complete(b.clone(), LOCAL_NOW.to_string()).unwrap();
    assert_eq!(w.stored("status").as_deref(), Some("Done"));

    w.tasks.uncomplete(a.clone()).unwrap();
    assert_eq!(w.stored("status").as_deref(), Some("In Progress"));
    w.tasks.uncomplete(b).unwrap();
    assert_eq!(w.stored("status").as_deref(), Some("Not started"));
}

#[test]
fn a_status_the_user_picked_stays_until_a_task_changes_again() {
    let w = world();
    let (a, b) = (w.task("A"), w.task("B"));
    w.note(
        "status",
        Some("Abandoned"),
        "status",
        &[a.clone(), b.clone()],
    );
    w.tasks.complete(a.clone(), LOCAL_NOW.to_string()).unwrap();
    w.tasks.complete(b.clone(), LOCAL_NOW.to_string()).unwrap();

    w.pick("status", "In Progress");
    assert_eq!(w.stored("status").as_deref(), Some("In Progress"));

    w.tasks.set_title(a.clone(), "Renamed".into()).unwrap();
    assert_eq!(
        w.stored("status").as_deref(),
        Some("In Progress"),
        "a title edit is no status change"
    );

    w.tasks.uncomplete(b.clone()).unwrap();
    w.tasks.complete(b, LOCAL_NOW.to_string()).unwrap();
    assert_eq!(
        w.stored("status").as_deref(),
        Some("Done"),
        "a task change writes over the pick"
    );
}

#[test]
fn a_done_task_moved_back_to_in_progress_reads_as_in_progress() {
    let w = world();
    let (a, b) = (w.task("A"), w.task("B"));
    w.note(
        "status",
        Some("Abandoned"),
        "status",
        &[a.clone(), b.clone()],
    );
    w.tasks.complete(a.clone(), LOCAL_NOW.to_string()).unwrap();
    w.tasks.complete(b, LOCAL_NOW.to_string()).unwrap();
    assert_eq!(w.stored("status").as_deref(), Some("Done"));

    w.tasks.set_status(a, w.status("in-progress")).unwrap();
    assert_eq!(w.stored("status").as_deref(), Some("In Progress"));
}

#[test]
fn deleting_a_task_refreshes_the_note_it_came_from() {
    let w = world();
    let (a, b) = (w.task("A"), w.task("B"));
    w.note(
        "status",
        Some("Not started"),
        "status",
        &[a.clone(), b.clone()],
    );
    w.tasks.complete(a, LOCAL_NOW.to_string()).unwrap();
    assert_eq!(w.stored("status").as_deref(), Some("In Progress"));

    w.tasks.delete(b, false).unwrap();
    assert_eq!(w.stored("status").as_deref(), Some("Done"));
}

#[test]
fn a_status_property_the_picker_named_status_follows_the_tasks_too() {
    let w = world();
    let a = w.task("A");
    w.note(
        "Status",
        Some("Not started"),
        "status",
        std::slice::from_ref(&a),
    );
    w.tasks.complete(a, LOCAL_NOW.to_string()).unwrap();
    assert_eq!(w.stored("Status").as_deref(), Some("Done"));
}

#[test]
fn a_property_of_another_type_or_a_note_without_the_property_is_left_alone() {
    let w = world();
    let a = w.task("A");
    w.note("status", Some("Open"), "select", std::slice::from_ref(&a));
    w.tasks.complete(a, LOCAL_NOW.to_string()).unwrap();
    assert_eq!(w.stored("status").as_deref(), Some("Open"));

    let other = world();
    let b = other.task("B");
    other.note("status", None, "status", std::slice::from_ref(&b));
    other.tasks.complete(b, LOCAL_NOW.to_string()).unwrap();
    assert_eq!(other.stored("status"), None);
}
