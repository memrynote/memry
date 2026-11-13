//! A delete on one device against a concurrent edit on the other, for the
//! desktop-only record types, over the relay that serves deletes (Step 16,
//! #3533, chapter 13 §13.9, chapter 05 §5.12).
//!
//! Desktop's rule: a remote tombstone is skipped only when the local clock is
//! strictly after it (`resolveDeleteClock`,
//! `packages/sync-client/src/item-handlers/base-handler.ts:122-128`, over
//! `resolveClockConflict`, `types.ts:72-86`). A delete concurrent with an edit
//! therefore applies, so the delete that reaches the server first wins on both
//! devices: `sticky-draft-handler.ts:80-91`,
//! `canvas-folder-handler.ts:135-160`, `home-page-handler.ts:123-135` and
//! `agent-message-handler.ts:187-210`.

use crate::desktop_relay::{Device, NOW, Relay, failed};

use memry_core::api::errors::StorageError;
use memry_core::crypto::agent_envelope::AtRestKey;
use memry_core::domain::agent_message::{self, NewMessage};
use memry_core::domain::canvas_folder;
use memry_core::domain::home_page::{self, HomePagePatch, NewHomePage};
use memry_core::domain::sticky_draft::{self, StickyKind};
use rusqlite::Connection;
use serde_json::json;

const CONVERSATION: &str = "conv-1";

/// The record each case races on, created through the type's own write.
/// Returns its id.
fn create(device: &Device, item_type: &'static str) -> String {
    let key = device.vault.at_rest_key();
    let who = device.id;
    device
        .db()
        .call_blocking(move |conn| match item_type {
            "sticky_draft" => {
                sticky_draft::upsert(conn, None, "start", StickyKind::Note, who, NOW).map(|d| d.id)
            }
            "canvas_folder" => {
                canvas_folder::upsert(conn, "vault-1", "Work", Some(Some("star")), who, NOW)?;
                Ok(canvas_folder::sync_id("Work"))
            }
            "home_page" => {
                let new = NewHomePage {
                    name: "Home",
                    icon: None,
                    position: 0.0,
                    widgets: "[]",
                    cover: None,
                };
                home_page::create(conn, &new, who, NOW).map(|board| board.id)
            }
            _ => append(conn, &key, "m1", who).map(|()| "m1".to_owned()),
        })
        .expect("create")
}

fn append(conn: &Connection, key: &AtRestKey, id: &str, who: &str) -> Result<(), StorageError> {
    let content = json!({"role": "user", "data": {"text": id}});
    let new = NewMessage {
        id: Some(id),
        conversation_id: CONVERSATION,
        role: "user",
        content: &content,
        attachments: &json!([]),
        tool_call_id: None,
        status: "completed",
    };
    agent_message::append(conn, key, &new, who, NOW + 10)
        .map(drop)
        .map_err(failed)
}

/// A concurrent edit of the record on `device`. A message is written once
/// (`agent-message-handler.ts:179-183`), so its one competing write is a reply
/// appended to the same conversation.
fn edit(device: &Device, item_type: &'static str, id: &str) {
    let key = device.vault.at_rest_key();
    let (id, who, at) = (id.to_owned(), device.id, NOW + 20);
    device
        .db()
        .call_blocking(move |conn| match item_type {
            "sticky_draft" => {
                sticky_draft::upsert(conn, Some(&id), "edited", StickyKind::Task, who, at).map(drop)
            }
            "canvas_folder" => {
                canvas_folder::upsert(conn, "vault-1", "Work", Some(Some("moon")), who, at)
                    .map(drop)
            }
            "home_page" => {
                let patch = HomePagePatch {
                    name: Some("Edited"),
                    ..HomePagePatch::default()
                };
                home_page::update(conn, &id, &patch, who, at).map(drop)
            }
            _ => append(conn, &key, "m2", who),
        })
        .expect("an edit");
}

fn delete(device: &Device, item_type: &'static str, id: &str) {
    let (id, who, at) = (id.to_owned(), device.id, NOW + 10);
    let deleted = device
        .db()
        .call_blocking(move |conn| match item_type {
            "sticky_draft" => sticky_draft::delete(conn, &id, who, at),
            "canvas_folder" => canvas_folder::delete(conn, "Work", who, at),
            "home_page" => home_page::delete(conn, &id, who, at),
            _ => agent_message::delete(conn, &id, who, at),
        })
        .expect("a delete");
    assert!(deleted);
}

