//! Chapter 06 §6.5.2 P3 never undoes a pending local delete: B deletes an item
//! it has not pushed yet, its pass pulls A's concurrent edit first and merges
//! it, and the push still sends the delete
//! (`crates/memry-core/src/sync/hardening/requeue.rs`).
//!
//! | Test                       | Merge path                          |
//! | -------------------------- | ----------------------------------- |
//! | a task                     | field merge, `write_merged_in`      |
//! | a calendar event           | `requeue::store_merged`             |

use crate::desktop_relay::{Device, NOW, Relay, failed};

use memry_core::domain::calendar_items::write::{self, EventPatch, NewEvent};
use memry_core::domain::tasks::{self, NewTask};
use memry_core::protocol::envelope::SyncOperation;

const TASK: &str = "task-1";

/// B's pass after its unpushed delete met A's concurrent edit: the push sends
/// one `delete`, the server tombstones the item, and A's next pass deletes it.
async fn the_delete_reaches_both_devices_and_the_server(
    relay: &Relay,
    a: &Device,
    b: &Device,
    item_type: &str,
    item_id: &str,
    deleted_on: &'static str,
) {
    relay.pull(b).await;
    let sent = relay.push(b).await;
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0].operation, SyncOperation::Delete, "{sent:?}");
    assert_eq!(sent[0].rejected, None, "{sent:?}");
    let held = relay.snapshot();
    let held = &held[&(item_type.to_owned(), item_id.to_owned())];
    assert!(
        held.deleted_at.is_some(),
        "the server tombstoned it: {held:?}"
    );

    relay.sync(a).await;
    assert_eq!(b.count(deleted_on), 1, "deleted on b");
    assert_eq!(a.count(deleted_on), 1, "deleted on a");
}

#[tokio::test]
async fn a_pending_task_delete_survives_a_concurrent_remote_edit_merged_first() {
    let (a, b, relay) = (Device::bare("a"), Device::bare("b"), Relay::default());
    a.db()
        .call_blocking(|conn| {
            let task = NewTask {
                id: TASK,
                title: "Ship",
                project_id: "proj-1",
                due_date: None,
                due_time: None,
                priority: 1,
                repeat_config: None,
                tags: &[],
            };
            tasks::create(conn, &task, "a", NOW)
                .map(drop)
                .map_err(failed)
        })
        .expect("create");
    relay.sync(&a).await;
    relay.sync(&b).await;

    a.db()
        .call_blocking(|conn| {
            tasks::set_title(conn, TASK, "From a", "a", NOW + 1)
                .map(drop)
                .map_err(failed)
        })
        .expect("retitle");
    relay.push(&a).await;
    b.db()
        .call_blocking(|conn| {
            tasks::delete(conn, TASK, "b", NOW + 2)
                .map(drop)
                .map_err(failed)
        })
        .expect("delete");

    the_delete_reaches_both_devices_and_the_server(
        &relay,
        &a,
        &b,
        "task",
        TASK,
        "SELECT COUNT(*) FROM sync_items WHERE item_type = 'task' AND deleted_at IS NOT NULL",
    )
    .await;
}

#[tokio::test]
async fn a_pending_calendar_event_delete_survives_a_concurrent_remote_edit_merged_first() {
    let (a, b, relay) = (Device::bare("a"), Device::bare("b"), Relay::default());
    let id = a
        .db()
        .call_blocking(|conn| {
            write::create_event(
                conn,
                &NewEvent {
                    title: "Standup".into(),
                    start_at: "2026-03-10T09:00:00.000Z".into(),
                    end_at: Some("2026-03-10T09:15:00.000Z".into()),
                    timezone: "UTC".into(),
                    ..NewEvent::default()
                },
                "a",
                NOW,
            )
        })
        .expect("create");
    relay.sync(&a).await;
    relay.sync(&b).await;

    let edited = id.clone();
    a.db()
        .call_blocking(move |conn| {
            write::update_event(
                conn,
                &edited,
                &EventPatch {
                    title: Some("From a".into()),
                    ..EventPatch::default()
                },
                "a",
                NOW + 1,
            )
        })
        .expect("retitle");
    relay.push(&a).await;
    let deleted = id.clone();
    b.db()
        .call_blocking(move |conn| write::delete_event(conn, &deleted, "b", NOW + 2))
        .expect("delete");

    the_delete_reaches_both_devices_and_the_server(
        &relay,
        &a,
        &b,
        "calendar_event",
        &id,
        "SELECT COUNT(*) FROM sync_items \
          WHERE item_type = 'calendar_event' AND deleted_at IS NOT NULL",
    )
    .await;
}
