use std::sync::{Arc, Mutex};

use memry_desktop::notes::index::LinkChanges;
use memry_desktop::sync::events::{ItemOperation, PulledItem, SyncEvent};
use memry_desktop::tasks::service::{TaskEvent, TaskWritten};
use memry_tauri::commands::tasks::announce;
use memry_tauri::events::{
    NoteLinksChangedEvent, NoteTagsChangedEvent, PortalsUsageChangedEvent, ProjectCreatedEvent,
    ProjectDeletedEvent, ProjectUpdatedEvent, SyncItemSyncedEvent, TaskActivityCreatedEvent,
    TaskCompletedEvent, TaskCreatedEvent, TaskDeletedEvent, TaskMovedEvent, TaskUpdatedEvent,
    announce_links, broadcast, broadcast_sync_event, send_to,
};
use serde::{Deserialize, Serialize};
use tauri::test::mock_app;
use tauri::{Listener, WebviewUrl, WebviewWindowBuilder};
use tauri_specta::Event;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
struct TestPingEvent {
    n: u32,
}

#[test]
fn events_broadcast_survives_a_closed_window_and_reaches_the_other() {
    let app = mock_app();
    let first = WebviewWindowBuilder::new(&app, "first", WebviewUrl::App("index.html".into()))
        .build()
        .expect("first window");
    let second = WebviewWindowBuilder::new(&app, "second", WebviewUrl::App("index.html".into()))
        .build()
        .expect("second window");
    let received = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&received);
    second.listen(TestPingEvent::NAME, move |event| {
        sink.lock().expect("lock").push(event.payload().to_owned());
    });

    first.destroy().expect("destroy first window");
    broadcast(app.handle(), TestPingEvent { n: 7 });

    assert_eq!(received.lock().expect("lock").as_slice(), ["{\"n\":7}"]);
}

#[test]
fn events_send_to_targets_one_label_and_never_errors() {
    let app = mock_app();
    let target = WebviewWindowBuilder::new(&app, "target", WebviewUrl::App("index.html".into()))
        .build()
        .expect("target window");
    let other = WebviewWindowBuilder::new(&app, "other", WebviewUrl::App("index.html".into()))
        .build()
        .expect("other window");
    let hits = Arc::new(Mutex::new((0, 0)));
    let target_hits = Arc::clone(&hits);
    target.listen(TestPingEvent::NAME, move |_| {
        target_hits.lock().expect("lock").0 += 1
    });
    let other_hits = Arc::clone(&hits);
    other.listen(TestPingEvent::NAME, move |_| {
        other_hits.lock().expect("lock").1 += 1
    });

    send_to(app.handle(), "target", TestPingEvent { n: 1 });
    send_to(app.handle(), "missing", TestPingEvent { n: 2 });

    assert_eq!(*hits.lock().expect("lock"), (1, 0));
}

#[test]
fn a_reindex_that_moved_only_portal_usage_sends_no_links_event() {
    let app = mock_app();
    let heard = Arc::new(Mutex::new(Vec::new()));
    for name in [NoteLinksChangedEvent::NAME, PortalsUsageChangedEvent::NAME] {
        let sink = Arc::clone(&heard);
        app.listen_any(name, move |_| sink.lock().expect("lock").push(name));
    }
    let ids = |list: &[&str]| list.iter().map(|id| (*id).to_owned()).collect();
    let sent = |links: LinkChanges| {
        announce_links(app.handle(), links);
        std::mem::take(&mut *heard.lock().expect("lock"))
    };

    let usage = LinkChanges {
        usage: ids(&["src"]),
        ..LinkChanges::default()
    };
    assert_eq!(sent(usage), [PortalsUsageChangedEvent::NAME]);
    let links = LinkChanges {
        targets: ids(&["b"]),
        ..LinkChanges::default()
    };
    assert_eq!(sent(links), [NoteLinksChangedEvent::NAME]);
    let both = LinkChanges {
        sources: ids(&["a"]),
        targets: ids(&["b"]),
        usage: ids(&["b"]),
    };
    assert_eq!(
        sent(both),
        [PortalsUsageChangedEvent::NAME, NoteLinksChangedEvent::NAME]
    );
}

#[test]
fn a_pulled_page_reaches_the_renderer_as_one_item_synced_event() {
    let app = mock_app();
    let heard = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&heard);
    app.listen_any(SyncItemSyncedEvent::NAME, move |event| {
        sink.lock().expect("lock").push(event.payload().to_owned());
    });
    let item = |item_type: &str, item_id: &str, operation| PulledItem {
        item_type: item_type.into(),
        item_id: item_id.into(),
        operation,
    };

    broadcast_sync_event(
        app.handle(),
        &SyncEvent::Pulled(vec![
            item("task", "t1", ItemOperation::Create),
            item("project", "p1", ItemOperation::Update),
            item("task", "t2", ItemOperation::Delete),
        ]),
    );

    let heard = heard.lock().expect("lock");
    assert_eq!(heard.len(), 1, "{heard:?}");
    let payload: serde_json::Value = serde_json::from_str(&heard[0]).expect("json");
    assert_eq!(
        payload,
        serde_json::json!({
            "operation": "pull",
            "items": [
                { "itemId": "t1", "type": "task", "itemOperation": "create" },
                { "itemId": "p1", "type": "project", "itemOperation": "update" },
                { "itemId": "t2", "type": "task", "itemOperation": "delete" },
            ]
        })
    );
}

