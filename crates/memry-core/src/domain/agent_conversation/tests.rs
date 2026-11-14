//! `agent_conversation` on a real `data.db` (Step 16, #3533): the sealed
//! writes and reads, and Electron's apply rules
//! (`agent-conversation-handler.ts`) through the real pull apply step.

use rusqlite::{Connection, params};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::{
    ConversationPatch, ITEM_TYPE, NewConversation, create, get, list, soft_delete, update_fields,
};
use crate::api::errors::StorageError;
use crate::crypto::agent_envelope::{AtRestKey, Purpose};
use crate::crypto::agent_payload::open_payload;
use crate::domain::agent_records::{AgentError, seal_pending};
use crate::domain::desktop_records::testing::{
    DEVICE, NOW, open, payload, queued, remote, remote_delete,
};
use crate::sync::apply::{ApplyTotals, Pending, apply_page};
use crate::sync::clock::clock_of;

const NEW: NewConversation<'static> = NewConversation {
    vault_id: "vault-1",
    title: "Plan the week",
    backend: "local",
    backend_model: Some("llama3"),
};

/// Whether a stored title is an envelope that opens under [`key`].
fn sealed(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|column| key().open(Purpose::ConversationTitle, column).is_ok())
}

fn key() -> AtRestKey {
    let key = AtRestKey::default();
    key.set(Some(Zeroizing::new([7; 32])));
    key
}

fn pull(
    conn: &Connection,
    key: &AtRestKey,
    items: Vec<Pending>,
) -> Result<ApplyTotals, StorageError> {
    apply_page(conn, items, vec![], NOW + 10, Some(DEVICE), key)
}

/// The projection's title column and whether the record is sealed-pending.
fn title_column(conn: &Connection, id: &str) -> (String, i64) {
    conn.query_row(
        "SELECT title, EXISTS(SELECT 1 FROM agent_sealed_pending
                              WHERE item_type = 'agent_conversation' AND item_id = ?1)
         FROM agent_conversations WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .expect("row")
}

/// A peer's version of `id`: `fields` over the created payload, under `clock`
/// and `field_clocks`.
fn peer(id: &str, fields: Value, clock: Value, field_clocks: Value) -> Pending {
    let mut body = json!({
        "vaultId": "vault-1", "title": "Plan the week", "backend": "local",
        "backendModel": "llama3", "trustList": [], "pinned": false,
        "createdAt": NOW, "updatedAt": NOW + 3, "deletedAt": null,
    });
    for (name, value) in fields.as_object().expect("fields") {
        body[name] = value.clone();
    }
    body["clock"] = clock;
    body["fieldClocks"] = field_clocks;
    remote(ITEM_TYPE, id, &body)
}

#[test]
fn a_conversation_is_stored_sealed_and_reads_back_opened() {
    let (db, _dir) = open("agent-conversation-write");
    db.call_blocking(|conn| {
        let key = key();
        let created = create(conn, &key, &NEW, DEVICE, NOW).map_err(storage)?;
        assert_eq!(created.title, "Plan the week");
        let stored = payload(conn, ITEM_TYPE, &created.id);
        assert!(sealed(&stored["title"]), "the payload holds the envelope");
        assert_eq!(stored["clock"], json!({DEVICE: 1}));
        assert_eq!(stored["fieldClocks"]["pinned"], json!({DEVICE: 1}));
        let (column, pending) = title_column(conn, &created.id);
        assert_eq!(
            key.open(Purpose::ConversationTitle, &column).unwrap(),
            "Plan the week"
        );
        assert_eq!(pending, 0);
        assert_eq!(queued(conn, ITEM_TYPE, &created.id), 1);

        let patch = ConversationPatch {
            title: Some("Plan the month"),
            pinned: Some(true),
            ..ConversationPatch::default()
        };
        let updated =
            update_fields(conn, &key, &created.id, &patch, DEVICE, NOW + 1).map_err(storage)?;
        assert_eq!(
            (updated.title.as_str(), updated.pinned),
            ("Plan the month", true)
        );
        let stored = payload(conn, ITEM_TYPE, &created.id);
        assert_eq!(stored["fieldClocks"]["title"], json!({DEVICE: 2}));
        assert_eq!(stored["fieldClocks"]["backend"], json!({DEVICE: 1}));
        assert_eq!(list(conn, &key, "vault-1").map_err(storage)?, vec![updated]);

        assert!(soft_delete(conn, &created.id, DEVICE, NOW + 2)?);
        assert_eq!(get(conn, &key, &created.id).map_err(storage)?, None);
        assert_eq!(
            payload(conn, ITEM_TYPE, &created.id)["deletedAt"],
            json!(NOW + 2)
        );
        Ok(())
    })
    .expect("conversation writes");
}

