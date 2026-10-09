//! The tree the iOS list draws and its long-press moves (`Tasks::tree`,
//! `Tasks::move_under_places`) through the exported API: any depth, the own
//! branch locked, and the device-local `tasks.nestedSubtasks` gate.

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use http_fakes::FakeSecureStore;
use memry_core::api::projects::ProjectDraft;
use memry_core::api::task_tree::TaskTreeEntry;
use memry_core::api::tasks::{TaskViewQuery, Tasks};
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn vault() -> Vault {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-api-task-tree-{}-{unique}",
        std::process::id()
    ));
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

fn child(tasks: &Tasks, title: &str, project: &str, parent: &str) -> String {
    let mut new = input(title, project);
    new.parent_id = Some(parent.to_owned());
    tasks
        .create(new)
        .expect("create")
        .created
        .first()
        .cloned()
        .expect("an id")
}

fn entry<'a>(tree: &'a [TaskTreeEntry], id: &str) -> &'a TaskTreeEntry {
    tree.iter()
        .find(|entry| entry.id == id)
        .expect("in the tree")
}

#[test]
fn the_tree_offers_indent_outdent_and_adds_at_any_depth() {
    let vault = vault();
    let tasks = tasks(&vault);
    let work = project(&tasks, "Agent Test Tree");
    let root = tasks.create(input("root", &work)).expect("root").created[0].clone();
    let first = child(&tasks, "first", &work, &root);
    let second = child(&tasks, "second", &work, &root);
    let deep = child(&tasks, "deep", &work, &first);

    let tree = tasks.tree().expect("tree");
    assert_eq!(
        entry(&tree, &root).child_ids,
        [first.clone(), second.clone()]
    );
    assert_eq!(
        entry(&tree, &deep).parent_id.as_deref(),
        Some(first.as_str())
    );
    assert_eq!(
        entry(&tree, &second).indent_under.as_deref(),
        Some(first.as_str())
    );
    assert_eq!(entry(&tree, &first).indent_under, None, "nothing above it");
    assert_eq!(
        entry(&tree, &deep).outdent_to.as_deref(),
        Some(root.as_str())
    );
    assert_eq!(
        entry(&tree, &first).outdent_to,
        None,
        "top level is its own action"
    );
    assert!(entry(&tree, &deep).can_add_subtask);

    // Off: the one-level rule. Nothing may nest under a subtask.
    tasks.set_nested_subtasks(false).expect("off");
    let tree = tasks.tree().expect("tree");
    assert_eq!(entry(&tree, &second).indent_under, None);
    assert!(!entry(&tree, &first).can_add_subtask);
    assert!(entry(&tree, &root).can_add_subtask);
}

#[test]
fn move_under_lists_the_project_tree_with_the_own_branch_locked() {
    let vault = vault();
    let tasks = tasks(&vault);
    let work = project(&tasks, "Agent Test Places");
    let other = project(&tasks, "Agent Test Elsewhere");
    let root = tasks.create(input("root", &work)).expect("root").created[0].clone();
    let moving = child(&tasks, "moving", &work, &root);
    let below = child(&tasks, "below", &work, &moving);
    let sibling = child(&tasks, "sibling", &work, &root);
    tasks.create(input("elsewhere", &other)).expect("other");

    let places = tasks.move_under_places(moving.clone()).expect("places");
    let rows: Vec<(&str, u32, bool)> = places
        .iter()
        .map(|place| (place.task_id.as_str(), place.depth, place.allowed))
        .collect();
    assert_eq!(
        rows,
        [
            (root.as_str(), 0, true),
            (moving.as_str(), 1, false),
            (below.as_str(), 2, false),
            (sibling.as_str(), 1, true),
        ]
    );
    assert_eq!(places[2].path_ids, [root.clone(), moving.clone()]);

    tasks.set_nested_subtasks(false).expect("off");
    let allowed: Vec<bool> = tasks
        .move_under_places(below)
        .expect("places")
        .iter()
        .map(|place| place.allowed)
        .collect();
    assert_eq!(
        allowed,
        [true, false, false, false],
        "only top level, never its own row"
    );
}

#[test]
fn kanban_cards_are_the_tree_roots_only() {
    let vault = vault();
    let tasks = tasks(&vault);
    let work = project(&tasks, "Agent Test Board");
    let root = tasks.create(input("root", &work)).expect("root").created[0].clone();
    let first = child(&tasks, "first", &work, &root);
    child(&tasks, "deep", &work, &first);
    let lone = tasks.create(input("lone", &work)).expect("lone").created[0].clone();

    let page = tasks
        .view(TaskViewQuery {
            tab: "all".to_string(),
            project_id: Some(work),
            filters_json: None,
            sort_json: None,
            now: "2026-05-01T09:00:00".to_string(),
            week_starts_on: 1,
        })
        .expect("view");
    let mut cards = page.card_ids.clone();
    cards.sort();
    let mut expected = vec![root, lone];
    expected.sort();
    assert_eq!(cards, expected, "subtasks ride on their parent's card");
}
