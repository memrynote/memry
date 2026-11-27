//! `search:add-reason` and `search:get-reasons` over an opened vault (Electron's
//! `search-handlers.ts:236-248`): a task stores the icon the renderer gave it, and the icon comes
//! back with its reason.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use memry_core::api::projects::ProjectDraft;
use memry_core::api::tasks_write::NewTaskInput;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::search::view::{AddReasonInput, ContentType};
use memry_desktop::search::{add_reason, reasons};
use vault_env::env;

#[test]
fn a_tasks_icon_comes_back_with_its_reason() {
    let mut kept = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    e.open();
    let open = e.session.current().expect("open");
    let tasks = open.vault.tasks(kept.expect("the store")).unwrap();
    let project = tasks
        .create_project(ProjectDraft {
            name: "Inbox".into(),
            description: None,
            color: None,
            icon: None,
            statuses: None,
        })
        .unwrap();
    let task = tasks
        .create(NewTaskInput {
            title: "Ship it".into(),
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
        .unwrap()
        .created[0]
        .clone();

    let added = add_reason(
        &open,
        AddReasonInput {
            item_id: task.clone(),
            item_type: ContentType::Task,
            item_title: "Ship it".into(),
            item_icon: Some("✅".into()),
            search_query: "ship".into(),
        },
    )
    .unwrap();
    assert_eq!(added.item_icon.as_deref(), Some("✅"));

    let listed: Vec<_> = reasons(&open)
        .unwrap()
        .into_iter()
        .map(|reason| (reason.item_id, reason.item_type, reason.item_icon))
        .collect();
    assert_eq!(listed, [(task, ContentType::Task, Some("✅".to_owned()))]);
}
