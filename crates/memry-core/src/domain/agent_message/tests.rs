//! `agent_message` on a real `data.db` (Step 16, #3533): the sealed append and
//! reads, and Electron's apply rules (`agent-message-handler.ts`) through the
//! real pull apply step.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::{ITEM_TYPE, NewMessage, append, delete, get_by_conversation};
use crate::api::errors::StorageError;
use crate::crypto::agent_envelope::{AtRestKey, Purpose};
use crate::domain::agent_records::AgentError;
use crate::domain::desktop_records::testing::{
    DEVICE, NOW, open, payload, queued, remote, remote_delete,
};
use crate::sync::apply::{ApplyTotals, Pending, apply_page};
use crate::sync::clock::clock_of;

fn key() -> AtRestKey {
    let key = AtRestKey::default();
    key.set(Some(Zeroizing::new([9; 32])));
    key
}

/// Whether a stored value is an envelope that opens under [`key`].
fn sealed(purpose: Purpose, value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|column| key().open(purpose, column).is_ok())
}

fn pull(
    conn: &Connection,
    key: &AtRestKey,
    items: Vec<Pending>,
) -> Result<ApplyTotals, StorageError> {
    apply_page(conn, items, vec![], NOW + 10, Some(DEVICE), key)
}

fn text(content: &str) -> Value {
    json!({"role": "user", "data": {"text": content}})
}

fn new<'a>(
    id: &'a str,
    content: &'a Value,
    attachments: &'a Value,
    status: &'a str,
) -> NewMessage<'a> {
    NewMessage {
        id: Some(id),
        conversation_id: "conv-1",
        role: "user",
        content,
        attachments,
        tool_call_id: None,
        status,
    }
}

fn body(content: &str, status: Value) -> Value {
    json!({
        "conversationId": "conv-1", "role": "user", "content": text(content),
        "attachments": [], "toolCallId": null, "status": status,
        "clock": {"peer": 1}, "createdAt": NOW, "updatedAt": NOW,
    })
}

fn peer(id: &str, content: &str, status: Value) -> Pending {
    remote(ITEM_TYPE, id, &body(content, status))
}

/// The stored payload, `None` when there is no row or no payload.
fn stored_payload_or_none(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT payload FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
        params![ITEM_TYPE, id],
        |row| row.get(0),
    )
    .optional()
    .expect("query")
    .flatten()
}

fn stored_payload(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT payload FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
        params![ITEM_TYPE, id],
        |row| row.get(0),
    )
    .expect("row")
}

