//! Two core vaults declaring `Declaration::desktop()` over one relay server
//! converge on every desktop-only record type (Step 16, #3533, chapter 13
//! §13.9). Each sync is a pull then a push, as a pass runs; the merged row a
//! pull leaves is what the push sends (§6.5.2 P2).
//!
//! The winner of a concurrent whole-record edit is desktop's: a remote whose
//! clock is concurrent with the local one applies over it under the merged
//! clock (`resolveClockConflict`'s `merge`,
//! `packages/sync-client/src/item-handlers/types.ts:72-86`, taken by
//! `sticky-draft-handler.ts:35-49`, `canvas-folder-handler.ts:65-101` and
//! `home-page-handler.ts:54-80`). In pull-then-push passes the second device
//! pulls the first one's edit before it pushes, so the first device to push
//! wins on both.

use crate::desktop_relay::{Device, NOW, Relay, failed};

use memry_core::domain::agent_conversation::{
    self, Conversation, ConversationPatch, NewConversation,
};
use memry_core::domain::agent_message::{self, NewMessage};
use memry_core::domain::canvas_folder;
use memry_core::domain::home_page::{self, HomePagePatch, NewHomePage};
use memry_core::domain::sticky_draft::{self, StickyKind};
use memry_core::domain::vault_locks::{self, TargetKind};
use memry_core::sync::clock::{ClockOrder, VectorClock, compare};
use serde_json::{Value as Json, json};

fn conversation(device: &Device, id: &str) -> Conversation {
    let key = device.vault.at_rest_key();
    let id = id.to_owned();
    device
        .db()
        .call_blocking(move |conn| agent_conversation::get(conn, &key, &id).map_err(failed))
        .expect("read")
        .expect("a live conversation")
}

fn patch(device: &Device, id: &str, patch: ConversationPatch<'static>, at: i64) {
    let key = device.vault.at_rest_key();
    let (id, who) = (id.to_owned(), device.id);
    device
        .db()
        .call_blocking(move |conn| {
            agent_conversation::update_fields(conn, &key, &id, &patch, who, at)
                .map(drop)
                .map_err(failed)
        })
        .expect("an edit");
}

fn clock(payload: &str) -> VectorClock {
    let payload: Json = serde_json::from_str(payload).expect("json");
    serde_json::from_value(payload["clock"].clone()).expect("a clock")
}

#[tokio::test]
async fn concurrent_edits_to_a_conversations_title_and_pin_merge_per_field() {
    let (a, b, relay) = (Device::keyed("a"), Device::keyed("b"), Relay::default());
    let key = a.vault.at_rest_key();
    let created = a
        .db()
        .call_blocking(move |conn| {
            let new = NewConversation {
                vault_id: "vault-1",
                title: "Plan",
                backend: "local",
                backend_model: None,
            };
            agent_conversation::create(conn, &key, &new, "a", NOW).map_err(failed)
        })
        .expect("create");
    relay.sync(&a).await;
    relay.sync(&b).await;
    assert_eq!(conversation(&b, &created.id), created);

    let title = ConversationPatch {
        title: Some("Plan for Q3"),
        ..ConversationPatch::default()
    };
    let pin = ConversationPatch {
        pinned: Some(true),
        ..ConversationPatch::default()
    };
    patch(&a, &created.id, title, NOW + 10);
    patch(&b, &created.id, pin, NOW + 20);
    relay.sync(&a).await;
    relay.sync(&b).await;
    relay.sync(&a).await;

    let (on_a, on_b) = (conversation(&a, &created.id), conversation(&b, &created.id));
    assert_eq!(on_a.title, "Plan for Q3", "A's title survives B's pin");
    assert!(on_a.pinned, "B's pin survives A's title");
    assert_eq!(on_a, on_b);
}

#[tokio::test]
async fn a_message_appended_on_one_device_reads_back_on_the_other() {
    let (a, b, relay) = (Device::keyed("a"), Device::keyed("b"), Relay::default());
    let key = a.vault.at_rest_key();
    let content = json!({"role": "user", "data": {"text": "what is due"}});
    let appended = a
        .db()
        .call_blocking(move |conn| {
            let new = NewMessage {
                id: Some("m1"),
                conversation_id: "conv-1",
                role: "user",
                content: &content,
                attachments: &json!([]),
                tool_call_id: None,
                status: "completed",
            };
            agent_message::append(conn, &key, &new, "a", NOW).map_err(failed)
        })
        .expect("append");
    relay.sync(&a).await;
    relay.sync(&b).await;
    let key = b.vault.at_rest_key();
    let on_b = b
        .db()
        .call_blocking(move |conn| {
            agent_message::get_by_conversation(conn, &key, "conv-1").map_err(failed)
        })
        .expect("read");
    assert_eq!(on_b, vec![appended]);
}

