//! Orphan repair (Step 17 L3b, #3534; `sync::hardening::orphans`) through the
//! desktop driver's pass (`SyncDriver::run_pass`): a task or an external event
//! whose parent is a tombstone here is tombstoned and its delete pushed; a
//! message of a deleted conversation is kept; a child whose parent is only
//! absent is kept, and the absent parent is fetched by id once per driver.
//!
//! The server is `driver_fakes`'s; everything else is real.

use memry_core::api::errors::StorageError;
use memry_core::sync::outbox::{self, Change};
use serde_json::{Value as Json, json};

use crate::driver_fakes::Desktop;

const NOW: i64 = 1_760_000_000_000;

async fn desktop() -> Desktop {
    Desktop::open(
        &[
            "project",
            "task",
            "calendar_source",
            "calendar_external_event",
            "agent_conversation",
            "agent_message",
        ],
        |_| Ok(()),
    )
    .await
}

fn deleted_at(device: &Desktop, item_type: &'static str, id: &str) -> Option<i64> {
    let id = id.to_owned();
    device
        .db
        .call_blocking(move |conn| {
            conn.query_row(
                "SELECT deleted_at FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
                [item_type, id.as_str()],
                |row| row.get(0),
            )
            .map_err(failed)
        })
        .expect("the row")
}

/// The ops the server was sent for `id`.
fn pushed(device: &Desktop, id: &str) -> Vec<String> {
    device
        .server
        .pushed()
        .into_iter()
        .filter(|(_, pushed, _)| pushed == id)
        .map(|(_, _, op)| op)
        .collect()
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn project() -> Json {
    json!({"title": "Launch", "clock": {"peer": 1}})
}

fn task(project_id: &str) -> Json {
    json!({"title": "Ship it", "projectId": project_id, "clock": {"peer": 1}})
}

fn conversation() -> Json {
    json!({
        "vaultId": "vault-1", "title": "Quarterly plan", "backend": "local",
        "backendModel": null, "trustList": [], "pinned": false,
        "clock": {"peer": 1}, "fieldClocks": {},
        "createdAt": NOW, "updatedAt": NOW, "deletedAt": null,
    })
}

fn message(conversation_id: &str) -> Json {
    json!({
        "conversationId": conversation_id, "role": "user",
        "content": {"role": "user", "data": {"text": "what is due"}},
        "attachments": [], "toolCallId": null, "status": "completed",
        "clock": {"peer": 1}, "createdAt": NOW, "updatedAt": NOW,
    })
}

fn source() -> Json {
    json!({
        "id": "src-work", "provider": "google", "kind": "calendar", "accountId": "acct-1",
        "remoteId": "work@group.calendar.google.com", "title": "Work", "isSelected": true,
        "isPrimary": false, "isMemryManaged": false, "clock": {"peer": 1},
        "createdAt": "2026-09-01T08:00:00.000Z", "modifiedAt": "2026-09-24T08:00:00.000Z"
    })
}

fn external_event() -> Json {
    json!({
        "id": "ext-1", "sourceId": "src-work", "remoteEventId": "g-1", "title": "Design review",
        "startAt": "2026-09-24T07:00:00.000Z", "endAt": "2026-09-24T08:30:00.000Z",
        "isAllDay": false, "status": "confirmed", "clock": {"peer": 1},
        "createdAt": "2026-09-24T08:00:00.000Z", "modifiedAt": "2026-09-24T08:00:00.000Z"
    })
}

/// A parent and its child pulled live in one pass.
async fn pull_live(
    device: &Desktop,
    (parent_type, parent_id, parent): (&str, &str, Json),
    (child_type, child_id, child): (&str, &str, Json),
) {
    device.server.put(parent_type, parent_id, parent);
    device.server.put(child_type, child_id, child);
    device.server.page(&[parent_id, child_id], "10");
    let pass = device.pass().await;
    assert_eq!(pass.pull.applied, 2, "{:?}", pass.pull);
}

/// The parent's delete pulled without the child's, as when a peer's cascade
/// never reached the server. The orphan repair fetches the child again, which
/// the server still holds unchanged.
async fn pull_parent_tombstone(device: &Desktop, parent: (&str, &str), child: &str) {
    let (parent_type, parent_id) = parent;
    device.server.delete(parent_type, parent_id);
    device.server.page(&[parent_id], "11");
    let pass = device.pass().await;
    assert_eq!(pass.pull.deleted, 1, "the parent's tombstone applied");
    assert_eq!(
        device.server.pulled_ids().last(),
        Some(&json!([child])),
        "the child is fetched again before the check"
    );
}

#[tokio::test]
async fn a_task_whose_project_is_a_tombstone_here_is_tombstoned_and_its_delete_pushed() {
    let device = desktop().await;
    pull_live(
        &device,
        ("project", "p1", project()),
        ("task", "t1", task("p1")),
    )
    .await;

    pull_parent_tombstone(&device, ("project", "p1"), "t1").await;

    assert!(deleted_at(&device, "project", "p1").is_some());
    assert!(
        deleted_at(&device, "task", "t1").is_some(),
        "the orphan is tombstoned"
    );
    assert_eq!(pushed(&device, "t1"), vec!["delete"]);
}

#[tokio::test]
async fn an_external_event_whose_source_is_a_tombstone_here_is_tombstoned_and_its_delete_pushed() {
    let device = desktop().await;
    pull_live(
        &device,
        ("calendar_source", "src-work", source()),
        ("calendar_external_event", "ext-1", external_event()),
    )
    .await;

    pull_parent_tombstone(&device, ("calendar_source", "src-work"), "ext-1").await;

    assert!(deleted_at(&device, "calendar_external_event", "ext-1").is_some());
    assert_eq!(pushed(&device, "ext-1"), vec!["delete"]);
}

/// Electron counts a soft-deleted conversation as present
/// (`agent-message-handler.ts:104-107`) and no delete of one cascades to its
/// messages: tombstoning them would push a delete per message from every
/// desktop that pulls the conversation's delete.
#[tokio::test]
async fn the_messages_of_a_conversation_a_peer_deleted_are_kept() {
    let device = desktop().await;
    device
        .server
        .put("agent_conversation", "conv-1", conversation());
    let ids: Vec<String> = (0..200).map(|n| format!("m{n:03}")).collect();
    for id in &ids {
        device.server.put("agent_message", id, message("conv-1"));
    }
    let mut listed: Vec<&str> = vec!["conv-1"];
    listed.extend(ids.iter().map(String::as_str));
    device.server.page(&listed, "10");
    assert_eq!(device.pass().await.pull.applied, 201);

    device.server.delete("agent_conversation", "conv-1");
    device.server.page(&["conv-1"], "11");
    assert_eq!(device.pass().await.pull.deleted, 1);

    let deletes: Vec<_> = device
        .server
        .pushed()
        .into_iter()
        .filter(|(_, _, op)| op == "delete")
        .collect();
    assert_eq!(deletes, Vec::new(), "no delete is pushed");
    let tombstoned: i64 = device
        .db
        .call_blocking(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM sync_items
                  WHERE item_type = 'agent_message' AND deleted_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .map_err(failed)
        })
        .expect("the count");
    assert_eq!(tombstoned, 0);
}