#[test]
fn a_terminal_message_is_stored_sealed_and_reads_back_in_order() {
    let (db, _dir) = open("agent-message-write");
    db.call_blocking(|conn| {
        let key = key();
        let attachments = json!([{"kind": "note", "refId": "n1", "label": "Plan"}]);
        let second = append(
            conn,
            &key,
            &new("m2", &text("second"), &json!([]), "completed"),
            DEVICE,
            NOW + 1,
        )
        .map_err(storage)?;
        let first = append(
            conn,
            &key,
            &new("m1", &text("first"), &attachments, "error"),
            DEVICE,
            NOW,
        )
        .map_err(storage)?;
        let stored = payload(conn, ITEM_TYPE, "m1");
        assert!(
            sealed(Purpose::MessageContent, &stored["content"])
                && sealed(Purpose::Attachments, &stored["attachments"])
        );
        assert_eq!(stored["clock"], json!({DEVICE: 1}));
        let column: String = conn
            .query_row(
                "SELECT content FROM agent_messages WHERE id = 'm1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let opened: Value =
            serde_json::from_str(&key.open(Purpose::MessageContent, &column).unwrap()).unwrap();
        assert_eq!(opened, text("first"));
        assert_eq!(queued(conn, ITEM_TYPE, "m1"), 1);
        assert_eq!(
            get_by_conversation(conn, &key, "conv-1").map_err(storage)?,
            vec![first, second.clone()]
        );

        assert!(delete(conn, "m1", DEVICE, NOW + 2)?);
        assert!(!delete(conn, "m1", DEVICE, NOW + 3)?);
        assert_eq!(
            get_by_conversation(conn, &key, "conv-1").map_err(storage)?,
            vec![second]
        );
        Ok(())
    })
    .expect("message writes");
}

#[test]
fn a_streaming_message_or_a_missing_key_is_refused() {
    let (db, _dir) = open("agent-message-refused");
    db.call_blocking(|conn| {
        let content = text("half");
        let streaming = append(
            conn,
            &key(),
            &new("m1", &content, &json!([]), "streaming"),
            DEVICE,
            NOW,
        );
        assert!(matches!(
            streaming,
            Err(AgentError::Storage(StorageError::Invalid { .. }))
        ));
        let no_key = append(
            conn,
            &AtRestKey::default(),
            &new("m1", &content, &json!([]), "completed"),
            DEVICE,
            NOW,
        );
        assert!(matches!(no_key, Err(AgentError::SealerUnavailable)));
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
        Ok(())
    })
    .expect("refused");
}

#[test]
fn a_message_is_written_once_and_lands_before_its_conversation() {
    let (db, _dir) = open("agent-message-immutable");
    db.call_blocking(|conn| {
        let key = key();
        assert_eq!(
            pull(conn, &key, vec![peer("m1", "original", json!("completed"))])?.applied,
            1
        );
        let before = stored_payload(conn, "m1");
        assert!(sealed(
            Purpose::MessageContent,
            &serde_json::from_str::<Value>(before.as_deref().unwrap()).unwrap()["content"]
        ));

        let changed = pull(
            conn,
            &key,
            vec![peer("m1", "rewritten", json!("completed"))],
        )?;
        assert_eq!((changed.applied, changed.skipped), (0, 1));
        assert_eq!(
            stored_payload(conn, "m1"),
            before,
            "the local message is untouched"
        );
        let same = pull(conn, &key, vec![peer("m1", "original", json!("completed"))])?;
        assert_eq!(same.skipped, 1);
        let messages = get_by_conversation(conn, &key, "conv-1").map_err(storage)?;
        assert_eq!(
            messages.len(),
            1,
            "no conversation conv-1 exists, the message reads"
        );
        assert_eq!(messages[0].content, text("original"));
        Ok(())
    })
    .expect("immutable");
}

#[test]
fn a_message_that_is_not_terminal_is_recorded_corrupt_with_no_payload() {
    let (db, _dir) = open("agent-message-corrupt");
    db.call_blocking(|conn| {
        let mut absent = body("secret draft", json!("completed"));
        absent.as_object_mut().unwrap().remove("status");
        let items = [
            ("m1", body("secret draft", json!("streaming"))),
            ("m2", absent),
        ];
        for (id, body) in items {
            let totals = pull(conn, &key(), vec![remote(ITEM_TYPE, id, &body)])?;
            assert_eq!(totals.corrupt, 1, "{id}");
            assert_eq!(stored_payload(conn, id), None, "{id}");
        }
        Ok(())
    })
    .expect("corrupt");
}

#[test]
fn a_message_this_device_holds_skips_a_remote_that_is_not_terminal() {
    let (db, _dir) = open("agent-message-held-streaming");
    db.call_blocking(|conn| {
        let key = key();
        pull(conn, &key, vec![peer("m1", "original", json!("completed"))])?;
        let before = stored_payload(conn, "m1");
        let totals = pull(conn, &key, vec![peer("m1", "draft", json!("streaming"))])?;
        assert_eq!((totals.skipped, totals.corrupt), (1, 0));
        assert_eq!(stored_payload(conn, "m1"), before);
        let corrupt: Option<String> = conn
            .query_row(
                "SELECT corrupt_reason FROM sync_items WHERE item_type = ?1 AND item_id = 'm1'",
                params![ITEM_TYPE],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(corrupt, None, "the held message stays editable");
        Ok(())
    })
    .expect("held");
}

#[test]
fn a_remote_the_schema_refuses_is_skipped_and_writes_nothing() {
    let (db, _dir) = open("agent-message-refused");
    db.call_blocking(|conn| {
        let cases = [
            ("conversationId", json!(5)),
            ("role", json!(["user"])),
            ("toolCallId", json!(5)),
            ("createdAt", json!("x")),
            ("status", Value::Null),
            ("content", Value::Null),
            ("attachments", Value::Null),
            ("clock", Value::Null),
        ];
        for (index, (name, value)) in cases.into_iter().enumerate() {
            let id = format!("m{index}");
            let mut bad = body("SECRET-REFUSED words", json!("completed"));
            bad[name] = value;
            for key in [AtRestKey::default(), key()] {
                let totals = pull(conn, &key, vec![remote(ITEM_TYPE, &id, &bad)])?;
                assert_eq!((totals.skipped, totals.corrupt), (1, 0), "{name}");
                assert_eq!(stored_payload_or_none(conn, &id), None, "{name}");
            }
        }
        Ok(())
    })
    .expect("refused");
}

#[test]
fn a_concurrent_remote_delete_applies() {
    let (db, _dir) = open("agent-message-delete");
    db.call_blocking(|conn| {
        let key = key();
        let content = text("keep");
        append(
            conn,
            &key,
            &new("m1", &content, &json!([]), "completed"),
            DEVICE,
            NOW,
        )
        .map_err(storage)?;
        let concurrent = pull(
            conn,
            &key,
            vec![remote_delete(ITEM_TYPE, "m1", clock_of([("peer", 1)]))],
        )?;
        assert_eq!(concurrent.deleted, 1);
        assert!(
            get_by_conversation(conn, &key, "conv-1")
                .map_err(storage)?
                .is_empty()
        );
        Ok(())
    })
    .expect("delete");
}

fn storage(error: AgentError) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
