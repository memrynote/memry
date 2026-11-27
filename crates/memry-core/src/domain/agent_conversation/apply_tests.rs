//! `agent_conversation` merges through the real pull apply step (Step 16,
//! #3533): an equal clock, a merge that changes no field, and a merge or
//! seal without a key. Split from `tests.rs` at the 600-line ceiling.

use serde_json::json;

use super::tests::{
    NEW, corrupt_reason, key, peer, pull, sealed, storage, stored_text, title_column,
};
use super::{ConversationPatch, ITEM_TYPE, create, get, update_fields};
use crate::crypto::agent_envelope::AtRestKey;
use crate::crypto::agent_payload::open_payload;
use crate::domain::agent_queue::Queue;
use crate::domain::agent_records::seal_pending;
use crate::domain::desktop_records::testing::{DEVICE, NOW, open, payload, queued, remote};
#[test]
fn an_equal_clock_over_the_same_payload_skips_though_the_local_title_is_sealed() {
    let (db, _dir) = open("agent-conversation-equal");
    db.call_blocking(|conn| {
        let key = key();
        let id = create(conn, &key, &NEW, Queue::Outbox, DEVICE, NOW)
            .map_err(storage)?
            .id;
        let before = stored_text(conn, &id);
        let wire = open_payload(ITEM_TYPE, &before, false, &key)
            .unwrap()
            .expect("opened");
        let same = remote(ITEM_TYPE, &id, &serde_json::from_str(&wire).unwrap());
        assert_eq!(pull(conn, &key, vec![same])?.skipped, 1);
        assert_eq!(stored_text(conn, &id), before, "nothing is rewritten");
        Ok(())
    })
    .expect("equal clock");
}

#[test]
fn a_concurrent_merge_that_changes_no_field_stores_the_combined_clock_and_queues_nothing() {
    let (db, _dir) = open("agent-conversation-noop-merge");
    db.call_blocking(|conn| {
        let key = key();
        let id = create(conn, &key, &NEW, Queue::Outbox, DEVICE, NOW)
            .map_err(storage)?
            .id;
        let patch = ConversationPatch {
            pinned: Some(true),
            ..ConversationPatch::default()
        };
        let local = update_fields(conn, &key, &id, &patch, Queue::Outbox, DEVICE, NOW + 1)
            .map_err(storage)?;
        let queued_before = queued(conn, ITEM_TYPE, &id);
        let base = json!({DEVICE: 1});
        let field_clocks = json!({
            "title": base, "backend": base, "backendModel": base,
            "trustList": base, "pinned": {DEVICE: 2},
        });
        let same_values = peer(
            &id,
            json!({"pinned": true, "updatedAt": NOW + 1}),
            json!({DEVICE: 1, "peer": 1}),
            field_clocks,
        );
        assert_eq!(pull(conn, &key, vec![same_values])?.applied, 1);
        assert_eq!(
            payload(conn, ITEM_TYPE, &id)["clock"],
            json!({DEVICE: 2, "peer": 1})
        );
        assert_eq!(get(conn, &key, &id).map_err(storage)?, Some(local));
        assert_eq!(queued(conn, ITEM_TYPE, &id), queued_before);
        Ok(())
    })
    .expect("no-op merge");
}

#[test]
fn a_concurrent_merge_with_no_key_keeps_a_sealed_title_or_stores_the_remote_one_pending() {
    let (db, _dir) = open("agent-conversation-merge-no-key");
    db.call_blocking(|conn| {
        let key = key();
        let id = create(conn, &key, &NEW, Queue::Outbox, DEVICE, NOW)
            .map_err(storage)?
            .id;
        let patch = ConversationPatch {
            title: Some("Local title"),
            ..ConversationPatch::default()
        };
        update_fields(conn, &key, &id, &patch, Queue::Outbox, DEVICE, NOW + 1).map_err(storage)?;
        let no_key = AtRestKey::default();
        let base = json!({DEVICE: 1});
        let mut field_clocks = json!({
            "title": base, "backend": base, "backendModel": base,
            "trustList": base, "pinned": {DEVICE: 1, "peer": 1},
        });
        let pinned = peer(
            &id,
            json!({"pinned": true}),
            json!({DEVICE: 1, "peer": 1}),
            field_clocks.clone(),
        );
        assert_eq!(pull(conn, &no_key, vec![pinned])?.applied, 1);
        assert!(sealed(&payload(conn, ITEM_TYPE, &id)["title"]));
        assert_eq!(title_column(conn, &id).1, 0, "the local title stays sealed");

        field_clocks["title"] = json!({DEVICE: 2, "peer": 5});
        let titled = peer(
            &id,
            json!({"title": "Peer title", "pinned": true}),
            json!({DEVICE: 1, "peer": 5}),
            field_clocks,
        );
        assert_eq!(pull(conn, &no_key, vec![titled])?.applied, 1);
        assert_eq!(
            title_column(conn, &id),
            (String::new(), 1),
            "stored pending"
        );
        assert_eq!(
            seal_pending(conn, &key, NOW + 20).map_err(storage)?.records,
            1
        );
        let sealed = get(conn, &key, &id).map_err(storage)?.expect("live");
        assert_eq!((sealed.title.as_str(), sealed.pinned), ("Peer title", true));
        Ok(())
    })
    .expect("merge without a key");
}

#[test]
fn sealing_pending_records_flags_a_row_that_will_not_seal_and_seals_the_rest() {
    let (db, _dir) = open("agent-conversation-seal-pending-flag");
    db.call_blocking(|conn| {
        let no_key = AtRestKey::default();
        for id in ["c-bad", "c-good"] {
            let pulled = peer(id, json!({}), json!({"peer": 1}), json!({}));
            pull(conn, &no_key, vec![pulled])?;
        }
        conn.execute(
            "UPDATE sync_items SET payload = '[1]' WHERE item_id = 'c-bad'",
            [],
        )
        .unwrap();
        let key = key();
        assert_eq!(
            seal_pending(conn, &key, NOW + 20).map_err(storage)?.records,
            1
        );
        assert!(corrupt_reason(conn, "c-bad").is_some());
        assert_eq!(title_column(conn, "c-good").1, 0);
        assert_eq!(
            get(conn, &key, "c-good")
                .map_err(storage)?
                .expect("live")
                .title,
            "Plan the week"
        );
        Ok(())
    })
    .expect("seal pending");
}
