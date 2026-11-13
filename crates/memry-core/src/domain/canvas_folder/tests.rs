//! `canvas_folder` on a real `data.db` (Step 16, #3533): the path-derived id,
//! what a folder write queues, and Electron's apply rules
//! (`canvas-folder-handler.ts`) through the real pull apply step.

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::{ITEM_TYPE, delete, list, sync_id, upsert};
use crate::domain::desktop_records::testing::{
    DEVICE, NOW, clock, open, payload, pull, queued, remote, remote_delete,
};
use crate::storage::repositories::sync_items;
use crate::sync::clock::{ClockOrder, clock_of, compare};

const VAULT: &str = "vault-1";

fn paths(conn: &Connection) -> Vec<String> {
    list(conn)
        .expect("list")
        .into_iter()
        .map(|folder| folder.path)
        .collect()
}

fn row(conn: &Connection, id: &str) -> (Option<String>, String, Option<i64>) {
    conn.query_row(
        "SELECT vault_id, path, deleted_at FROM canvas_folders WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .expect("row")
}

#[test]
fn the_id_is_the_path_in_nfc_lowercased_as_canvas_folder_sync_id() {
    // `packages/contracts/src/canvas-folder-types.test.ts`.
    assert_eq!(sync_id("Work/Q3"), "cvf_work/q3");
    assert_eq!(sync_id("work"), sync_id("Work"));
    assert_ne!(sync_id("Work/Q3"), sync_id("Work"));
    let nfc = "Ya\u{11f}mur";
    let nfd = "Yag\u{306}mur";
    assert_ne!(nfc, nfd);
    assert_eq!(sync_id(nfd), sync_id(nfc));
    assert_eq!(sync_id(nfc), "cvf_ya\u{11f}mur");
}

#[test]
fn a_folder_writes_electrons_payload_and_an_unchanged_upsert_queues_nothing() {
    let (db, _dir) = open("canvas-folder-write");
    db.call_blocking(|conn| {
        let folder = upsert(conn, VAULT, "Work", None, DEVICE, NOW)?;
        assert_eq!(folder.id, "cvf_work");
        assert_eq!(
            payload(conn, ITEM_TYPE, "cvf_work"),
            json!({
                "id": "cvf_work", "vaultId": VAULT, "path": "Work", "icon": null,
                "clock": {"device-a": 1}, "deletedAt": null,
            })
        );
        assert_eq!(queued(conn, ITEM_TYPE, "cvf_work"), 1);

        let before = payload(conn, ITEM_TYPE, "cvf_work");
        upsert(conn, VAULT, "work", None, DEVICE, NOW + 1)?;
        upsert(conn, VAULT, "Work", Some(None), DEVICE, NOW + 2)?;
        assert_eq!(payload(conn, ITEM_TYPE, "cvf_work"), before);
        assert_eq!(queued(conn, ITEM_TYPE, "cvf_work"), 1);

        let iconed = upsert(conn, VAULT, "work", Some(Some("star")), DEVICE, NOW + 3)?;
        assert_eq!(
            (iconed.path.as_str(), iconed.icon.as_deref()),
            ("Work", Some("star")),
            "a live folder keeps its spelling"
        );
        assert_eq!(
            clock(conn, ITEM_TYPE, "cvf_work"),
            clock_of([("device-a", 2)])
        );
        Ok(())
    })
    .expect("write");
}

#[test]
fn a_delete_states_deleted_at_and_a_later_upsert_revives_past_it() {
    let (db, _dir) = open("canvas-folder-delete");
    db.call_blocking(|conn| {
        upsert(conn, VAULT, "Work", Some(Some("star")), DEVICE, NOW)?;
        assert!(delete(conn, "WORK", DEVICE, NOW + 1)?);
        assert!(!delete(conn, "Work", DEVICE, NOW + 2)?);
        assert!(paths(conn).is_empty());
        let deleted = payload(conn, ITEM_TYPE, "cvf_work");
        assert_eq!(deleted["deletedAt"], json!(NOW + 1));
        let tombstone = clock(conn, ITEM_TYPE, "cvf_work");

        let revived = upsert(conn, VAULT, "Work", None, DEVICE, NOW + 3)?;
        assert_eq!(revived.icon, None, "a revived folder starts with no icon");
        assert_eq!(paths(conn), ["Work"]);
        assert_eq!(
            payload(conn, ITEM_TYPE, "cvf_work")["deletedAt"],
            Value::Null
        );
        assert_eq!(
            compare(&clock(conn, ITEM_TYPE, "cvf_work"), &tombstone),
            ClockOrder::After
        );
        Ok(())
    })
    .expect("delete");
}

#[test]
fn a_remote_create_needs_a_vault_and_a_path_and_keeps_every_key_it_carried() {
    let (db, _dir) = open("canvas-folder-remote-create");
    db.call_blocking(|conn| {
        for body in [
            json!({"path": "Work", "clock": {"peer": 1}}),
            json!({"vaultId": "", "path": "Work", "clock": {"peer": 1}}),
            json!({"vaultId": VAULT, "clock": {"peer": 1}}),
            json!({"vaultId": VAULT, "path": "", "clock": {"peer": 1}}),
        ] {
            assert_eq!(
                pull(conn, vec![remote(ITEM_TYPE, "cvf_work", &body)])?.skipped,
                1
            );
            assert!(
                sync_items::load(conn, ITEM_TYPE, "cvf_work")?.is_none(),
                "{body}"
            );
        }
        let body = json!({"id": "cvf_work", "vaultId": VAULT, "path": "Work", "icon": "star",
                          "clock": {"peer": 1}, "deletedAt": null, "syncedAt": 5});
        assert_eq!(
            pull(conn, vec![remote(ITEM_TYPE, "cvf_work", &body)])?.applied,
            1
        );
        assert_eq!(
            sync_items::push_payload(conn, ITEM_TYPE, "cvf_work")?,
            Some(body.to_string())
        );
        assert_eq!(paths(conn), ["Work"]);
        assert_eq!(queued(conn, ITEM_TYPE, "cvf_work"), 0);
        Ok(())
    })
    .expect("remote create");
}

#[test]
fn a_remote_update_keeps_the_local_path_icon_and_vault_it_does_not_state() {
    let (db, _dir) = open("canvas-folder-remote-update");
    db.call_blocking(|conn| {
        upsert(conn, VAULT, "Work", Some(Some("star")), DEVICE, NOW)?;

        let before = payload(conn, ITEM_TYPE, "cvf_work");
        let null = json!({"path": null, "clock": {"device-a": 1, "peer": 1}});
        assert_eq!(
            pull(conn, vec![remote(ITEM_TYPE, "cvf_work", &null)])?.skipped,
            1,
            "a null path fails desktop's schema"
        );
        assert_eq!(payload(conn, ITEM_TYPE, "cvf_work"), before);

        let silent = json!({"vaultId": "other", "clock": {"device-a": 1, "peer": 1}});
        assert_eq!(
            pull(conn, vec![remote(ITEM_TYPE, "cvf_work", &silent)])?.applied,
            1
        );
        let stored = payload(conn, ITEM_TYPE, "cvf_work");
        assert_eq!(stored["path"], json!("Work"), "absent path keeps");
        assert_eq!(stored["icon"], json!("star"), "absent icon keeps");
        assert_eq!(stored["vaultId"], json!(VAULT), "vaultId stays local");

        let clear = json!({"icon": null, "path": "Work", "clock": {"device-a": 1, "peer": 2}});
        assert_eq!(
            pull(conn, vec![remote(ITEM_TYPE, "cvf_work", &clear)])?.applied,
            1
        );
        assert_eq!(list(conn)?[0].icon, None, "null icon clears");
        assert_eq!(
            queued(conn, ITEM_TYPE, "cvf_work"),
            1,
            "an apply queues nothing"
        );
        Ok(())
    })
    .expect("remote update");
}

#[test]
fn a_remote_soft_delete_deletes_and_a_later_update_without_it_revives() {
    let (db, _dir) = open("canvas-folder-remote-soft-delete");
    db.call_blocking(|conn| {
        upsert(conn, VAULT, "Work", None, DEVICE, NOW)?;
        let soft = json!({"deletedAt": NOW + 4, "clock": {"device-a": 1, "peer": 1}});
        assert_eq!(
            pull(conn, vec![remote(ITEM_TYPE, "cvf_work", &soft)])?.applied,
            1
        );
        assert!(paths(conn).is_empty(), "deletedAt is the remote's");
        assert_eq!(row(conn, "cvf_work").2, Some(NOW + 4));

        let revive = json!({"clock": {"device-a": 1, "peer": 2}});
        assert_eq!(
            pull(conn, vec![remote(ITEM_TYPE, "cvf_work", &revive)])?.applied,
            1
        );
        assert_eq!(paths(conn), ["Work"], "an absent deletedAt revives");
        Ok(())
    })
    .expect("soft delete");
}

#[test]
fn a_remote_update_over_a_locally_deleted_folder_is_an_update_not_a_create() {
    let (db, _dir) = open("canvas-folder-remote-over-deleted");
    db.call_blocking(|conn| {
        upsert(conn, VAULT, "Work", None, DEVICE, NOW)?;
        delete(conn, "Work", DEVICE, NOW + 1)?;
        // No vaultId: a create would be skipped, an update keeps the local one.
        let body = json!({"path": "Work", "icon": "star",
                          "clock": {"device-a": 2, "peer": 1}});
        assert_eq!(
            pull(conn, vec![remote(ITEM_TYPE, "cvf_work", &body)])?.applied,
            1
        );
        assert_eq!(
            payload(conn, ITEM_TYPE, "cvf_work")["vaultId"],
            json!(VAULT)
        );
        assert_eq!(row(conn, "cvf_work").0.as_deref(), Some(VAULT));
        Ok(())
    })
    .expect("over deleted");
}

#[test]
fn a_stale_remote_is_skipped_and_a_concurrent_one_wins_under_the_merged_clock() {
    let (db, _dir) = open("canvas-folder-remote-clock");
    db.call_blocking(|conn| {
        upsert(conn, VAULT, "Work", None, DEVICE, NOW)?;
        upsert(conn, VAULT, "Work", Some(Some("mine")), DEVICE, NOW + 1)?;
        let stale = json!({"icon": "old", "clock": {"device-a": 1}});
        assert_eq!(
            pull(conn, vec![remote(ITEM_TYPE, "cvf_work", &stale)])?.skipped,
            1
        );
        assert_eq!(list(conn)?[0].icon.as_deref(), Some("mine"));

        let concurrent = json!({"icon": "theirs", "clock": {"device-a": 1, "peer": 1}});
        assert_eq!(
            pull(conn, vec![remote(ITEM_TYPE, "cvf_work", &concurrent)])?.applied,
            1
        );
        assert_eq!(list(conn)?[0].icon.as_deref(), Some("theirs"));
        assert_eq!(
            clock(conn, ITEM_TYPE, "cvf_work"),
            clock_of([("device-a", 2), ("peer", 1)])
        );
        Ok(())
    })
    .expect("clocks");
}

#[test]
fn a_remote_delete_removes_the_folder_unless_the_local_clock_is_after_it() {
    let (db, _dir) = open("canvas-folder-remote-delete");
    db.call_blocking(|conn| {
        upsert(conn, VAULT, "Work", None, DEVICE, NOW)?;
        upsert(conn, VAULT, "Work", Some(Some("star")), DEVICE, NOW + 1)?;
        let older = remote_delete(ITEM_TYPE, "cvf_work", clock_of([("device-a", 1)]));
        assert_eq!(pull(conn, vec![older])?.skipped, 1);
        assert_eq!(paths(conn), ["Work"]);

        let newer = remote_delete(
            ITEM_TYPE,
            "cvf_work",
            clock_of([("device-a", 2), ("peer", 1)]),
        );
        assert_eq!(pull(conn, vec![newer])?.deleted, 1);
        assert!(paths(conn).is_empty());
        Ok(())
    })
    .expect("delete");
}
