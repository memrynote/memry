//! `vault_lock` sync on a real `data.db` (Step 16, #3533): what a lock change
//! queues, how a lock row from before Step 16 is seeded, and Electron's apply
//! rules (`vault-lock-handler.ts`) through the real pull apply step.

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::{SetOutcome, TargetKind, list, seed_unsynced, set};
use crate::api::errors::StorageError;
use crate::storage::repositories::instants;
use crate::storage::repositories::sync_items::{self, InboundRecord};
use crate::storage::{Db, open_data, test_support::temp_dir};
use crate::sync::apply::{ApplyTotals, Pending, apply_page};
use crate::sync::clock::{ClockOrder, VectorClock, clock_of, compare};

const NOW: i64 = 1_776_297_600_000;
const ID: &str = "folder:Projects";

fn open(label: &str) -> (Db, crate::storage::test_support::TempDir) {
    let dir = temp_dir(label);
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    (db, dir)
}

fn iso(ms: i64) -> String {
    instants::to_iso8601(ms).expect("an instant")
}

fn payload(conn: &Connection, id: &str) -> Value {
    let raw = sync_items::push_payload(conn, "vault_lock", id)
        .expect("read")
        .expect("a record");
    serde_json::from_str(&raw).expect("json")
}

fn clock(conn: &Connection, id: &str) -> VectorClock {
    serde_json::from_value(payload(conn, id)["clock"].clone()).expect("a clock")
}

fn queued(conn: &Connection, id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM outbox WHERE item_type = 'vault_lock' AND item_id = ?1",
        params![id],
        |row| row.get(0),
    )
    .expect("count")
}

fn folders(conn: &Connection) -> Vec<String> {
    list(conn).expect("list").folders
}

fn pull(conn: &Connection, item: Pending) -> Result<ApplyTotals, StorageError> {
    apply_page(
        conn,
        vec![item],
        vec![],
        NOW + 10,
        Some("device-a"),
        &crate::crypto::agent_envelope::AtRestKey::default(),
    )
}

fn remote(id: &str, body: Value) -> Pending {
    Pending::Record(InboundRecord {
        item_type: "vault_lock".to_owned(),
        item_id: id.to_owned(),
        payload_json: body.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("peer".to_owned()),
        updated_at: NOW + 5,
        deleted_at: None,
    })
}

fn remote_delete(id: &str, clock: VectorClock) -> Pending {
    Pending::Tombstone {
        item_type: "vault_lock".to_owned(),
        item_id: id.to_owned(),
        deleted_at: NOW + 5,
        server_cursor: Some(2),
        clock: Some(clock),
        body_state_vector: None,
    }
}

#[test]
fn a_lock_change_writes_electrons_payload_and_queues_it_and_no_change_queues_nothing() {
    let (db, _dir) = open("vault-lock-set");
    db.call_blocking(|conn| {
        set(conn, TargetKind::Folder, "/Projects/", true, "device-a", NOW)?;
        let created = iso(NOW);
        assert_eq!(
            sync_items::push_payload(conn, "vault_lock", ID)?.as_deref(),
            Some(
                format!(
                    r#"{{"targetKind":"folder","target":"Projects","locked":true,"clock":{{"device-a":1}},"createdAt":"{created}","updatedAt":"{created}"}}"#
                )
                .as_str()
            ),
            "Electron's buildPushPayload, key for key"
        );
        assert_eq!(queued(conn, ID), 1);

        assert_eq!(
            set(conn, TargetKind::Folder, "Projects", false, "device-a", NOW + 1)?,
            SetOutcome::Updated
        );
        let unlocked = payload(conn, ID);
        assert_eq!(unlocked["locked"], json!(false));
        assert_eq!(unlocked["createdAt"], json!(created));
        assert_eq!(unlocked["updatedAt"], json!(iso(NOW + 1)));
        assert_eq!(clock(conn, ID), clock_of([("device-a", 2)]));
        assert!(folders(conn).is_empty());

        let queued_before = queued(conn, ID);
        let before = payload(conn, ID);
        assert_eq!(
            set(conn, TargetKind::Folder, "Projects", false, "device-a", NOW + 2)?,
            SetOutcome::Unchanged
        );
        assert_eq!(payload(conn, ID), before);
        assert_eq!(queued(conn, ID), queued_before);
        Ok(())
    })
    .expect("set");
}

