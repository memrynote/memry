//! [`Queue`], streaming messages and [`backfill`] on a real `data.db` (Step 28,
//! #3545): what reaches the outbox, and when.

use rusqlite::{Connection, params};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::*;
use crate::crypto::agent_envelope::AtRestKey;
use crate::domain::agent_conversation::{ConversationPatch, NewConversation};
use crate::domain::agent_message::{MessageEdit, NewMessage};
use crate::domain::agent_records::AgentError;
use crate::domain::desktop_records::testing::{DEVICE, NOW, open, queued};

fn key() -> AtRestKey {
    let key = AtRestKey::default();
    key.set(Some(Zeroizing::new([7; 32])));
    key
}

fn storage(error: AgentError) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn conversation(conn: &Connection, vault: &str, queue: Queue) -> Result<String, StorageError> {
    let new = NewConversation {
        vault_id: vault,
        title: "Plan the launch",
        backend: "claude_cli",
        backend_model: None,
    };
    agent_conversation::create(conn, &key(), &new, queue, DEVICE, NOW)
        .map(|conversation| conversation.id)
        .map_err(storage)
}

fn message<'a>(id: &'a str, content: &'a Value, status: &'a str) -> NewMessage<'a> {
    NewMessage {
        id: Some(id),
        conversation_id: "c",
        role: "assistant",
        content,
        attachments: &EMPTY,
        tool_call_id: None,
        status,
    }
}

static EMPTY: Value = Value::Array(Vec::new());

fn reply(text: &str) -> Value {
    json!({"role": "assistant", "data": {"text": text}})
}

