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
//! still sends (`tests/sync_requeue_delete.rs`): every merge that stores over
//! the row keeps the tombstone through
//! [`crate::sync::hardening::requeue::queued_tombstone`]. The tests run every
//! type this device deletes, `canvas` included before its delete is ported,
//! and pin the branch each pulled clock takes. Removing the tombstone's
//! payload from the gate, or the queued-tombstone rule from a merge, turns
//! them red. The push signs at push time, so no delete waits for a runtime
//! either.

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use serde_json::{Value, json};

    use crate::crypto::agent_envelope::AtRestKey;
    use crate::domain::calendar_items::write::{self as calendar, NewEvent};
    use crate::domain::notes::{self, NewNote, tombstone_local};
    use crate::domain::projects::{self, NewProject, TaskDisposition};
    use crate::domain::tasks::{self, NewTask};
    use crate::domain::{agent_conversation, inbox, journal, tag_admin};
    use crate::storage::repositories::sync_items::{self, InboundRecord};
    use crate::storage::{open_data, test_support::temp_dir};
    use crate::sync::apply::{Pending, apply_inbound_on, apply_page};
    use crate::sync::outbox;

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
            "journal" => {
                journal::open_day(conn, "2026-03-10", "a", NOW)
                    .expect("journal")
                    .id
            }
            other => seed(conn, other),
        }
    }

    /// A row of `item_type` this device holds at `{a:1}`, pulled the way a
    /// peer's create arrives, for the types with no plain local create.
    fn seed(conn: &Connection, item_type: &str) -> String {
        let (id, body) = match item_type {
            "inbox" => (
                "inbox-1",
                json!({"type": "text", "title": "Read", "content": "x"}),
            ),
            "agent_conversation" => (
                "conv-1",
                json!({
                    "vaultId": "vault-1", "title": "Plan", "backend": "local",
                    "backendModel": "llama3", "trustList": [], "pinned": false,
                    "createdAt": NOW, "updatedAt": NOW, "deletedAt": null,
                }),
            ),
            "tag_definition" => ("work", json!({"name": "work", "color": "blue"})),
            "vault_lock" => (
                "folder:Projects",
                json!({
                    "targetKind": "folder", "target": "Projects", "locked": true,
                    "createdAt": "2026-03-10T09:00:00.000Z",
                    "updatedAt": "2026-03-10T09:00:00.000Z",
                }),
            ),
            "calendar_source" => (
                "src-1",
                json!({
                    "provider": "google", "kind": "calendar", "accountId": "acct-1",
                    "remoteId": "primary", "title": "Work", "timezone": "UTC",
                }),
            ),
            "calendar_binding" => (
                "bind-1",
                json!({
                    "sourceType": "event", "sourceId": "evt-1", "provider": "google",
                    "remoteCalendarId": "primary", "remoteEventId": "r-1",
                    "ownershipMode": "memry_managed", "writebackMode": "broad",
                }),
            ),
            "calendar_external_event" => (
                "ext-1",
                json!({
                    "sourceId": "src-1", "remoteEventId": "r-1", "title": "Standup",
                    "startAt": "2026-03-10T09:00:00.000Z",
                    "endAt": "2026-03-10T09:15:00.000Z", "isAllDay": false,
                    "timezone": "UTC",
                }),
            ),
            "canvas" => (
                "canvas-1",
                json!({
                    "id": "canvas-1", "vaultId": "vault-1", "title": "Board",
                    "scene": "{\"elements\":[]}", "folder": null, "icon": null,
                    "ownerNoteId": null, "deletedAt": null,
                }),
            ),
            other => panic!("no fixture for {other}"),
        };
        let mut body = body;
        body["clock"] = json!({"a": 1});
        let record = InboundRecord {
            item_type: item_type.to_owned(),
            item_id: id.to_owned(),
            payload_json: body.to_string(),
            server_cursor: Some(1),
            signer_device_id: Some("a".to_owned()),
            updated_at: NOW,
            deleted_at: None,
        };
        apply_inbound_on(conn, &record, NOW, Some("a")).expect("seed");
        id.to_owned()
    }

    fn delete(conn: &Connection, item_type: &str, id: &str) {
        match item_type {
            "note" => notes::delete(conn, id, "a", NOW + 2).map(|d| d.acknowledge()),
            "task" => tasks::delete(conn, id, "a", NOW + 2).map(|d| d.acknowledge()),
            "project" => projects::delete(conn, id, TaskDisposition::Delete, "a", NOW + 2)
                .map(|d| d.acknowledge()),
            "calendar_event" => calendar::delete_event(conn, id, "a", NOW + 2).map(drop),
            "journal" => journal::delete_day(conn, "2026-03-10", "a", NOW + 2).map(drop),
            "inbox" => {
                inbox::states::delete_permanent(conn, id, "a", NOW + 2).map(|d| d.acknowledge())
            }
            "agent_conversation" => {
                agent_conversation::soft_delete(conn, id, "a", NOW + 2).map(drop)
            }
            "tag_definition" => tag_admin::delete_definitions(conn, id, "a", NOW + 2),
            // No public delete of its own (the calendar purge, a future canvas
            // or lock delete): the tombstone and queued `delete` every domain
            // delete above reduces to (`selection::purge_mirrors`).
            _ => outbox::commit(
                conn,
                &outbox::Change::delete(item_type, id),
                NOW + 2,
                |tx| tombstone_local(tx, item_type, id, "a", NOW + 2),
            )
            .map(|d| d.acknowledge()),
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

    /// `concurrent` pins the branch the pulled clock takes: a merge that
    /// applies, or the gate's skip of an older one.
    fn probe(item_type: &str, clock: Value, concurrent: bool) {
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
            let totals = apply_page(
                conn,
                vec![pulled(&item_type, &id, payload, clock)],
                vec![],
                NOW + 4,
                Some("a"),
                &AtRestKey::default(),
            )?;
            assert_eq!(
                (totals.applied, totals.skipped),
                if concurrent { (1, 0) } else { (0, 1) },
                "{item_type}: the pulled update took another branch"
            );
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

    /// Every type this device can delete, or will once its delete is ported.
    const TYPES: [&str; 13] = [
        "note",
        "task",
        "project",
        "calendar_event",
        "journal",
        "inbox",
        "agent_conversation",
        "tag_definition",
        "vault_lock",
        "calendar_source",
        "calendar_binding",
        "calendar_external_event",
        "canvas",
    ];

    #[test]
    fn a_pending_delete_survives_a_replayed_older_update() {
        for item_type in TYPES {
            probe(item_type, json!({"a": 1}), false);
        }
    }

    #[test]
    fn a_pending_delete_survives_a_concurrent_peer_update() {
        for item_type in TYPES {
            probe(item_type, json!({"a": 1, "b": 1}), true);
        }
    }
}