/// Every payload heard on `names`, as `(name, json)`, in delivery order.
fn hear(
    app: &tauri::App<tauri::test::MockRuntime>,
    names: &[&'static str],
) -> Arc<Mutex<Vec<(&'static str, serde_json::Value)>>> {
    let heard = Arc::new(Mutex::new(Vec::new()));
    for &name in names {
        let sink = Arc::clone(&heard);
        app.listen_any(name, move |event| {
            let payload = serde_json::from_str(event.payload()).expect("json");
            sink.lock().expect("lock").push((name, payload));
        });
    }
    heard
}

#[test]
fn a_task_activity_page_tells_the_renderer_each_task_and_a_task_update_alone_tells_none() {
    let app = mock_app();
    let heard = hear(&app, &[TaskActivityCreatedEvent::NAME]);

    broadcast_sync_event(
        app.handle(),
        &SyncEvent::Pulled(vec![PulledItem {
            item_type: "task".into(),
            item_id: "t1".into(),
            operation: ItemOperation::Update,
        }]),
    );
    broadcast_sync_event(
        app.handle(),
        &SyncEvent::TaskActivityCreated(vec!["t1".into(), "t2".into()]),
    );

    let heard = heard.lock().expect("lock");
    assert_eq!(
        *heard,
        [
            (
                TaskActivityCreatedEvent::NAME,
                serde_json::json!({ "taskId": "t1" })
            ),
            (
                TaskActivityCreatedEvent::NAME,
                serde_json::json!({ "taskId": "t2" })
            ),
        ]
    );
}

#[test]
fn a_task_write_reaches_the_renderer_as_the_publishers_events_in_order() {
    let app = mock_app();
    let names = [
        TaskUpdatedEvent::NAME,
        TaskCreatedEvent::NAME,
        TaskDeletedEvent::NAME,
        TaskCompletedEvent::NAME,
        TaskMovedEvent::NAME,
        NoteTagsChangedEvent::NAME,
    ];
    let heard = hear(&app, &names);
    let id = |id: &str| id.to_owned();
    let written = TaskWritten {
        mutation: (),
        events: vec![
            TaskEvent::Completed(id("t1")),
            TaskEvent::Created(id("t2")),
            TaskEvent::TagsChanged,
            TaskEvent::Moved(id("t3")),
            TaskEvent::Deleted(id("t4")),
            TaskEvent::Updated(id("t5")),
        ],
    };

    announce(app.handle(), &written);
    announce(app.handle(), &TaskWritten::quiet(()));

    let heard = heard.lock().expect("lock");
    assert_eq!(
        *heard,
        [
            (TaskCompletedEvent::NAME, serde_json::json!({ "id": "t1" })),
            (TaskCreatedEvent::NAME, serde_json::json!({ "id": "t2" })),
            (NoteTagsChangedEvent::NAME, serde_json::Value::Null),
            (TaskMovedEvent::NAME, serde_json::json!({ "id": "t3" })),
            (TaskDeletedEvent::NAME, serde_json::json!({ "id": "t4" })),
            (TaskUpdatedEvent::NAME, serde_json::json!({ "id": "t5" })),
        ],
        "each event once, in the write's order; a refusal sends nothing"
    );
}

#[test]
fn a_project_write_reaches_the_renderer_before_the_tasks_it_took() {
    let app = mock_app();
    let names = [
        ProjectCreatedEvent::NAME,
        ProjectUpdatedEvent::NAME,
        ProjectDeletedEvent::NAME,
        TaskDeletedEvent::NAME,
        NoteTagsChangedEvent::NAME,
    ];
    let heard = hear(&app, &names);
    let id = |id: &str| id.to_owned();
    let deleted = TaskWritten {
        mutation: (),
        events: vec![
            TaskEvent::ProjectDeleted(id("p1")),
            TaskEvent::Deleted(id("t1")),
            TaskEvent::TagsChanged,
            TaskEvent::Deleted(id("t2")),
        ],
    };
    let created = TaskWritten {
        mutation: (),
        events: vec![
            TaskEvent::ProjectCreated(id("p2")),
            TaskEvent::ProjectUpdated(id("p2")),
        ],
    };

    announce(app.handle(), &deleted);
    announce(app.handle(), &created);
    announce(app.handle(), &TaskWritten::quiet(()));

    let heard = heard.lock().expect("lock");
    assert_eq!(
        *heard,
        [
            (ProjectDeletedEvent::NAME, serde_json::json!({ "id": "p1" })),
            (TaskDeletedEvent::NAME, serde_json::json!({ "id": "t1" })),
            (NoteTagsChangedEvent::NAME, serde_json::Value::Null),
            (TaskDeletedEvent::NAME, serde_json::json!({ "id": "t2" })),
            (ProjectCreatedEvent::NAME, serde_json::json!({ "id": "p2" })),
            (ProjectUpdatedEvent::NAME, serde_json::json!({ "id": "p2" })),
        ],
        "the project's event, then each task's, in the write's order; a refusal sends nothing"
    );
}