#[tokio::test]
async fn a_child_with_a_change_queued_is_left_to_that_change() {
    let device = desktop().await;
    pull_live(
        &device,
        ("project", "p1", project()),
        ("task", "t1", task("p1")),
    )
    .await;
    device
        .db
        .call_blocking(|conn| {
            let tx = conn.unchecked_transaction().map_err(failed)?;
            outbox::enqueue(&tx, &Change::upsert("task", "t1"), NOW)?;
            tx.commit().map_err(failed)
        })
        .expect("a queued edit");

    pull_parent_tombstone(&device, ("project", "p1"), "t1").await;

    assert_eq!(
        deleted_at(&device, "task", "t1"),
        None,
        "the queued edit decides"
    );
    assert_eq!(pushed(&device, "t1"), vec!["update"]);
}

/// A parent the server does not return is not gone: absence carries no
/// clock (chapter 05 §5.12.3). Electron's default `inbox` project is never a
/// record, and its tasks must stay.
#[tokio::test]
async fn a_task_whose_project_is_only_absent_is_kept_and_the_project_fetched_once() {
    let device = desktop().await;
    device.server.put("task", "t1", task("inbox"));
    device.server.page(&["t1"], "10");
    device.pass().await;
    assert_eq!(
        device.server.pulled_ids(),
        vec![json!(["t1"]), json!(["inbox"])]
    );

    // A second delivering pass of the same driver does not ask again.
    device.server.put("task", "t2", task("inbox"));
    device.server.page(&["t2"], "11");
    device.pass().await;

    assert_eq!(
        device.server.pulled_ids(),
        vec![json!(["t1"]), json!(["inbox"]), json!(["t2"])],
        "the parent was fetched once"
    );
    for id in ["t1", "t2"] {
        assert_eq!(deleted_at(&device, "task", id), None, "{id} is kept");
        assert!(pushed(&device, id).is_empty(), "nothing pushed for {id}");
    }
}

#[tokio::test]
async fn a_message_whose_conversation_is_absent_fetches_it_by_id_and_applies_it() {
    let device = desktop().await;
    device.server.put("agent_message", "m1", message("conv-1"));
    device
        .server
        .put("agent_conversation", "conv-1", conversation());
    device.server.page(&["m1"], "10");
    device.pass().await;

    assert_eq!(
        device.server.pulled_ids(),
        vec![json!(["m1"]), json!(["conv-1"])]
    );
    assert_eq!(deleted_at(&device, "agent_conversation", "conv-1"), None);
    assert_eq!(deleted_at(&device, "agent_message", "m1"), None);
}