#[test]
fn a_lock_after_a_peers_delete_unlocks_then_ticks_past_the_tombstone() {
    let (db, _dir) = open("vault-lock-revive");
    db.call_blocking(|conn| {
        set(conn, TargetKind::Folder, "Projects", true, "device-a", NOW)?;
        let tombstone = clock_of([("device-a", 1), ("peer", 4)]);
        let totals = pull(conn, remote_delete(ID, tombstone.clone()))?;
        assert_eq!(totals.deleted, 1);
        assert!(folders(conn).is_empty(), "a delete from elsewhere unlocks");

        assert_eq!(
            set(
                conn,
                TargetKind::Folder,
                "Projects",
                true,
                "device-a",
                NOW + 20
            )?,
            SetOutcome::Created
        );
        assert_eq!(compare(&clock(conn, ID), &tombstone), ClockOrder::After);
        assert_eq!(folders(conn), ["Projects"]);
        Ok(())
    })
    .expect("revive");
}

#[test]
fn a_delete_older_than_the_local_lock_keeps_it() {
    let (db, _dir) = open("vault-lock-delete-older");
    db.call_blocking(|conn| {
        set(conn, TargetKind::Folder, "Projects", true, "device-a", NOW)?;
        set(
            conn,
            TargetKind::Folder,
            "Projects",
            false,
            "device-a",
            NOW + 1,
        )?;
        set(
            conn,
            TargetKind::Folder,
            "Projects",
            true,
            "device-a",
            NOW + 2,
        )?;
        let totals = pull(conn, remote_delete(ID, clock_of([("device-a", 1)])))?;
        assert_eq!(totals.skipped, 1);
        assert_eq!(folders(conn), ["Projects"]);
        Ok(())
    })
    .expect("delete");
}

#[test]
fn rows_from_before_step_16_are_seeded_once_with_their_instants() {
    let (db, _dir) = open("vault-lock-seed");
    db.call_blocking(|conn| {
        conn.execute_batch(
            "INSERT INTO vault_locks (id, target_kind, target, locked, created_at, updated_at)
               VALUES ('folder:Projects', 'folder', 'Projects', 1, 1700000000123, 1700000000456),
                      ('folder:Old', 'folder', 'Old', 0, 5, 6);
             INSERT INTO vault_locks (id, target_kind, target, locked, created_at, updated_at,
                                      deleted_at)
               VALUES ('folder:Gone', 'folder', 'Gone', 1, 5, 6, 9);",
        )
        .expect("rows a 14e build wrote");

        assert_eq!(seed_unsynced(conn, "device-a", NOW)?, 2);
        assert_eq!(
            payload(conn, ID),
            json!({
                "targetKind": "folder",
                "target": "Projects",
                "locked": true,
                "clock": {"device-a": 1},
                "createdAt": iso(1_700_000_000_123),
                "updatedAt": iso(1_700_000_000_456),
            })
        );
        assert_eq!(payload(conn, "folder:Old")["locked"], json!(false));
        assert_eq!((queued(conn, ID), queued(conn, "folder:Old")), (1, 1));
        assert_eq!(
            queued(conn, "folder:Gone"),
            0,
            "a deleted row is not seeded"
        );
        let created_at: i64 = conn
            .query_row(
                "SELECT created_at FROM vault_locks WHERE id = ?1",
                params![ID],
                |row| row.get(0),
            )
            .expect("row");
        assert_eq!(created_at, 1_700_000_000_123, "ISO and back is lossless");

        assert_eq!(seed_unsynced(conn, "device-a", NOW + 1)?, 0, "idempotent");
        assert_eq!(queued(conn, ID), 1);
        Ok(())
    })
    .expect("seed");
}

#[test]
fn a_row_with_a_clock_and_no_record_ticks_from_its_clock() {
    let (db, _dir) = open("vault-lock-lineage");
    db.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO vault_locks (id, target_kind, target, locked, created_at, updated_at,
                                      clock)
             VALUES (?1, 'folder', 'Projects', 1, 5, 6, '{\"peer\":3}')",
            params![ID],
        )
        .expect("a synced row with no record");
        assert_eq!(
            set(conn, TargetKind::Folder, "Projects", false, "device-a", NOW)?,
            SetOutcome::Updated
        );
        assert_eq!(clock(conn, ID), clock_of([("peer", 3), ("device-a", 1)]));
        assert_eq!(payload(conn, ID)["createdAt"], json!(iso(5)));
        Ok(())
    })
    .expect("lineage");
}

#[test]
fn a_remote_create_locks_and_keeps_every_key_it_carried() {
    let (db, _dir) = open("vault-lock-remote-create");
    db.call_blocking(|conn| {
        let body = json!({
            "targetKind": "folder", "target": "Projects", "locked": true,
            "clock": {"peer": 1}, "createdAt": iso(NOW), "updatedAt": iso(NOW),
            "id": ID, "syncedAt": iso(NOW),
        });
        assert_eq!(pull(conn, remote(ID, body.clone()))?.applied, 1);
        assert_eq!(folders(conn), ["Projects"]);
        assert_eq!(
            sync_items::push_payload(conn, "vault_lock", ID)?,
            Some(body.to_string())
        );
        Ok(())
    })
    .expect("remote create");
}

