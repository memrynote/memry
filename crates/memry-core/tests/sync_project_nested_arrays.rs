//! Chapter 06 §6.7.2 between two core vaults and one relay server: a project's
//! `statuses` and `links` follow Electron's project handler, which writes each
//! one from the remote whenever the remote carries it, after the field merge
//! as after a wholesale apply
//! (`apps/desktop/src/main/sync/item-handlers/project-handler.ts:259-265`).
//!
//! | Test                                                   | Rule              |
//! | ------------------------------------------------------ | ----------------- |
//! | a status rename and a concurrent retitle, either order | §6.7.2, P3        |
//! | a remote without `statuses` or `links` keeps the local | §6.7.2 absent key |
//! | an Electron peer's row round-trips its arrays          | §6.7.2            |
//! | a malformed remote array flags the record corrupt      | §6.7.2 shape      |
//! | a markdown note's link survives a concurrent retitle   | §6.7.2 markdown   |
//! | a markdown note's link survives a dominating remote    | §6.7.2 markdown   |
//!
//! The first and third fail with the concurrent branch keeping the local
//! arrays (the rule before Kaan's decision of 18 Nov), the second with the
//! wholesale branch storing the remote verbatim, the last two with the remote's
//! `links` replacing the local markdown-note entries.

use crate::desktop_relay::{Device, NOW, Relay, failed};

use memry_core::domain::note_tasks;
use memry_core::domain::projects::{self, LinkItemType, NewProject, ProjectEdit, StatusInput};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use serde_json::{Value as Json, json};

const PROJECT: &str = "proj-1";

fn create(device: &Device) {
    let who = device.id;
    device
        .db()
        .call_blocking(move |conn| {
            let project = NewProject {
                id: Some(PROJECT),
                name: "Launch",
                description: None,
                color: None,
                icon: None,
                statuses: None,
            };
            projects::create(conn, &project, who, NOW)
                .map(drop)
                .map_err(failed)
        })
        .expect("create");
}

fn update(device: &Device, edit: impl FnOnce(&rusqlite::Connection) -> ProjectEdit<'static>) {
    let who = device.id;
    device
        .db()
        .call_blocking(move |conn| {
            projects::update(conn, PROJECT, &edit(conn), who, NOW + 1)
                .map(drop)
                .map_err(failed)
        })
        .expect("update");
}

/// Renames the first status through the status editor's reconcile, every
/// other status passed back unchanged.
fn rename_first_status(device: &Device, name: &'static str) {
    update(device, |conn| {
        let statuses = projects::statuses(conn, PROJECT).expect("the statuses");
        let inputs: Vec<StatusInput<'static>> = statuses
            .iter()
            .enumerate()
            .map(|(index, status)| StatusInput {
                id: Some(leak(&status.id)),
                name: if index == 0 { name } else { leak(&status.name) },
                color: leak(&status.color),
                status_type: status.status_type(),
                order: status.position,
            })
            .collect();
        ProjectEdit {
            statuses: Some(Vec::leak(inputs)),
            ..ProjectEdit::default()
        }
    });
}

fn leak(text: &str) -> &'static str {
    String::leak(text.to_owned())
}

fn retitle(device: &Device, name: &'static str) {
    update(device, |_| ProjectEdit {
        name: Some(name),
        ..ProjectEdit::default()
    });
}

fn link_event(device: &Device, event_id: &'static str) {
    let who = device.id;
    device
        .db()
        .call_blocking(move |conn| {
            projects::link(
                conn,
                PROJECT,
                LinkItemType::CalendarEvent,
                event_id,
                who,
                NOW + 1,
            )
            .map(drop)
            .map_err(failed)
        })
        .expect("link");
}

fn field(payload: &str, key: &str) -> Json {
    serde_json::from_str::<Json>(payload).expect("json")[key].clone()
}

fn status_names(payload: &str) -> Vec<String> {
    field(payload, "statuses")
        .as_array()
        .expect("a statuses array")
        .iter()
        .map(|status| status["name"].as_str().expect("a name").to_owned())
        .collect()
}

fn projected_status_names(device: &Device) -> Vec<String> {
    device
        .db()
        .call_blocking(|conn| projects::statuses(conn, PROJECT).map_err(failed))
        .expect("the projected statuses")
        .into_iter()
        .map(|status| status.name)
        .collect()
}

