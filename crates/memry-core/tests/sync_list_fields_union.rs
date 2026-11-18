//! Chapter 06 §6.7.1 between two core vaults and one relay server: a
//! concurrent task merge unions `tags`, `linkedNoteIds` and `linkedCanvasIds`
//! as Electron's task handler does
//! (`apps/desktop/src/main/sync/item-handlers/task-handler.ts:221-242`), so a
//! list entry one device added survives the other device's merge and its
//! union-clock re-push (§6.5.2 P3).
//!
//! | Test                                              | Rule                 |
//! | ------------------------------------------------- | -------------------- |
//! | a tag added on b survives a's concurrent retitle  | §6.7.1, P3           |
//! | the same for linked notes and linked canvases     | §6.7.1, P3           |
//! | a removal on one side, an add on the other        | §6.7.1 resurrection  |
//! | an Electron peer's row round-trips the union      | §6.7.1 order, fold   |
//! | a remote without the key keeps the local list     | §6.7.1 absent key    |
//! | a dominating remote without the key keeps it too  | §6.7.1 wholesale     |
//! | a malformed remote list flags the record corrupt  | §6.7.1 shape         |
//!
//! The first three fail with the union removed from `task_merge.rs`: the
//! merging device then keeps only its own list and its re-push, at the union
//! clock, overwrites the peer's.

use crate::desktop_relay::{Device, NOW, Relay, failed};

use memry_core::domain::tasks::{self, NewTask};
use serde_json::{Value as Json, json};

const TASK: &str = "task-1";

fn create(device: &Device, tags: &[&str]) {
    let who = device.id;
    let tags: Vec<String> = tags.iter().map(|tag| (*tag).to_owned()).collect();
    device
        .db()
        .call_blocking(move |conn| {
            let task = NewTask {
                id: TASK,
                title: "Ship",
                project_id: "proj-1",
                due_date: None,
                due_time: None,
                priority: 1,
                repeat_config: None,
                tags: &tags,
            };
            tasks::create(conn, &task, who, NOW)
                .map(drop)
                .map_err(failed)
        })
        .expect("create");
}

fn retitle(device: &Device, title: &'static str, at: i64) {
    let who = device.id;
    device
        .db()
        .call_blocking(move |conn| {
            tasks::set_title(conn, TASK, title, who, at)
                .map(drop)
                .map_err(failed)
        })
        .expect("retitle");
}

/// Sets one of the three list fields through its domain setter.
fn set_list(device: &Device, list: &'static str, values: &[&str], at: i64) {
    let who = device.id;
    let values: Vec<String> = values.iter().map(|value| (*value).to_owned()).collect();
    device
        .db()
        .call_blocking(move |conn| {
            match list {
                "tags" => tasks::set_tags(conn, TASK, &values, who, at),
                "linkedNoteIds" => tasks::set_linked_note_ids(conn, TASK, &values, who, at),
                "linkedCanvasIds" => tasks::set_linked_canvas_ids(conn, TASK, &values, who, at),
                other => panic!("not a list field: {other}"),
            }
            .map(drop)
            .map_err(failed)
        })
        .expect("set the list");
}

fn field(payload: &str, key: &str) -> Json {
    serde_json::from_str::<Json>(payload).expect("json")[key].clone()
}

/// `list` and `title` on both devices and on the server, after the probe's
/// round trip: b pushes its list edit, a pulls (the concurrent merge), pushes
/// the merged row, and b pulls it.
async fn round_trip(a: &Device, b: &Device, relay: &Relay, list: &str) -> [(Json, Json); 3] {
    relay.push(b).await;
    relay.pull(a).await;
    relay.push(a).await;
    relay.pull(b).await;
    let view = |payload: String| (field(&payload, list), field(&payload, "title"));
    [
        view(a.stored("task", TASK)),
        view(b.stored("task", TASK)),
        view(relay.held("task", TASK).expect("the server holds the task")),
    ]
}

async fn synced_pair(tags: &[&str]) -> (Device, Device, Relay) {
    let (a, b, relay) = (Device::bare("a"), Device::bare("b"), Relay::default());
    create(&a, tags);
    relay.sync(&a).await;
    relay.sync(&b).await;
    (a, b, relay)
}