#[tokio::test]
async fn concurrent_edits_to_a_sticky_draft_keep_the_first_push_on_both() {
    let (a, b, relay) = (Device::bare("a"), Device::bare("b"), Relay::default());
    let id = a
        .db()
        .call_blocking(|conn| sticky_draft::upsert(conn, None, "start", StickyKind::Note, "a", NOW))
        .expect("create")
        .id;
    relay.sync(&a).await;
    relay.sync(&b).await;

    for (device, text, at) in [(&a, "from a", NOW + 10), (&b, "from b", NOW + 20)] {
        let (id, who) = (id.clone(), device.id);
        device
            .db()
            .call_blocking(move |conn| {
                sticky_draft::upsert(conn, Some(&id), text, StickyKind::Task, who, at)
            })
            .expect("an edit");
    }
    let edits = [
        clock(&a.stored("sticky_draft", &id)),
        clock(&b.stored("sticky_draft", &id)),
    ];
    assert_eq!(compare(&edits[0], &edits[1]), ClockOrder::Concurrent);
    relay.sync(&a).await;
    relay.sync(&b).await;
    relay.sync(&a).await;

    let stored = a.stored("sticky_draft", &id);
    assert_eq!(
        stored,
        b.stored("sticky_draft", &id),
        "both hold one record"
    );
    for edit in &edits {
        assert_eq!(
            compare(&clock(&stored), edit),
            ClockOrder::After,
            "the kept record's clock is after both edits"
        );
    }
    let draft = a
        .db()
        .call_blocking(move |conn| sticky_draft::get(conn, &id))
        .expect("read")
        .expect("a live draft");
    assert_eq!(draft.content, "from a", "a pushed first");
}

#[tokio::test]
async fn a_vault_lock_removed_on_one_device_is_gone_on_the_other() {
    let (a, b, relay) = (Device::bare("a"), Device::bare("b"), Relay::default());
    let set = |device: &Device, locked: bool, at: i64| {
        let who = device.id;
        device
            .db()
            .call_blocking(move |conn| {
                vault_locks::set(conn, TargetKind::Folder, "Projects", locked, who, at).map(drop)
            })
            .expect("set");
    };
    let folders = |device: &Device| {
        device
            .db()
            .call_blocking(|conn| vault_locks::list(conn))
            .expect("list")
            .folders
    };
    set(&a, true, NOW);
    relay.sync(&a).await;
    relay.sync(&b).await;
    assert_eq!(folders(&b), ["Projects"]);

    set(&a, false, NOW + 10);
    relay.sync(&a).await;
    relay.sync(&b).await;
    assert!(folders(&a).is_empty());
    assert!(
        folders(&b).is_empty(),
        "the unlock reached the other device"
    );
}

/// The two document-level types without a named case above: concurrent edits
/// on both sides end in a's record on both, since a pushed first.
#[tokio::test]
async fn concurrent_edits_to_a_canvas_folder_and_a_home_board_converge() {
    let (a, b, relay) = (Device::bare("a"), Device::bare("b"), Relay::default());
    let board = a
        .db()
        .call_blocking(|conn| {
            canvas_folder::upsert(conn, "vault-1", "Work", Some(Some("star")), "a", NOW)?;
            let new = NewHomePage {
                name: "Home",
                icon: None,
                position: 0.0,
                widgets: "[]",
                cover: None,
            };
            home_page::create(conn, &new, "a", NOW)
        })
        .expect("create")
        .id;
    relay.sync(&a).await;
    relay.sync(&b).await;

    for (device, icon, name, at) in [
        (&a, "moon", "Home A", NOW + 10),
        (&b, "sun", "Home B", NOW + 20),
    ] {
        let (board, who) = (board.clone(), device.id);
        device
            .db()
            .call_blocking(move |conn| {
                canvas_folder::upsert(conn, "vault-1", "Work", Some(Some(icon)), who, at)?;
                let patch = HomePagePatch {
                    name: Some(name),
                    ..HomePagePatch::default()
                };
                home_page::update(conn, &board, &patch, who, at).map(drop)
            })
            .expect("an edit");
    }
    relay.sync(&a).await;
    relay.sync(&b).await;
    relay.sync(&a).await;

    let folder = canvas_folder::sync_id("Work");
    assert_eq!(
        a.stored("canvas_folder", &folder),
        b.stored("canvas_folder", &folder)
    );
    assert_eq!(a.stored("home_page", &board), b.stored("home_page", &board));
    let (icon, name) = a
        .db()
        .call_blocking(move |conn| {
            let icon = canvas_folder::list(conn)?.remove(0).icon;
            let name = home_page::get(conn, &board)?.expect("a live board").name;
            Ok((icon, name))
        })
        .expect("read");
    assert_eq!(
        (icon.as_deref(), name.as_str()),
        (Some("moon"), "Home A"),
        "a pushed first"
    );
}