async fn synced_pair() -> (Device, Device, Relay) {
    let (a, b, relay) = (Device::bare("a"), Device::bare("b"), Relay::default());
    create(&a);
    relay.sync(&a).await;
    relay.sync(&b).await;
    (a, b, relay)
}

/// The issue's scenario: one device renames a status while the other retitles
/// the project. The device that pulls the concurrent row takes the pusher's
/// `statuses` (`:259-261`) and merges `name` by its field clock (`:211`), then
/// re-pushes at the union clock (§6.5.2 P3), so every device ends where the
/// merging device did. Electron loses the rename when the renaming device is
/// the one that merges; that is the decision this test pins.
#[tokio::test]
async fn a_status_rename_and_a_concurrent_retitle_end_as_electron_ends_them() {
    for renamer_pushes_first in [false, true] {
        let (a, b, relay) = synced_pair().await;
        let original = status_names(&a.stored("project", PROJECT));
        rename_first_status(&a, "Doing now");
        retitle(&b, "From b");

        let (pusher, merger) = if renamer_pushes_first {
            (&a, &b)
        } else {
            (&b, &a)
        };
        relay.push(pusher).await;
        relay.pull(merger).await;
        relay.push(merger).await;
        relay.pull(pusher).await;

        let mut expected = original.clone();
        if renamer_pushes_first {
            expected[0] = "Doing now".to_owned();
        }
        let held = relay.held("project", PROJECT).expect("the server holds it");
        for (who, payload) in [
            ("a", a.stored("project", PROJECT)),
            ("b", b.stored("project", PROJECT)),
            ("server", held),
        ] {
            let case = format!("{who}, renamer pushes first: {renamer_pushes_first}");
            assert_eq!(field(&payload, "name"), json!("From b"), "{case}");
            assert_eq!(status_names(&payload), expected, "{case}");
        }
        assert_eq!(projected_status_names(&a), expected);
        assert_eq!(projected_status_names(&b), expected);
    }
}

/// `if (data.statuses)` / `if (data.links)` (`:259-265`) guard both branches,
/// so a remote that omits either key leaves the local one, whether the remote
/// dominates (wholesale, the FIX-5126 Low) or is concurrent. A project pushed
/// by a build older than the hub (no `links`) cannot unlink the local items.
#[tokio::test]
async fn a_remote_without_statuses_or_links_keeps_the_local_ones() {
    for dominating in [true, false] {
        let (a, relay) = (Device::bare("a"), Relay::default());
        create(&a);
        relay.sync(&a).await;
        link_event(&a, "event-1");
        let local = a.stored("project", PROJECT);

        let clock = if dominating {
            json!({"a": 2, "peer": 1})
        } else {
            json!({"a": 1, "peer": 1})
        };
        relay.put(
            "project",
            PROJECT,
            &json!({
                "id": PROJECT, "name": "From peer", "color": "#6366f1", "position": 0,
                "isInbox": false, "clock": clock,
                "fieldClocks": {"name": {"a": 1, "peer": 1}},
            })
            .to_string(),
        );
        relay.pull(&a).await;

        let stored = a.stored("project", PROJECT);
        assert_eq!(field(&stored, "name"), json!("From peer"), "{dominating}");
        assert_eq!(
            field(&stored, "links"),
            field(&local, "links"),
            "{dominating}"
        );
        assert_eq!(
            field(&stored, "statuses"),
            field(&local, "statuses"),
            "{dominating}"
        );
        assert_eq!(
            a.count("SELECT COUNT(*) FROM project_links WHERE item_id = 'event-1'"),
            1,
            "{dominating}"
        );
    }
}