/// The REVIEW-5117 probe, for each of the three lists: b adds an entry while a
/// retitles. Before the union, a's merge kept a's list and its re-push at the
/// union clock dominated b's row, so the entry was lost on every device.
#[tokio::test]
async fn an_entry_added_on_one_device_survives_a_concurrent_edit_on_the_other() {
    for (list, value) in [
        ("tags", "urgent"),
        ("linkedNoteIds", "note-1"),
        ("linkedCanvasIds", "canvas-1"),
    ] {
        let (a, b, relay) = synced_pair(&[]).await;
        set_list(&b, list, &[value], NOW + 1);
        retitle(&a, "From a", NOW + 2);

        let expected = (json!([value]), json!("From a"));
        let [on_a, on_b, on_server] = round_trip(&a, &b, &relay, list).await;
        assert_eq!(on_a, expected, "{list} on a");
        assert_eq!(on_b, expected, "{list} on b");
        assert_eq!(on_server, expected, "{list} on the server");
    }
}

/// Electron's union has no removal set: an entry one side removed while the
/// other side still holds it comes back. a drops `drop`, b adds `new`; the
/// merge on a is local `[keep]` then remote `[keep, drop, new]`.
#[tokio::test]
async fn a_removal_concurrent_with_an_add_is_undone_as_electron_undoes_it() {
    let (a, b, relay) = synced_pair(&["keep", "drop"]).await;
    set_list(&a, "tags", &["keep"], NOW + 1);
    set_list(&b, "tags", &["keep", "drop", "new"], NOW + 2);

    let expected = json!(["keep", "drop", "new"]);
    let [on_a, on_b, on_server] = round_trip(&a, &b, &relay, "tags").await;
    assert_eq!(on_a.0, expected, "on a");
    assert_eq!(on_b.0, expected, "on b");
    assert_eq!(on_server.0, expected, "on the server");
}

/// An Electron peer's row (`taskRowToWire`: every column, then the three
/// junction arrays) merged on a core device. Tags keep the local spelling of a
/// case variant, are trimmed and fold-deduped (`writeTags`, `:100-115`); link
/// ids dedupe exactly. The merged push is what Electron's
/// `TaskSyncPayloadSchema` reads: arrays of strings.
#[tokio::test]
async fn an_electron_peers_lists_round_trip_through_a_core_merge() {
    let (a, relay) = (Device::bare("a"), Relay::default());
    create(&a, &["urgent"]);
    relay.sync(&a).await;
    set_list(&a, "linkedNoteIds", &["n1"], NOW + 1);
    retitle(&a, "From a", NOW + 2);

    relay.put(
        "task",
        TASK,
        &json!({
            "id": TASK, "title": "Ship", "description": null, "projectId": "proj-1",
            "statusId": null, "parentId": null, "priority": 3, "position": 0,
            "dueDate": null, "dueTime": null, "durationMinutes": null, "startDate": null,
            "repeatConfig": null, "repeatFrom": null, "sourceNoteId": null,
            "completedAt": null, "archivedAt": null,
            "clock": {"a": 1, "peer": 1},
            "fieldClocks": {"title": {"a": 1}, "priority": {"a": 1, "peer": 1}},
            "createdAt": "2025-10-09T08:53:20.000Z", "modifiedAt": "2025-10-09T08:53:21.000Z",
            "tags": ["Urgent", " later ", "", "LATER"],
            "linkedNoteIds": ["N1", "n1", "n2"],
            "linkedCanvasIds": ["c1"],
        })
        .to_string(),
    );
    relay.pull(&a).await;
    relay.push(&a).await;

    let held = relay.held("task", TASK).expect("the server holds the task");
    assert_eq!(field(&held, "tags"), json!(["urgent", "later"]));
    assert_eq!(field(&held, "linkedNoteIds"), json!(["n1", "N1", "n2"]));
    assert_eq!(field(&held, "linkedCanvasIds"), json!(["c1"]));
    assert_eq!(field(&held, "title"), json!("From a"));
    assert_eq!(field(&held, "priority"), json!(3));
    assert_eq!(field(&held, "clock"), json!({"a": 3, "peer": 1}));
}

