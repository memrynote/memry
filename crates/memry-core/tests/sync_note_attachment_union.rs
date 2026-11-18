//! Chapter 06 §6.8.1 between two core vaults and one relay server: a remote
//! `note` apply unions `attachmentReferences` as Electron's note handler does
//! (`apps/desktop/src/main/sync/item-handlers/note-handler.ts:135-145`,
//! `:537-553`), so an attachment one device uploaded survives the other
//! device's concurrent edit and its union-clock re-push (§6.5.2 P3).
//!
//! | Test                                                   | Rule              |
//! | ------------------------------------------------------ | ----------------- |
//! | two devices upload at once, both ids reach both        | §6.8.1, P3        |
//! | a removal concurrent with an add comes back            | §6.8.1 removal    |
//! | a removal from a newer peer does not remove here       | §6.8.1 removal    |
//! | an Electron peer's row merges local-first, deduped     | §6.8.1 order      |
//! | an absent, null or empty remote list keeps the local   | §6.8.1, §14.7     |
//! | an id the server proved gone is pruned from the union  | §6.8.1 prune      |

use crate::desktop_relay::{Device, NOW, Relay, failed};

use memry_core::domain::notes::{self, NewNote};
use memry_core::sync::attachments::store::download_failures::{
    self as failures, FailureReason, MISSING_PROBE_LIMIT,
};
use serde_json::{Value as Json, json};

const NOTE: &str = "note-1";

fn create(device: &Device) {
    let who = device.id;
    device
        .db()
        .call_blocking(move |conn| {
            let note = NewNote {
                id: NOTE,
                title: "Trip",
                folder_path: None,
                content: "",
                tags: &[],
                properties: None,
                emoji: None,
            };
            notes::create(conn, &note, who, NOW)
                .map(drop)
                .map_err(failed)
        })
        .expect("create");
}

/// What an upload on `device` records on the note (§14.7).
fn upload(device: &Device, attachment: &'static str, at: i64) {
    let who = device.id;
    device
        .db()
        .call_blocking(move |conn| {
            notes::add_attachment_reference(conn, NOTE, attachment, who, at)
                .map(drop)
                .map_err(failed)
        })
        .expect("add the reference");
}

fn remove(device: &Device, attachment: &'static str, at: i64) {
    let who = device.id;
    device
        .db()
        .call_blocking(move |conn| {
            notes::remove_attachment_reference(conn, NOTE, attachment, who, at)
                .map(drop)
                .map_err(failed)
        })
        .expect("remove the reference");
}

fn field(payload: &str, key: &str) -> Json {
    serde_json::from_str::<Json>(payload).expect("json")[key].clone()
}

fn refs(payload: &str) -> Json {
    field(payload, "attachmentReferences")
}

/// The projected column the rest of the core reads (`read_attachment_references`).
fn column(device: &Device) -> Json {
    let raw: Option<String> = device
        .db()
        .call_blocking(|conn| {
            conn.query_row(
                "SELECT attachment_references FROM notes WHERE id = ?1",
                [NOTE],
                |row| row.get(0),
            )
            .map_err(failed)
        })
        .expect("the notes row");
    raw.map_or(Json::Null, |raw| serde_json::from_str(&raw).expect("json"))
}