/// An Electron peer's row as `buildPushPayload` writes it (`:374-387`: every
/// project column, then the `statuses` and `links` table rows), concurrent
/// with a local retitle. The merge keeps the local `name` (its field clock is
/// ahead) and takes Electron's arrays as they came, row keys included; the
/// re-push carries them.
#[tokio::test]
async fn an_electron_peers_arrays_round_trip_through_a_core_merge() {
    let (a, relay) = (Device::bare("a"), Relay::default());
    create(&a);
    relay.sync(&a).await;
    retitle(&a, "From a");

    let statuses = json!([
        {"id": "st-1", "projectId": PROJECT, "name": "Backlog", "color": "#6b7280",
         "position": 0, "isDefault": true, "isDone": false,
         "createdAt": "2025-10-09T08:53:20.000Z"},
        {"id": "st-2", "projectId": PROJECT, "name": "Shipped", "color": "#22c55e",
         "position": 1, "isDefault": false, "isDone": true,
         "createdAt": "2025-10-09T08:53:20.000Z"},
    ]);
    let links = json!([
        {"id": "lk-1", "projectId": PROJECT, "itemType": "calendar_event",
         "itemId": "event-9", "position": 0, "pinned": 1,
         "createdAt": "2025-10-09T08:53:21.000Z"},
    ]);
    relay.put(
        "project",
        PROJECT,
        &json!({
            "id": PROJECT, "name": "Launch", "description": null, "color": "#f97316",
            "icon": null, "position": 0, "isInbox": false, "archivedAt": null,
            "homeNoteId": null, "clock": {"a": 1, "peer": 1},
            "fieldClocks": {"name": {"a": 1}, "color": {"a": 1, "peer": 1}},
            "syncedAt": "2025-10-09T08:53:21.000Z",
            "createdAt": "2025-10-09T08:53:20.000Z",
            "modifiedAt": "2025-10-09T08:53:21.000Z",
            "statuses": statuses, "links": links,
        })
        .to_string(),
    );
    relay.pull(&a).await;
    relay.push(&a).await;

    let held = relay.held("project", PROJECT).expect("the server holds it");
    assert_eq!(field(&held, "name"), json!("From a"));
    assert_eq!(field(&held, "color"), json!("#f97316"));
    assert_eq!(field(&held, "statuses"), statuses);
    assert_eq!(field(&held, "links"), links);
    assert_eq!(projected_status_names(&a), ["Backlog", "Shipped"]);
    let linked = a
        .db()
        .call_blocking(|conn| projects::links(conn, PROJECT).map_err(failed))
        .expect("the links");
    assert_eq!(linked.len(), 1);
    assert!(linked[0].pinned && linked[0].item_id == "event-9");
}

/// A concurrent remote whose `statuses` or `links` is not an array, or holds an
/// entry `StatusSyncSchema` / `ProjectLinkSyncSchema` refuses, is refused, as
/// `ProjectSyncPayloadSchema` refuses it on Electron and the projector refuses
/// a non-array on the wholesale path. The local row is left as it was.
#[tokio::test]
async fn a_malformed_remote_array_flags_the_record_corrupt() {
    let cases = [
        (
            "statuses",
            json!("todo"),
            "remote `statuses` is not an array",
        ),
        (
            "statuses",
            json!([42]),
            "remote `statuses` entry 0 is malformed",
        ),
        (
            "statuses",
            json!([{"id": "s1", "name": "Todo", "color": "#888", "position": 0},
                   {"id": "s2", "name": "Done", "position": 1}]),
            "remote `statuses` entry 1 is malformed",
        ),
        (
            "links",
            json!([{"id": "l1", "itemType": "file", "itemId": "f1", "position": 0,
                    "pinned": true}]),
            "remote `links` entry 0 is malformed",
        ),
    ];
    for (key, value, reason) in cases {
        let (a, relay) = (Device::bare("a"), Relay::default());
        create(&a);
        relay.sync(&a).await;
        retitle(&a, "From a");
        let local = a.stored("project", PROJECT);

        let mut remote = json!({
            "id": PROJECT, "name": "From peer", "clock": {"a": 1, "peer": 1},
            "fieldClocks": {"name": {"a": 1, "peer": 1}},
        });
        remote[key] = value;
        relay.put("project", PROJECT, &remote.to_string());
        relay.pull(&a).await;

        let sql = format!(
            "SELECT COUNT(*) FROM sync_items WHERE item_type = 'project' AND item_id = 'proj-1'
             AND corrupt_reason LIKE '%project proj-1: {reason}%'"
        );
        assert_eq!(a.count(leak(&sql)), 1, "{reason}");
        let stored = a.stored("project", PROJECT);
        assert_eq!(field(&stored, "name"), json!("From a"), "{reason}");
        assert_eq!(field(&stored, key), field(&local, key), "{reason}");
    }
}