/// `if (data.tags)` (`:228`): a remote that does not carry a list leaves the
/// local one as it is, so an older peer that drops a key cannot clear it.
#[tokio::test]
async fn a_remote_without_a_list_key_keeps_the_local_list() {
    let (a, relay) = (Device::bare("a"), Relay::default());
    create(&a, &["urgent"]);
    relay.sync(&a).await;
    set_list(&a, "linkedCanvasIds", &["c1"], NOW + 1);

    relay.put(
        "task",
        TASK,
        &json!({
            "title": "From peer", "projectId": "proj-1", "priority": 1,
            "clock": {"a": 1, "peer": 1},
            "fieldClocks": {"title": {"a": 1, "peer": 1}},
        })
        .to_string(),
    );
    relay.pull(&a).await;

    let stored = a.stored("task", TASK);
    assert_eq!(field(&stored, "title"), json!("From peer"));
    assert_eq!(field(&stored, "tags"), json!(["urgent"]));
    assert_eq!(field(&stored, "linkedCanvasIds"), json!(["c1"]));
}

/// REVIEW-5126 finding 1: an Electron build from before #1879 pushes no
/// `linkedCanvasIds`. Its row dominates a's, so the apply is wholesale
/// (`task-handler.ts:319-321`); a keeps its canvas link and takes the rest.
/// A `null` list keeps the local one the same way.
#[tokio::test]
async fn a_dominating_remote_without_a_list_key_keeps_the_local_list() {
    for canvases in [None, Some(Json::Null)] {
        let (a, relay) = (Device::bare("a"), Relay::default());
        create(&a, &["urgent"]);
        relay.sync(&a).await;
        set_list(&a, "linkedCanvasIds", &["c1"], NOW + 1);

        let mut remote = json!({
            "id": TASK, "title": "From peer", "projectId": "proj-1", "priority": 1,
            "clock": {"a": 2, "peer": 1},
            "fieldClocks": {"title": {"a": 1, "peer": 1}},
            "tags": ["later"], "linkedNoteIds": ["n1"],
        });
        if let Some(canvases) = &canvases {
            remote["linkedCanvasIds"] = canvases.clone();
        }
        relay.put("task", TASK, &remote.to_string());
        relay.pull(&a).await;

        let stored = a.stored("task", TASK);
        assert_eq!(field(&stored, "title"), json!("From peer"), "{canvases:?}");
        assert_eq!(field(&stored, "tags"), json!(["later"]), "{canvases:?}");
        assert_eq!(
            field(&stored, "linkedNoteIds"),
            json!(["n1"]),
            "{canvases:?}"
        );
        assert_eq!(
            field(&stored, "linkedCanvasIds"),
            json!(["c1"]),
            "{canvases:?}"
        );
    }
}

/// REVIEW-5126 finding 2: a remote list that is not an array of strings is
/// refused on the concurrent branch, as `TaskSyncPayloadSchema` refuses it and
/// as the wholesale path's projector does. The record is flagged corrupt with
/// the item id and list name, and the local row is left as it was.
#[tokio::test]
async fn a_malformed_remote_list_flags_the_record_corrupt() {
    let (a, relay) = (Device::bare("a"), Relay::default());
    create(&a, &["urgent"]);
    relay.sync(&a).await;
    retitle(&a, "From a", NOW + 1);

    relay.put(
        "task",
        TASK,
        &json!({
            "id": TASK, "title": "From peer", "projectId": "proj-1", "priority": 1,
            "clock": {"a": 1, "peer": 1},
            "fieldClocks": {"title": {"a": 1, "peer": 1}},
            "tags": ["ok", 7],
        })
        .to_string(),
    );
    relay.pull(&a).await;

    assert_eq!(
        a.count(
            "SELECT COUNT(*) FROM sync_items WHERE item_type = 'task' AND item_id = 'task-1'
             AND corrupt_reason LIKE '%task task-1: remote `tags` is not an array of strings%'"
        ),
        1
    );
    let stored = a.stored("task", TASK);
    assert_eq!(field(&stored, "title"), json!("From a"));
    assert_eq!(field(&stored, "tags"), json!(["urgent"]));
}