#[test]
fn a_remote_create_missing_a_row_field_or_of_an_unknown_kind_is_skipped() {
    let (db, _dir) = open("vault-lock-remote-skip");
    db.call_blocking(|conn| {
        for body in [
            json!({"target": "Projects", "locked": true, "clock": {"peer": 1}}),
            json!({"targetKind": "folder", "target": "", "locked": true, "clock": {"peer": 1}}),
            json!({"targetKind": "folder", "target": "Projects", "clock": {"peer": 1}}),
            json!({"targetKind": "tag", "target": "Projects", "locked": true, "clock": {"peer": 1}}),
        ] {
            assert_eq!(pull(conn, remote(ID, body.clone()))?.skipped, 1, "{body}");
            assert!(sync_items::load(conn, "vault_lock", ID)?.is_none(), "{body}");
        }
        assert_eq!(folders(conn), Vec::<String>::new());
        Ok(())
    })
    .expect("skips");
}

#[test]
fn a_remote_update_moves_locked_and_keeps_the_local_target() {
    let (db, _dir) = open("vault-lock-remote-update");
    db.call_blocking(|conn| {
        set(conn, TargetKind::Folder, "Projects", true, "device-a", NOW)?;

        // An unknown kind never touches the local record.
        let unknown = json!({"targetKind": "tag", "locked": false,
                             "clock": {"device-a": 1, "peer": 1}});
        assert_eq!(pull(conn, remote(ID, unknown))?.skipped, 1);
        assert_eq!(folders(conn), ["Projects"]);

        // A newer update that names another target and leaves `updatedAt` out.
        let newer = json!({"targetKind": "folder", "target": "Elsewhere", "locked": false,
                           "createdAt": iso(1), "clock": {"device-a": 1, "peer": 1}});
        assert_eq!(pull(conn, remote(ID, newer))?.applied, 1);
        let stored = payload(conn, ID);
        assert_eq!(stored["target"], json!("Projects"));
        assert_eq!(stored["createdAt"], json!(iso(NOW)));
        assert_eq!(stored["locked"], json!(false));
        let (target, updated_at): (String, i64) = conn
            .query_row(
                "SELECT target, updated_at FROM vault_locks WHERE id = ?1",
                params![ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("row");
        assert_eq!((target.as_str(), updated_at), ("Projects", NOW + 10));
        assert_eq!(queued(conn, ID), 1, "an apply queues nothing");

        // A newer update without `locked` keeps the local value.
        let silent = json!({"clock": {"device-a": 1, "peer": 2}});
        assert_eq!(pull(conn, remote(ID, silent))?.applied, 1);
        assert_eq!(payload(conn, ID)["locked"], json!(false));
        Ok(())
    })
    .expect("remote update");
}

#[test]
fn a_stale_remote_is_skipped_and_a_concurrent_one_wins_under_the_merged_clock() {
    let (db, _dir) = open("vault-lock-remote-clock");
    db.call_blocking(|conn| {
        set(conn, TargetKind::Folder, "Projects", true, "device-a", NOW)?;
        set(
            conn,
            TargetKind::Folder,
            "Projects",
            false,
            "device-a",
            NOW + 1,
        )?;
        let stale = json!({"targetKind": "folder", "target": "Projects", "locked": true,
                           "clock": {"device-a": 1}});
        assert_eq!(pull(conn, remote(ID, stale))?.skipped, 1);
        assert!(folders(conn).is_empty());

        let concurrent = json!({"targetKind": "folder", "target": "Projects", "locked": true,
                                "clock": {"device-a": 1, "peer": 1}});
        assert_eq!(pull(conn, remote(ID, concurrent))?.applied, 1);
        assert_eq!(folders(conn), ["Projects"], "last writer wins: the remote");
        assert_eq!(
            clock(conn, ID),
            clock_of([("device-a", 2), ("peer", 1)]),
            "the merged clock"
        );
        Ok(())
    })
    .expect("clocks");
}

/// A row with no record whose clock will not parse is refused by name, not
/// locked from an empty clock the server would refuse.
#[test]
fn a_row_whose_clock_will_not_parse_is_refused_with_its_id() {
    let (db, _dir) = open("vault-lock-bad-clock");
    db.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO vault_locks (id, target_kind, target, locked, created_at, updated_at, clock)
             VALUES (?1, 'folder', 'Projects', 0, 5, 6, 'not a clock')",
            params![ID],
        )
        .expect("a row with a damaged clock");
        let error = set(conn, TargetKind::Folder, "Projects", true, "device-a", NOW)
            .expect_err("a damaged clock is refused");
        assert!(error.to_string().contains(ID), "{error}");
        assert_eq!(queued(conn, ID), 0);
        assert!(folders(conn).is_empty());
        Ok(())
    })
    .expect("refusal");
}
