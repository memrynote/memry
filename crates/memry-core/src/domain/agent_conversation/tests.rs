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
use crate::crypto::agent_payload::is_envelope;
use crate::domain::agent_records::AgentError;
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

fn title_column(conn: &Connection, id: &str) -> (String, i64) {
    conn.query_row(
        "SELECT title, sealed_pending FROM agent_conversations WHERE id = ?1",
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
        assert!(
            is_envelope(&stored["title"]),
            "the payload holds the envelope"
        );
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
        assert!(is_envelope(&stored["title"]));
        assert_eq!(stored["clock"], json!({DEVICE: 2, "peer": 1}));
        assert_eq!(title_column(conn, &id).1, 0);
        assert_eq!(
            queued(conn, ITEM_TYPE, &id),
            queued_before,
            "the merge queues nothing (§6.5.2 P3)"
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
        assert!(is_envelope(&payload(conn, ITEM_TYPE, &id)["title"]));
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
        assert!(is_envelope(&payload(conn, ITEM_TYPE, &id)["title"]));
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

fn storage(error: AgentError) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