async fn synced_pair(initial: &[&'static str]) -> (Device, Device, Relay) {
    let (a, b, relay) = (Device::bare("a"), Device::bare("b"), Relay::default());
    create(&a);
    for attachment in initial {
        upload(&a, attachment, NOW);
    }
    relay.sync(&a).await;
    relay.sync(&b).await;
    (a, b, relay)
}

/// b pushes, a pulls (the concurrent merge) and pushes the merged row, b
/// pulls it: the stored list on a, on b and on the server.
async fn round_trip(a: &Device, b: &Device, relay: &Relay) -> [Json; 3] {
    relay.push(b).await;
    relay.pull(a).await;
    relay.push(a).await;
    relay.pull(b).await;
    [
        refs(&a.stored("note", NOTE)),
        refs(&b.stored("note", NOTE)),
        refs(&relay.held("note", NOTE).expect("the server holds the note")),
    ]
}

/// REVIEW-5118 finding 3: each device uploads a picture into the same note at
/// once. Before the union, a's merge stored b's payload under the union clock
/// and re-pushed it, so `att-a` was lost on every device.
#[tokio::test]
async fn two_devices_uploading_at_once_keep_both_ids_on_both_devices() {
    let (a, b, relay) = synced_pair(&[]).await;
    upload(&a, "att-a", NOW + 1);
    upload(&b, "att-b", NOW + 2);

    let [on_a, on_b, on_server] = round_trip(&a, &b, &relay).await;
    // Local entries first, then the remote's new ones, on each device.
    assert_eq!(on_a, json!(["att-a", "att-b"]), "on a");
    assert_eq!(on_server, json!(["att-a", "att-b"]), "on the server");
    assert_eq!(on_b, json!(["att-b", "att-a"]), "on b");
    assert_eq!(column(&a), json!(["att-a", "att-b"]), "a's notes row");
    assert_eq!(column(&b), json!(["att-b", "att-a"]), "b's notes row");
}

/// Electron's union has no removal set: an id one side removed while the other
/// side still holds it comes back on every device.
#[tokio::test]
async fn a_removal_concurrent_with_an_upload_comes_back_as_electron_brings_it_back() {
    let (a, b, relay) = synced_pair(&["keep", "drop"]).await;
    remove(&a, "drop", NOW + 1);
    upload(&b, "new", NOW + 2);

    let [on_a, on_b, on_server] = round_trip(&a, &b, &relay).await;
    assert_eq!(on_a, json!(["keep", "drop", "new"]), "on a");
    assert_eq!(on_server, json!(["keep", "drop", "new"]), "on the server");
    assert_eq!(on_b, json!(["keep", "drop", "new"]), "on b");
}

/// The union runs on every apply over an existing note, not only a concurrent
/// one (`note-handler.ts:537-553` sits after both branches): a peer whose
/// clock dominates and that removed an id does not remove it here.
#[tokio::test]
async fn a_removal_from_a_dominating_peer_keeps_the_id_here() {
    let (a, b, relay) = synced_pair(&["keep", "drop"]).await;
    remove(&a, "drop", NOW + 1);
    relay.push(&a).await;
    relay.pull(&b).await;

    assert_eq!(
        refs(&relay.held("note", NOTE).expect("held")),
        json!(["keep"])
    );
    assert_eq!(refs(&b.stored("note", NOTE)), json!(["keep", "drop"]));
    assert_eq!(column(&b), json!(["keep", "drop"]));
}

/// An Electron peer's push (`buildNotePushPayload`) merged on a core device:
/// local first, then the remote's new ids, a remote duplicate dropped. The
/// merged push carries the union under the union clock, which an Electron
/// peer reads as dominating its own row.
#[tokio::test]
async fn an_electron_peers_row_merges_local_first_and_pushes_the_union() {
    let (a, relay) = (Device::bare("a"), Relay::default());
    create(&a);
    upload(&a, "att-a", NOW);
    relay.sync(&a).await;
    upload(&a, "att-c", NOW + 1);
    let local_clock = field(&a.stored("note", NOTE), "clock");
    assert_eq!(local_clock, json!({"a": 3}));

    relay.put(
        "note",
        NOTE,
        &electron_note(
            json!(["att-b", "att-a", "att-b"]),
            json!({"a": 2, "peer": 1}),
        )
        .to_string(),
    );
    relay.pull(&a).await;
    relay.push(&a).await;

    let held = relay.held("note", NOTE).expect("the server holds the note");
    assert_eq!(refs(&held), json!(["att-a", "att-c", "att-b"]));
    assert_eq!(field(&held, "title"), json!("From peer"));
    assert_eq!(field(&held, "clock"), json!({"a": 3, "peer": 1}));
}

/// `if (!remote?.length) return undefined` (`:139`): a remote that omits the
/// list, nulls it or sends `[]` leaves the local list, on the concurrent
/// branch and when the remote dominates (§14.7: absence is "does not know").
#[tokio::test]
async fn an_absent_null_or_empty_remote_list_keeps_the_local_list() {
    for (remote, clock) in [
        (None, json!({"a": 2, "peer": 1})),
        (Some(Json::Null), json!({"a": 2, "peer": 1})),
        (Some(json!([])), json!({"a": 2, "peer": 1})),
        (None, json!({"a": 9, "peer": 1})),
        (Some(Json::Null), json!({"a": 9, "peer": 1})),
        (Some(json!([])), json!({"a": 9, "peer": 1})),
    ] {
        let (a, relay) = (Device::bare("a"), Relay::default());
        create(&a);
        upload(&a, "att-a", NOW);
        relay.sync(&a).await;
        upload(&a, "att-c", NOW + 1);

        let mut payload = electron_note(Json::Null, clock.clone());
        match &remote {
            None => drop(
                payload
                    .as_object_mut()
                    .expect("object")
                    .remove("attachmentReferences"),
            ),
            Some(value) => payload["attachmentReferences"] = value.clone(),
        }
        relay.put("note", NOTE, &payload.to_string());
        relay.pull(&a).await;

        let stored = a.stored("note", NOTE);
        let case = format!("remote {remote:?} at {clock}");
        assert_eq!(field(&stored, "title"), json!("From peer"), "{case}");
        assert_eq!(refs(&stored), json!(["att-a", "att-c"]), "{case}");
        assert_eq!(column(&a), json!(["att-a", "att-c"]), "{case}");
    }
}

/// `pruneUnresolvableReferences` (`:541-543`): an id this device has watched
/// the server 404 on its last probe is dropped from the union.
#[tokio::test]
async fn an_id_the_server_proved_gone_is_pruned_from_the_union() {
    let (a, relay) = (Device::bare("a"), Relay::default());
    create(&a);
    upload(&a, "att-a", NOW);
    relay.sync(&a).await;
    upload(&a, "att-c", NOW + 1);
    a.db()
        .call_blocking(|conn| {
            for _ in 0..MISSING_PROBE_LIMIT {
                failures::record_failure(conn, NOTE, "gone", FailureReason::Missing, "404", 0)?;
            }
            Ok(())
        })
        .expect("give up on the id");

    relay.put(
        "note",
        NOTE,
        &electron_note(json!(["gone", "att-b"]), json!({"a": 2, "peer": 1})).to_string(),
    );
    relay.pull(&a).await;

    assert_eq!(
        refs(&a.stored("note", NOTE)),
        json!(["att-a", "att-c", "att-b"])
    );
}

/// `buildNotePushPayload` (`note-handler-sync-helpers.ts:66-90`) for a
/// markdown note.
fn electron_note(references: Json, clock: Json) -> Json {
    json!({
        "title": "From peer", "content": null, "tags": [], "properties": {},
        "pinnedTags": [], "emoji": null, "fileType": "markdown", "folderPath": null,
        "attachmentReferences": references,
        "clock": clock,
        "createdAt": "2025-10-09T08:53:20.000Z", "modifiedAt": "2025-10-09T08:53:21.000Z",
    })
}