fn outbox_ops(conn: &Connection) -> Vec<(String, String, String)> {
    let mut statement = conn
        .prepare("SELECT item_type, item_id, op FROM outbox ORDER BY id")
        .expect("prepare");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

#[test]
fn local_only_writes_store_the_record_and_queue_nothing() {
    let (db, _dir) = open("agent-queue-local");
    db.call_blocking(|conn| {
        let id = conversation(conn, "v1", Queue::LocalOnly)?;
        let patch = ConversationPatch {
            pinned: Some(true),
            ..ConversationPatch::default()
        };
        agent_conversation::update_fields(conn, &key(), &id, &patch, Queue::LocalOnly, DEVICE, NOW)
            .map_err(storage)?;
        let content = reply("done");
        agent_message::append(
            conn,
            &key(),
            &message("m1", &content, "completed"),
            Queue::LocalOnly,
            DEVICE,
            NOW,
        )
        .map_err(storage)?;
        assert!(agent_conversation::soft_delete(
            conn,
            &id,
            Queue::LocalOnly,
            DEVICE,
            NOW + 1
        )?);
        assert_eq!(outbox_ops(conn), vec![]);
        let stored: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_items", [], |row| row.get(0))
            .map_err(crate::domain::notes::failed)?;
        assert_eq!(stored, 2);
        Ok(())
    })
    .expect("local-only writes");
}

/// A crash in the middle of a reply keeps its text: the streaming row is on
/// disk, sealed, and never queued (D1).
#[test]
fn a_streaming_message_is_stored_rewritten_and_queued_only_once_final() {
    let (db, _dir) = open("agent-queue-streaming");
    db.call_blocking(|conn| {
        let empty = reply("");
        let written = agent_message::write_local(
            conn,
            &key(),
            &message("m1", &empty, "streaming"),
            DEVICE,
            NOW,
        )
        .map_err(storage)?;
        assert_eq!(written.status, "streaming");
        let partial = reply("Half an ans");
        let edit = MessageEdit {
            content: Some(&partial),
            attachments: None,
        };
        agent_message::update_streaming(conn, &key(), "m1", &edit, DEVICE, NOW + 1)
            .map_err(storage)?;
        assert_eq!(queued(conn, "agent_message", "m1"), 0);
        let stored = agent_message::get(conn, &key(), "m1").map_err(storage)?;
        assert_eq!(stored.map(|m| m.content), Some(partial));
        let column: String = conn
            .query_row(
                "SELECT content FROM agent_messages WHERE id = 'm1'",
                [],
                |row| row.get(0),
            )
            .map_err(crate::domain::notes::failed)?;
        assert!(
            !column.contains("Half an ans"),
            "the streaming text is sealed"
        );

        let full = reply("Half an answer, then the rest.");
        let edit = MessageEdit {
            content: Some(&full),
            attachments: None,
        };
        let done = agent_message::finalize(
            conn,
            &key(),
            "m1",
            "completed",
            &edit,
            Queue::Outbox,
            DEVICE,
            NOW + 2,
        )
        .map_err(storage)?;
        assert_eq!((done.status.as_str(), done.content), ("completed", full));
        assert_eq!(queued(conn, "agent_message", "m1"), 1);
        Ok(())
    })
    .expect("streaming message");
}

#[test]
fn streaming_and_final_states_refuse_the_wrong_write() {
    let (db, _dir) = open("agent-queue-refusals");
    db.call_blocking(|conn| {
        let content = reply("x");
        let refused = |result: Result<agent_message::Message, AgentError>| {
            matches!(
                result,
                Err(AgentError::Storage(StorageError::Invalid { .. }))
            )
        };
        assert!(refused(agent_message::write_local(
            conn,
            &key(),
            &message("m1", &content, "completed"),
            DEVICE,
            NOW,
        )));
        assert!(refused(agent_message::append(
            conn,
            &key(),
            &message("m1", &content, "streaming"),
            Queue::Outbox,
            DEVICE,
            NOW,
        )));
        agent_message::append(
            conn,
            &key(),
            &message("m2", &content, "error"),
            Queue::Outbox,
            DEVICE,
            NOW,
        )
        .map_err(storage)?;
        let edit = MessageEdit::default();
        assert!(refused(agent_message::update_streaming(
            conn,
            &key(),
            "m2",
            &edit,
            DEVICE,
            NOW + 1
        )));
        assert!(refused(agent_message::finalize(
            conn,
            &key(),
            "m2",
            "completed",
            &edit,
            Queue::Outbox,
            DEVICE,
            NOW + 1,
        )));
        agent_message::write_local(
            conn,
            &key(),
            &message("m3", &content, "streaming"),
            DEVICE,
            NOW,
        )
        .map_err(storage)?;
        assert!(refused(agent_message::finalize(
            conn,
            &key(),
            "m3",
            "streaming",
            &edit,
            Queue::Outbox,
            DEVICE,
            NOW + 1,
        )));
        Ok(())
    })
    .expect("refusals");
}

/// Electron's `backfillAgentChatRows` queues every conversation of the vault,
/// deleted ones included (D2), and every final message; a second run queues
/// nothing.
#[test]
fn backfill_queues_each_record_of_the_vault_once_with_tombstones() {
    let (db, _dir) = open("agent-queue-backfill");
    db.call_blocking(|conn| {
        let live = conversation(conn, "v1", Queue::LocalOnly)?;
        let deleted = conversation(conn, "v1", Queue::LocalOnly)?;
        agent_conversation::soft_delete(conn, &deleted, Queue::LocalOnly, DEVICE, NOW + 1)?;
        let other = conversation(conn, "v2", Queue::LocalOnly)?;
        let content = reply("final");
        for (id, conversation_id, status) in [
            ("m-final", &live, "completed"),
            ("m-other", &other, "completed"),
        ] {
            let new = NewMessage {
                conversation_id,
                ..message(id, &content, status)
            };
            agent_message::append(conn, &key(), &new, Queue::LocalOnly, DEVICE, NOW)
                .map_err(storage)?;
        }
        let streaming = NewMessage {
            conversation_id: &live,
            ..message("m-streaming", &content, "streaming")
        };
        agent_message::write_local(conn, &key(), &streaming, DEVICE, NOW).map_err(storage)?;

        assert_eq!(backfill(conn, "v1", NOW + 2)?, 3);
        let mut ops = outbox_ops(conn);
        ops.sort();
        let mut expected = vec![
            (
                "agent_conversation".to_owned(),
                live.clone(),
                "upsert".to_owned(),
            ),
            (
                "agent_conversation".to_owned(),
                deleted.clone(),
                "delete".to_owned(),
            ),
            (
                "agent_message".to_owned(),
                "m-final".to_owned(),
                "upsert".to_owned(),
            ),
        ];
        expected.sort();
        assert_eq!(ops, expected);
        assert_eq!(
            backfill(conn, "v1", NOW + 3)?,
            0,
            "a second run queues nothing"
        );
        Ok(())
    })
    .expect("backfill");
}

#[test]
fn enqueue_existing_skips_unknown_and_already_queued_records() {
    let (db, _dir) = open("agent-queue-existing");
    db.call_blocking(|conn| {
        let queued_id = conversation(conn, "v1", Queue::Outbox)?;
        let local_id = conversation(conn, "v1", Queue::LocalOnly)?;
        let ids = vec![queued_id.clone(), local_id.clone(), "missing".to_owned()];
        assert_eq!(
            enqueue_existing(conn, "agent_conversation", &ids, NOW + 1)?,
            1
        );
        assert_eq!(queued(conn, "agent_conversation", &queued_id), 1);
        assert_eq!(queued(conn, "agent_conversation", &local_id), 1);
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM outbox WHERE item_id = ?1",
                params!["missing"],
                |row| row.get(0),
            )
            .map_err(crate::domain::notes::failed)?;
        assert_eq!(rows, 0);
        Ok(())
    })
    .expect("enqueue existing");
}