#[test]
fn without_a_key_a_conversation_write_is_refused_and_writes_nothing() {
    let (db, _dir) = open("agent-conversation-no-key");
    db.call_blocking(|conn| {
        let refused = create(conn, &AtRestKey::default(), &NEW, DEVICE, NOW);
        assert!(matches!(refused, Err(AgentError::SealerUnavailable)));
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
        Ok(())
    })
    .expect("no key");
}

#[test]
fn concurrent_edits_merge_field_by_field_and_the_title_stays_sealed() {
    let (db, _dir) = open("agent-conversation-merge");
    db.call_blocking(|conn| {
        let key = key();
        let id = create(conn, &key, &NEW, DEVICE, NOW).map_err(storage)?.id;
        let local = ConversationPatch {
            title: Some("Local title"),
            ..ConversationPatch::default()
        };
        update_fields(conn, &key, &id, &local, DEVICE, NOW + 1).map_err(storage)?;
        let queued_before = queued(conn, ITEM_TYPE, &id);

        // The peer saw the create, then pinned it and renamed the backend.
        let base = json!({DEVICE: 1});
        let mut field_clocks = json!({
            "title": base, "backend": {DEVICE: 1, "peer": 1}, "backendModel": base,
            "trustList": base, "pinned": {DEVICE: 1, "peer": 1},
        });
        let totals = pull(
            conn,
            &key,
            vec![peer(
                &id,
                json!({"pinned": true, "backend": "cloud", "updatedAt": NOW + 9}),
                json!({DEVICE: 1, "peer": 1}),
                field_clocks.clone(),
            )],
        )?;
        assert_eq!(totals.applied, 1);
        let merged = get(conn, &key, &id).map_err(storage)?.expect("live");
        assert_eq!(
            merged.title, "Local title",
            "the local rename wins its field"
        );
        assert_eq!((merged.backend.as_str(), merged.pinned), ("cloud", true));
        assert_eq!(merged.updated_at, NOW + 9);
        let stored = payload(conn, ITEM_TYPE, &id);
        assert!(sealed(&stored["title"]));
        assert_eq!(stored["clock"], json!({DEVICE: 2, "peer": 1}));
        assert_eq!(title_column(conn, &id).1, 0);
        assert_eq!(
            queued(conn, ITEM_TYPE, &id),
            queued_before,
            "the merge's requeue collapses into the queued row (§6.5.2 P3)"
        );

        // A concurrent title on both sides: the larger clock total wins.
        field_clocks["title"] = json!({DEVICE: 1, "peer": 3});
        pull(
            conn,
            &key,
            vec![peer(
                &id,
                json!({"title": "Peer title", "pinned": true, "backend": "cloud"}),
                json!({DEVICE: 1, "peer": 3}),
                field_clocks,
            )],
        )?;
        assert_eq!(
            get(conn, &key, &id).map_err(storage)?.expect("live").title,
            "Peer title"
        );
        assert!(sealed(&payload(conn, ITEM_TYPE, &id)["title"]));
        Ok(())
    })
    .expect("merge");
}

