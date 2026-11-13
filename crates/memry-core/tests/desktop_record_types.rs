//! The six desktop-only record types through `Declaration::desktop()`
//! (Step 16, #3533, chapter 13 §13.1, §13.2): a page holding one of each
//! lands whole, and a key this build does not model survives a local edit all
//! the way to the push.

use crate::desktop_relay::{Device, NOW, Relay, TYPES, failed, id_of, wire};

use memry_core::api::runtime;
use memry_core::domain::agent_conversation::{self, ConversationPatch};
use memry_core::domain::home_page::{self, HomePagePatch};
use memry_core::domain::sticky_draft::{self, StickyKind};
use memry_core::domain::vault_locks::{self, TargetKind};
use memry_core::domain::{agent_message, canvas_folder};
use memry_test_kit::proptest_config;
use proptest::prelude::*;
use serde_json::Value as Json;

/// One page of one record per type, with no at-rest key installed: none
/// corrupt, six `sync_items` rows holding the received bytes, six projection
/// rows. With no key, an agent record is stored plain and pending
/// (`agent_records_sync.rs` covers the seal once the key arrives).
#[tokio::test]
async fn a_page_of_each_desktop_only_type_lands_whole() {
    let device = Device::bare("pull-each");
    let relay = Relay::default();
    let sent: Vec<(&str, String, String)> = TYPES
        .iter()
        .map(|item_type| (*item_type, id_of(item_type), wire(item_type).to_string()))
        .collect();
    for (item_type, id, payload) in &sent {
        relay.put(item_type, id, payload);
    }

    let report = relay.pull(&device).await;
    assert_eq!((report.applied, report.corrupt, report.skipped), (6, 0, 0));
    assert_eq!(device.count("SELECT COUNT(*) FROM sync_items"), 6);
    for (item_type, id, payload) in &sent {
        assert_eq!(
            &device.stored(item_type, id),
            payload,
            "§13.2 rule 1: {item_type} is stored as received"
        );
    }
    for table in [
        "SELECT COUNT(*) FROM agent_conversations",
        "SELECT COUNT(*) FROM agent_messages",
        "SELECT COUNT(*) FROM canvas_folders",
        "SELECT COUNT(*) FROM home_pages",
        "SELECT COUNT(*) FROM vault_locks",
        "SELECT COUNT(*) FROM sticky_drafts",
    ] {
        assert_eq!(device.count(table), 1, "{table}");
    }
}

/// A local edit of `item_type`'s record, through the type's own write. An
/// agent message is immutable, so its one local write is the delete.
fn edit(device: &Device, item_type: &'static str) {
    let key = device.vault.at_rest_key();
    let id = id_of(item_type);
    let at = NOW + 20;
    let who = device.id;
    device
        .db()
        .call_blocking(move |conn| {
            match item_type {
                "agent_conversation" => {
                    let patch = ConversationPatch {
                        pinned: Some(true),
                        ..ConversationPatch::default()
                    };
                    agent_conversation::update_fields(conn, &key, &id, &patch, who, at)
                        .map(drop)
                        .map_err(failed)?;
                }
                "agent_message" => {
                    assert!(agent_message::delete(conn, &id, who, at)?);
                }
                "canvas_folder" => {
                    canvas_folder::upsert(conn, "vault-1", "Work", Some(Some("moon")), who, at)?;
                }
                "home_page" => {
                    let patch = HomePagePatch {
                        name: Some("Edited"),
                        ..HomePagePatch::default()
                    };
                    home_page::update(conn, &id, &patch, who, at)?;
                }
                "vault_lock" => {
                    vault_locks::set(conn, TargetKind::Folder, "Projects", false, who, at)?;
                }
                _ => {
                    sticky_draft::upsert(conn, Some(&id), "edited", StickyKind::Note, who, at)?;
                }
            }
            Ok(())
        })
        .expect("a local edit");
}

fn unknown_value() -> impl Strategy<Value = Json> {
    let leaf = prop_oneof![
        Just(Json::Null),
        any::<bool>().prop_map(Json::from),
        any::<i32>().prop_map(Json::from),
        "[a-z ]{0,8}".prop_map(Json::from),
    ];
    leaf.prop_recursive(3, 12, 3, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..3).prop_map(Json::from),
            prop::collection::btree_map("[a-z]{1,3}", inner, 0..3)
                .prop_map(|map| Json::Object(map.into_iter().collect())),
        ]
    })
}

proptest! {
    // Each case opens a vault and runs a pull and a push wave.
    #![proptest_config(proptest_config(48))]

    /// §13.2 for each of the six: pull a payload carrying a key this build
    /// does not model, edit the record here, and the pushed payload still
    /// carries the key with its value. For the agent records the stored
    /// payload is sealed and the push opens it, so this also covers the
    /// open.
    #[test]
    fn a_key_this_build_does_not_model_reaches_the_push_after_a_local_edit(
        item_type in prop::sample::select(TYPES.to_vec()),
        key in "x[A-Za-z]{1,8}",
        value in unknown_value(),
    ) {
        let device = Device::keyed("preserve");
        let relay = Relay::default();
        let mut payload = wire(item_type);
        payload.as_object_mut().expect("object").insert(key.clone(), value.clone());
        relay.put(item_type, &id_of(item_type), &payload.to_string());

        let sent = runtime::block_on(async {
            let report = relay.pull(&device).await;
            assert_eq!((report.applied, report.corrupt), (1, 0));
            edit(&device, item_type);
            relay.push(&device).await
        });
        prop_assert_eq!(sent.len(), 1);
        let pushed: Json = serde_json::from_str(&sent[0].2).expect("json");
        prop_assert_eq!(pushed.get(&key), Some(&value), "{} lost {}", item_type, key);
    }
}
