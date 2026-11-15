//! Why Electron's pending-deletes ledger (`apps/desktop/src/main/sync/
//! pending-deletes.ts`, `apply-item.ts:132-143`) is not ported (Step 17 L3a,
//! #3534): the tests below are its resurrection guard, and they pass without
//! one.
//!
//! Electron hard-deletes notes and tasks locally, so a missing row could mean
//! "never had it" or "the user just deleted it", and a delete raised with no
//! runtime up could not be signed. Its `sync_pending_deletes` row is the only
//! record of the delete until the server lists the item gone, and the pull
//! refuses every upsert of a pending id.
//!
//! Core never loses that record. A local delete keeps the row, marks it
//! deleted and ticks its clock ([`crate::domain::notes::tombstone_local`]) in
//! the transaction that queues its outbox row (`outbox::commit`). A pulled
//! update then meets that clock in the document gate
//! ([`crate::domain::task_merge::document_gate`]): an older or replayed one
//! is skipped, and a concurrent one merges under the delete, which the push
//! still sends (`tests/sync_requeue_delete.rs`). Removing the tombstone's
//! payload from the gate turns both tests red. The push signs at push time,
//! so no delete waits for a runtime either.

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use serde_json::{Value, json};

    use crate::crypto::agent_envelope::AtRestKey;
    use crate::domain::calendar_items::write::{self as calendar, NewEvent};
    use crate::domain::notes::{self, NewNote};
    use crate::domain::projects::{self, NewProject, TaskDisposition};
    use crate::domain::tasks::{self, NewTask};
    use crate::storage::repositories::sync_items::{self, InboundRecord};
    use crate::storage::{open_data, test_support::temp_dir};
    use crate::sync::apply::{Pending, apply_page};

    const NOW: i64 = 1_760_000_000_000;

    fn create(conn: &Connection, item_type: &str) -> String {
        match item_type {
            "note" => notes::create(
                conn,
                &NewNote {
                    id: "note-1",
                    title: "Plan",
                    folder_path: None,
                    content: "body",
                    tags: &[],
                    properties: None,
                    emoji: None,
                },
                "a",
                NOW,
            )
            .map(|_| "note-1".to_owned())
            .expect("note"),
            "task" => tasks::create(
                conn,
                &NewTask {
                    id: "task-1",
                    title: "Ship",
                    project_id: "proj-1",
                    due_date: None,
                    due_time: None,
                    priority: 1,
                    repeat_config: None,
                    tags: &[],
                },
                "a",
                NOW,
            )
            .map(|_| "task-1".to_owned())
            .expect("task"),
            "project" => projects::create(
                conn,
                &NewProject {
                    id: Some("proj-9"),
                    name: "Alpha",
                    description: None,
                    color: None,
                    icon: None,
                    statuses: None,
                },
                "a",
                NOW,
            )
            .expect("project")
            .acknowledge(),
            "calendar_event" => calendar::create_event(
                conn,
                &NewEvent {
                    title: "Standup".into(),
                    start_at: "2026-03-10T09:00:00.000Z".into(),
                    end_at: Some("2026-03-10T09:15:00.000Z".into()),
                    timezone: "UTC".into(),
                    ..NewEvent::default()
                },
                "a",
                NOW,
            )
            .expect("event"),
            other => panic!("{other}"),
        }
    }

    fn delete(conn: &Connection, item_type: &str, id: &str) {
        match item_type {
            "note" => notes::delete(conn, id, "a", NOW + 2).map(|d| d.acknowledge()),
            "task" => tasks::delete(conn, id, "a", NOW + 2).map(|d| d.acknowledge()),
            "project" => projects::delete(conn, id, TaskDisposition::Delete, "a", NOW + 2)
                .map(|d| d.acknowledge()),
            "calendar_event" => calendar::delete_event(conn, id, "a", NOW + 2).map(drop),
            other => panic!("{other}"),
        }
        .expect("delete");
    }

    fn pulled(item_type: &str, id: &str, mut payload: Value, clock: Value) -> Pending {
        payload["clock"] = clock.clone();
        if let Some(fields) = payload
            .get_mut("fieldClocks")
            .and_then(Value::as_object_mut)
        {
            for value in fields.values_mut() {
                *value = clock.clone();
            }
        }
        Pending::Record(InboundRecord {
            item_type: item_type.to_owned(),
            item_id: id.to_owned(),
            payload_json: payload.to_string(),
            server_cursor: Some(9),
            signer_device_id: Some("b".to_owned()),
            updated_at: NOW + 3,
            deleted_at: None,
        })
    }

    fn queued_ops(conn: &Connection, item_type: &str, id: &str) -> Vec<String> {
        let mut statement = conn
            .prepare("SELECT op FROM outbox WHERE item_type = ?1 AND item_id = ?2 ORDER BY id")
            .expect("prepare");
        statement
            .query_map([item_type, id], |row| row.get(0))
            .expect("query")
            .map(|row| row.expect("row"))
            .collect()
    }

    fn probe(item_type: &str, clock: Value) {
        let dir = temp_dir("pending-delete-probe");
        let db = open_data(&dir.path().join("data.db")).expect("open");
        let item_type = item_type.to_owned();
        db.call_blocking(move |conn| {
            let id = create(conn, &item_type);
            let raw = sync_items::load(conn, &item_type, &id)
                .expect("read")
                .and_then(|row| row.payload)
                .expect("payload");
            conn.execute("DELETE FROM outbox", []).expect("drain");
            delete(conn, &item_type, &id);
            let payload: Value = serde_json::from_str(&raw).expect("json");
            apply_page(
                conn,
                vec![pulled(&item_type, &id, payload, clock)],
                vec![],
                NOW + 4,
                Some("a"),
                &AtRestKey::default(),
            )?;
            let row = sync_items::load(conn, &item_type, &id)?.expect("row");
            assert!(
                row.deleted_at.is_some(),
                "{item_type}: the pulled update resurrected a pending delete"
            );
            let ops = queued_ops(conn, &item_type, &id);
            assert_eq!(
                ops.last().map(String::as_str),
                Some("delete"),
                "{item_type}: {ops:?}"
            );
            Ok(())
        })
        .expect("probe");
    }

    const TYPES: [&str; 4] = ["note", "task", "project", "calendar_event"];

    #[test]
    fn a_pending_delete_survives_a_replayed_older_update() {
        for item_type in TYPES {
            probe(item_type, json!({"a": 1}));
        }
    }

    #[test]
    fn a_pending_delete_survives_a_concurrent_peer_update() {
        for item_type in TYPES {
            probe(item_type, json!({"a": 1, "b": 1}));
        }
    }
}