#[test]
fn a_dominated_remote_skips_and_a_dominating_one_applies_sealed() {
    let (db, _dir) = open("agent-conversation-gate");
    db.call_blocking(|conn| {
        let key = key();
        let id = create(conn, &key, &NEW, DEVICE, NOW).map_err(storage)?.id;
        let patch = ConversationPatch {
            title: Some("Newer here"),
            ..ConversationPatch::default()
        };
        update_fields(conn, &key, &id, &patch, DEVICE, NOW + 1).map_err(storage)?;

        let stale = peer(
            &id,
            json!({"title": "Stale"}),
            json!({DEVICE: 1}),
            json!({}),
        );
        assert_eq!(pull(conn, &key, vec![stale])?.skipped, 1);
        assert_eq!(
            get(conn, &key, &id).map_err(storage)?.expect("live").title,
            "Newer here"
        );

        let newer = peer(
            &id,
            json!({"title": "Newest"}),
            json!({DEVICE: 3}),
            json!({}),
        );
        assert_eq!(pull(conn, &key, vec![newer])?.applied, 1);
        assert_eq!(
            get(conn, &key, &id).map_err(storage)?.expect("live").title,
            "Newest"
        );
        assert!(sealed(&payload(conn, ITEM_TYPE, &id)["title"]));
        Ok(())
    })
    .expect("gate");
}

#[test]
fn a_delete_older_than_the_local_record_is_skipped() {
    let (db, _dir) = open("agent-conversation-delete");
    db.call_blocking(|conn| {
        let key = key();
        let id = create(conn, &key, &NEW, DEVICE, NOW).map_err(storage)?.id;
        let patch = ConversationPatch {
            pinned: Some(true),
            ..ConversationPatch::default()
        };
        update_fields(conn, &key, &id, &patch, DEVICE, NOW + 1).map_err(storage)?;
        let late = pull(
            conn,
            &key,
            vec![remote_delete(ITEM_TYPE, &id, clock_of([(DEVICE, 1)]))],
        )?;
        assert_eq!((late.deleted, late.skipped), (0, 1));
        assert!(get(conn, &key, &id).map_err(storage)?.is_some());

        let after = pull(
            conn,
            &key,
            vec![remote_delete(ITEM_TYPE, &id, clock_of([(DEVICE, 2)]))],
        )?;
        assert_eq!(after.deleted, 1);
        assert!(get(conn, &key, &id).map_err(storage)?.is_none());
        Ok(())
    })
    .expect("delete");
}

#[test]
fn a_payload_that_is_not_an_object_is_recorded_corrupt_with_no_payload() {
    let (db, _dir) = open("agent-conversation-corrupt");
    db.call_blocking(|conn| {
        let totals = pull(
            conn,
            &key(),
            vec![remote(ITEM_TYPE, "c1", &json!(["secret title"]))],
        )?;
        assert_eq!(totals.corrupt, 1);
        let stored: Option<String> = conn
            .query_row(
                "SELECT payload FROM sync_items WHERE item_type = ?1 AND item_id = 'c1'",
                params![ITEM_TYPE],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, None);
        Ok(())
    })
    .expect("corrupt");
}

const SHAPED: &str = r#"{"version":1,"nonce":"AAAA","ciphertext":"AAAA"}"#;

fn corrupt_reason(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT corrupt_reason FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
        params![ITEM_TYPE, id],
        |row| row.get(0),
    )
    .expect("row")
}

fn stored_text(conn: &Connection, id: &str) -> String {
    conn.query_row(
        "SELECT payload FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
        params![ITEM_TYPE, id],
        |row| row.get(0),
    )
    .expect("row")
}

