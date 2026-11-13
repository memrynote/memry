//! `sticky_draft` on a real `data.db` (Step 16, #3533): what a draft write
//! queues, and Electron's apply rules (`sticky-draft-handler.ts`) through the
//! real pull apply step.

use rusqlite::{Connection, params};
use serde_json::json;

use super::{ITEM_TYPE, StickyKind, delete, get, list, upsert};
use crate::domain::desktop_records::testing::{
    DEVICE, NOW, clock, iso, open, payload, pull, queued, remote, remote_delete,
};
use crate::storage::repositories::sync_items;
use crate::sync::clock::{ClockOrder, clock_of, compare};

const ID: &str = "draft-1";

fn modified_at(conn: &Connection, id: &str) -> i64 {
    conn.query_row(
        "SELECT modified_at FROM sticky_drafts WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .expect("row")
}

fn ids(conn: &Connection) -> Vec<String> {
    list(conn)
        .expect("list")
        .into_iter()
        .map(|draft| draft.id)
        .collect()
}

#[test]
fn a_draft_writes_the_five_schema_keys_and_an_unchanged_save_queues_nothing() {
    let (db, _dir) = open("sticky-draft-write");
    db.call_blocking(|conn| {
        let draft = upsert(conn, None, "buy milk", StickyKind::Task, DEVICE, NOW)?;
        let created = iso(NOW);
        assert_eq!(
            payload(conn, ITEM_TYPE, &draft.id),
            json!({
                "content": "buy milk", "kind": "task", "clock": {"device-a": 1},
                "createdAt": created, "modifiedAt": created,
            })
        );
        assert_eq!(queued(conn, ITEM_TYPE, &draft.id), 1);

        let edited = upsert(
            conn,
            Some(&draft.id),
            "buy oat milk",
            StickyKind::Task,
            DEVICE,
            NOW + 1,
        )?;
        assert_eq!(edited.id, draft.id);
        let stored = payload(conn, ITEM_TYPE, &draft.id);
        assert_eq!(stored["content"], json!("buy oat milk"));
        assert_eq!(stored["createdAt"], json!(created));
        assert_eq!(stored["modifiedAt"], json!(iso(NOW + 1)));
        assert_eq!(
            clock(conn, ITEM_TYPE, &draft.id),
            clock_of([("device-a", 2)])
        );

        let before = queued(conn, ITEM_TYPE, &draft.id);
        upsert(
            conn,
            Some(&draft.id),
            "buy oat milk",
            StickyKind::Task,
            DEVICE,
            NOW + 2,
        )?;
        assert_eq!(payload(conn, ITEM_TYPE, &draft.id), stored);
        assert_eq!(queued(conn, ITEM_TYPE, &draft.id), before);
        Ok(())
    })
    .expect("write");
}

#[test]
fn saving_into_a_draft_that_is_gone_keeps_the_text_in_a_new_draft() {
    let (db, _dir) = open("sticky-draft-gone");
    db.call_blocking(|conn| {
        let first = upsert(conn, None, "a", StickyKind::Note, DEVICE, NOW)?;
        assert!(delete(conn, &first.id, DEVICE, NOW + 1)?);
        assert!(!delete(conn, &first.id, DEVICE, NOW + 2)?, "already gone");
        assert!(list(conn)?.is_empty());

        let saved = upsert(
            conn,
            Some(&first.id),
            "late text",
            StickyKind::Journal,
            DEVICE,
            NOW + 3,
        )?;
        assert_ne!(saved.id, first.id);
        assert_eq!(
            (saved.content.as_str(), saved.kind),
            ("late text", StickyKind::Journal)
        );
        assert_eq!(ids(conn), [saved.id]);
        Ok(())
    })
    .expect("gone");
}

#[test]
fn drafts_list_most_recently_edited_first_and_an_unknown_kind_reads_as_note() {
    let (db, _dir) = open("sticky-draft-list");
    db.call_blocking(|conn| {
        let older = upsert(conn, None, "a", StickyKind::Note, DEVICE, NOW)?;
        let newer = upsert(conn, None, "b", StickyKind::Note, DEVICE, NOW + 1)?;
        assert_eq!(ids(conn), [newer.id.clone(), older.id.clone()]);

        let body = json!({"content": "c", "kind": "whiteboard", "clock": {"peer": 1}});
        assert_eq!(pull(conn, vec![remote(ITEM_TYPE, ID, &body)])?.applied, 1);
        assert_eq!(
            get(conn, ID)?.map(|draft| draft.kind),
            Some(StickyKind::Note)
        );
        assert_eq!(payload(conn, ITEM_TYPE, ID)["kind"], json!("whiteboard"));
        Ok(())
    })
    .expect("list");
}

#[test]
fn a_remote_create_needs_content_and_keeps_every_key_it_carried() {
    let (db, _dir) = open("sticky-draft-remote-create");
    db.call_blocking(|conn| {
        for body in [
            json!({"kind": "task", "clock": {"peer": 1}}),
            json!({"content": null, "kind": "task", "clock": {"peer": 1}}),
        ] {
            assert_eq!(pull(conn, vec![remote(ITEM_TYPE, ID, &body)])?.skipped, 1);
            assert!(sync_items::load(conn, ITEM_TYPE, ID)?.is_none(), "{body}");
        }

        let body = json!({
            "content": "hi", "kind": "task", "clock": {"peer": 1},
            "createdAt": iso(NOW), "modifiedAt": iso(NOW), "id": ID, "syncedAt": iso(NOW),
        });
        assert_eq!(pull(conn, vec![remote(ITEM_TYPE, ID, &body)])?.applied, 1);
        assert_eq!(
            sync_items::push_payload(conn, ITEM_TYPE, ID)?,
            Some(body.to_string())
        );
        assert_eq!(queued(conn, ITEM_TYPE, ID), 0, "an apply queues nothing");
        Ok(())
    })
    .expect("remote create");
}

#[test]
fn a_remote_update_keeps_the_local_content_kind_and_created_at_it_leaves_out() {
    let (db, _dir) = open("sticky-draft-remote-update");
    db.call_blocking(|conn| {
        let draft = upsert(conn, None, "mine", StickyKind::Task, DEVICE, NOW)?;
        let id = draft.id.as_str();

        let newer = json!({"content": null, "createdAt": iso(1),
                           "clock": {"device-a": 1, "peer": 1}});
        assert_eq!(pull(conn, vec![remote(ITEM_TYPE, id, &newer)])?.applied, 1);
        let stored = payload(conn, ITEM_TYPE, id);
        assert_eq!(stored["content"], json!("mine"), "null content keeps");
        assert_eq!(stored["kind"], json!("task"), "absent kind keeps");
        assert_eq!(
            stored["createdAt"],
            json!(iso(NOW)),
            "createdAt stays local"
        );
        assert_eq!(
            modified_at(conn, id),
            NOW + 10,
            "absent modifiedAt: apply time"
        );

        let kind = json!({"content": "theirs", "kind": null,
                          "clock": {"device-a": 1, "peer": 2}});
        assert_eq!(pull(conn, vec![remote(ITEM_TYPE, id, &kind)])?.applied, 1);
        let stored = payload(conn, ITEM_TYPE, id);
        assert_eq!(stored["content"], json!("theirs"));
        assert_eq!(stored["kind"], json!("task"), "null kind keeps");
        assert_eq!(queued(conn, ITEM_TYPE, id), 1, "an apply queues nothing");
        Ok(())
    })
    .expect("remote update");
}

#[test]
fn a_stale_remote_is_skipped_and_a_concurrent_one_wins_under_the_merged_clock() {
    let (db, _dir) = open("sticky-draft-remote-clock");
    db.call_blocking(|conn| {
        let draft = upsert(conn, None, "one", StickyKind::Note, DEVICE, NOW)?;
        let id = draft.id.as_str();
        upsert(conn, Some(id), "two", StickyKind::Note, DEVICE, NOW + 1)?;

        let stale = json!({"content": "zero", "clock": {"device-a": 1}});
        assert_eq!(pull(conn, vec![remote(ITEM_TYPE, id, &stale)])?.skipped, 1);
        assert_eq!(payload(conn, ITEM_TYPE, id)["content"], json!("two"));

        let concurrent = json!({"content": "peer", "clock": {"device-a": 1, "peer": 1}});
        assert_eq!(
            pull(conn, vec![remote(ITEM_TYPE, id, &concurrent)])?.applied,
            1
        );
        assert_eq!(payload(conn, ITEM_TYPE, id)["content"], json!("peer"));
        assert_eq!(
            clock(conn, ITEM_TYPE, id),
            clock_of([("device-a", 2), ("peer", 1)])
        );
        Ok(())
    })
    .expect("clocks");
}

#[test]
fn a_remote_delete_removes_the_draft_unless_the_local_clock_is_after_it() {
    let (db, _dir) = open("sticky-draft-remote-delete");
    db.call_blocking(|conn| {
        let kept = upsert(conn, None, "kept", StickyKind::Note, DEVICE, NOW)?;
        upsert(
            conn,
            Some(&kept.id),
            "kept 2",
            StickyKind::Note,
            DEVICE,
            NOW + 1,
        )?;
        let older = remote_delete(ITEM_TYPE, &kept.id, clock_of([("device-a", 1)]));
        assert_eq!(pull(conn, vec![older])?.skipped, 1);
        assert!(get(conn, &kept.id)?.is_some());

        let tombstone = clock_of([("device-a", 2), ("peer", 1)]);
        let newer = remote_delete(ITEM_TYPE, &kept.id, tombstone.clone());
        assert_eq!(pull(conn, vec![newer])?.deleted, 1);
        assert!(list(conn)?.is_empty());

        // A delete of a draft this device made after the peer's tombstone.
        let fresh = upsert(conn, None, "fresh", StickyKind::Note, DEVICE, NOW + 2)?;
        assert!(delete(conn, &fresh.id, DEVICE, NOW + 3)?);
        assert_eq!(
            compare(
                &clock(conn, ITEM_TYPE, &fresh.id),
                &clock_of([("device-a", 1)])
            ),
            ClockOrder::After,
            "a local delete ticks the clock"
        );
        Ok(())
    })
    .expect("delete");
}

#[test]
fn a_kind_this_build_does_not_know_parses_as_note() {
    assert_eq!(StickyKind::parse("task"), StickyKind::Task);
    assert_eq!(StickyKind::parse("journal"), StickyKind::Journal);
    assert_eq!(StickyKind::parse("note"), StickyKind::Note);
    assert_eq!(StickyKind::parse("whiteboard"), StickyKind::Note);
}