/// The live records of `item_type` the device's own reads return, by id.
fn visible(device: &Device, item_type: &'static str) -> Vec<String> {
    let key = device.vault.at_rest_key();
    device
        .db()
        .call_blocking(move |conn| {
            Ok(match item_type {
                "sticky_draft" => sticky_draft::list(conn)?
                    .into_iter()
                    .map(|d| d.id)
                    .collect(),
                "canvas_folder" => canvas_folder::list(conn)?
                    .into_iter()
                    .map(|folder| folder.id)
                    .collect(),
                "home_page" => home_page::list(conn)?
                    .into_iter()
                    .map(|board| board.id)
                    .collect(),
                _ => agent_message::get_by_conversation(conn, &key, CONVERSATION)
                    .map_err(failed)?
                    .into_iter()
                    .map(|message| message.id)
                    .collect(),
            })
        })
        .expect("a read")
}

/// A deletes while B edits; A's pass runs first, so its tombstone reaches the
/// server first and wins on both devices.
async fn the_delete_pushed_first_wins(item_type: &'static str, survivors: &[&str]) {
    let (a, b, relay) = (Device::keyed("a"), Device::keyed("b"), Relay::default());
    let id = create(&a, item_type);
    relay.sync(&a).await;
    relay.sync(&b).await;
    assert_eq!(
        visible(&b, item_type),
        [id.as_str()],
        "{item_type} reached b"
    );

    delete(&a, item_type, &id);
    edit(&b, item_type, &id);
    relay.sync(&a).await;
    relay.sync(&b).await;
    relay.sync(&a).await;

    assert_eq!(visible(&a, item_type), survivors, "{item_type} on a");
    assert_eq!(visible(&b, item_type), survivors, "{item_type} on b");
}

#[tokio::test]
async fn a_sticky_draft_deleted_against_a_concurrent_edit_is_gone_on_both() {
    the_delete_pushed_first_wins("sticky_draft", &[]).await;
}

#[tokio::test]
async fn a_canvas_folder_deleted_against_a_concurrent_edit_is_gone_on_both() {
    the_delete_pushed_first_wins("canvas_folder", &[]).await;
}

#[tokio::test]
async fn a_home_board_deleted_against_a_concurrent_edit_is_gone_on_both() {
    the_delete_pushed_first_wins("home_page", &[]).await;
}

#[tokio::test]
async fn a_message_deleted_against_a_concurrent_reply_leaves_the_reply_on_both() {
    the_delete_pushed_first_wins("agent_message", &["m2"]).await;
}

/// Both devices push before either pulls. The server holds the last push, and
/// the earlier pusher takes it on pull: its clock is concurrent with the
/// local one, and a concurrent remote applies (`resolveClockConflict`'s
/// `merge`, `sticky-draft-handler.ts:35-49`). B's pull of its own record is an
/// equal clock with an identical payload, so B keeps it.
#[tokio::test]
async fn two_pushes_then_two_pulls_keep_the_last_push_on_both() {
    let (a, b, relay) = (Device::keyed("a"), Device::keyed("b"), Relay::default());
    let id = create(&a, "sticky_draft");
    relay.sync(&a).await;
    relay.sync(&b).await;

    for (device, text) in [(&a, "from a"), (&b, "from b")] {
        let (id, who) = (id.clone(), device.id);
        device
            .db()
            .call_blocking(move |conn| {
                sticky_draft::upsert(conn, Some(&id), text, StickyKind::Note, who, NOW + 10)
            })
            .expect("an edit");
    }
    relay.push(&a).await;
    relay.push(&b).await;
    relay.pull(&a).await;
    relay.pull(&b).await;

    for device in [&a, &b] {
        let draft = device
            .db()
            .call_blocking({
                let id = id.clone();
                move |conn| sticky_draft::get(conn, &id)
            })
            .expect("a read")
            .expect("a live draft");
        assert_eq!(draft.content, "from b", "on {}", device.id);
    }
}