#[test]
fn a_plain_title_shaped_like_an_envelope_is_sealed_read_and_pushed_as_itself() {
    let (db, _dir) = open("agent-conversation-shaped");
    db.call_blocking(|conn| {
        let key = key();
        let new = NewConversation {
            title: SHAPED,
            ..NEW
        };
        let id = create(conn, &key, &new, DEVICE, NOW).map_err(storage)?.id;
        assert_ne!(payload(conn, ITEM_TYPE, &id)["title"], json!(SHAPED));
        assert_eq!(
            get(conn, &key, &id).map_err(storage)?.expect("live").title,
            SHAPED
        );
        let patch = ConversationPatch {
            pinned: Some(true),
            ..ConversationPatch::default()
        };
        update_fields(conn, &key, &id, &patch, DEVICE, NOW + 1).map_err(storage)?;
        assert_eq!(
            list(conn, &key, "vault-1").map_err(storage)?[0].title,
            SHAPED
        );
        let wire = open_payload(ITEM_TYPE, &stored_text(conn, &id), false, &key)
            .unwrap()
            .expect("opened");
        assert_eq!(
            serde_json::from_str::<Value>(&wire).unwrap()["title"],
            SHAPED
        );

        // Pulled with no key it is stored plain; the key's arrival seals it.
        let pulled = peer(
            "c2",
            json!({"title": SHAPED}),
            json!({"peer": 1}),
            json!({}),
        );
        pull(conn, &AtRestKey::default(), vec![pulled])?;
        assert_eq!(
            seal_pending(conn, &key, NOW + 20).map_err(storage)?.records,
            1
        );
        assert_ne!(payload(conn, ITEM_TYPE, "c2")["title"], json!(SHAPED));
        assert_eq!(
            key.open(Purpose::ConversationTitle, &title_column(conn, "c2").0)
                .unwrap(),
            SHAPED
        );
        assert_eq!(
            get(conn, &key, "c2").map_err(storage)?.expect("live").title,
            SHAPED
        );
        Ok(())
    })
    .expect("shaped title");
}

#[test]
fn a_remote_the_schema_refuses_is_skipped_and_writes_nothing() {
    let (db, _dir) = open("agent-conversation-refused");
    db.call_blocking(|conn| {
        let key = key();
        let id = create(conn, &key, &NEW, DEVICE, NOW).map_err(storage)?.id;
        let before = stored_text(conn, &id);
        let cases = [
            json!({"title": 5}),
            json!({"pinned": "yes"}),
            json!({"trustList": "all"}),
            json!({"createdAt": "x"}),
            json!({"title": null}),
            json!({"vaultId": null}),
            json!({"updatedAt": null, "deletedAt": NOW + 5}),
        ];
        let cases = cases
            .into_iter()
            .map(|fields| (fields, json!({})))
            .chain([(json!({"fieldClocks": null}), Value::Null)]);
        for (fields, field_clocks) in cases {
            let dominating = peer(&id, fields.clone(), json!({DEVICE: 9}), field_clocks);
            let totals = pull(conn, &key, vec![dominating])?;
            assert_eq!((totals.skipped, totals.corrupt), (1, 0), "{fields}");
            assert_eq!(stored_text(conn, &id), before, "{fields}");
            assert_eq!(corrupt_reason(conn, &id), None, "{fields}");
        }

        // No key and a new id: nothing of the refused payload is stored.
        let fresh = peer(
            "c-new",
            json!({"title": "SECRET-REFUSED", "pinned": "yes"}),
            json!({"peer": 1}),
            json!({}),
        );
        assert_eq!(pull(conn, &AtRestKey::default(), vec![fresh])?.skipped, 1);
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_items WHERE payload LIKE '%SECRET-REFUSED%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0);
        Ok(())
    })
    .expect("refused");
}

#[test]
fn an_equal_clock_over_the_same_payload_skips_though_the_local_title_is_sealed() {
    let (db, _dir) = open("agent-conversation-equal");
    db.call_blocking(|conn| {
        let key = key();
        let id = create(conn, &key, &NEW, DEVICE, NOW).map_err(storage)?.id;
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
        let id = create(conn, &key, &NEW, DEVICE, NOW).map_err(storage)?.id;
        let patch = ConversationPatch {
            pinned: Some(true),
            ..ConversationPatch::default()
        };
        let local = update_fields(conn, &key, &id, &patch, DEVICE, NOW + 1).map_err(storage)?;
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
        let id = create(conn, &key, &NEW, DEVICE, NOW).map_err(storage)?.id;
        let patch = ConversationPatch {
            title: Some("Local title"),
            ..ConversationPatch::default()
        };
        update_fields(conn, &key, &id, &patch, DEVICE, NOW + 1).map_err(storage)?;
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

fn storage(error: AgentError) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