/// A markdown note the peer wrote, on `device` as its pull would store it.
fn seed_markdown_note(device: &Device) {
    device
        .db()
        .call_blocking(|conn| {
            let record = InboundRecord {
                item_type: "note".to_owned(),
                item_id: "note-1".to_owned(),
                payload_json: json!({
                    "title": "Plan", "fileType": "markdown", "folderPath": "",
                    "properties": {}, "clock": {"peer": 1},
                })
                .to_string(),
                server_cursor: None,
                signer_device_id: Some("peer".to_owned()),
                updated_at: NOW,
                deleted_at: None,
            };
            sync_items::apply_remote(conn, &record, NOW)
                .map(drop)
                .map_err(failed)
        })
        .expect("seed the note");
}

fn link_note(device: &Device) {
    let who = device.id;
    device
        .db()
        .call_blocking(move |conn| {
            projects::link(conn, PROJECT, LinkItemType::Note, "note-1", who, NOW + 1)
                .map(drop)
                .map_err(failed)
        })
        .expect("link the note");
}

/// The project hub's item ids, and the note's project chips.
fn hub_and_chips(device: &Device) -> (Vec<String>, Vec<String>) {
    device
        .db()
        .call_blocking(|conn| {
            let hub = projects::links(conn, PROJECT)
                .map_err(failed)?
                .into_iter()
                .map(|link| link.item_id)
                .collect();
            let chips = note_tasks::note_project_ids(conn, "note-1").map_err(failed)?;
            Ok((hub, chips))
        })
        .expect("the hub and the chip")
}

/// REVIEW-5156 finding 1. A markdown note's membership is its `project`
/// property: `reconcileLinks` (`:116-137`) deletes only table-owned rows, so
/// Electron keeps the note in the hub whatever `links` a concurrent remote
/// carries. A links the note, B concurrently retitles the project with
/// `links: []`; whichever device merges keeps the entry, and both devices end
/// with the hub entry and the note's project chip.
#[tokio::test]
async fn a_markdown_notes_link_survives_a_concurrent_retitle_on_both_devices() {
    for linker_pushes_first in [false, true] {
        let (a, b, relay) = synced_pair().await;
        seed_markdown_note(&a);
        seed_markdown_note(&b);
        link_note(&a);
        retitle(&b, "From b");

        let (pusher, merger) = if linker_pushes_first {
            (&a, &b)
        } else {
            (&b, &a)
        };
        relay.push(pusher).await;
        relay.pull(merger).await;
        relay.push(merger).await;
        relay.pull(pusher).await;

        for (who, device) in [("a", &a), ("b", &b)] {
            let case = format!("{who}, linker pushes first: {linker_pushes_first}");
            let stored = device.stored("project", PROJECT);
            assert_eq!(field(&stored, "name"), json!("From b"), "{case}");
            let (hub, chips) = hub_and_chips(device);
            assert_eq!(hub, ["note-1"], "{case}");
            assert_eq!(chips, [PROJECT], "{case}");
        }
    }
}

/// The wholesale half of finding 1: a peer that never derived the note's link
/// (an Electron device that has not pulled the note yet) pushes a dominating
/// row with `links: []`. The local entry stays while the note names the
/// project, as Electron's derived row stays.
#[tokio::test]
async fn a_markdown_notes_link_survives_a_dominating_remote_without_it() {
    let (a, relay) = (Device::bare("a"), Relay::default());
    create(&a);
    seed_markdown_note(&a);
    link_note(&a);
    relay.sync(&a).await;

    relay.put(
        "project",
        PROJECT,
        &json!({
            "id": PROJECT, "name": "Launch", "color": "#6366f1", "position": 0,
            "isInbox": false, "clock": {"a": 2, "peer": 1},
            "fieldClocks": {"name": {"a": 1}}, "links": [],
        })
        .to_string(),
    );
    relay.pull(&a).await;

    assert_eq!(
        hub_and_chips(&a),
        (vec!["note-1".to_owned()], vec![PROJECT.to_owned()])
    );
}
