//! One shared inbox item per reminder firing across devices (Step 21f, #3538;
//! Kaan, 20 Nov, option c), over real SQLite on several devices. A sync round
//! trip hands one device's stored row to another through the pull's apply path.

use memry_core::domain::inbox;
use memry_core::domain::reminders::fire;
use memry_core::storage::repositories::instants;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound;
use rusqlite::Connection;
use serde_json::{Value, json};

const REMINDER: &str = "rem_s";

fn ms(iso: &str) -> i64 {
    instants::to_epoch_ms(iso).expect("an ISO instant")
}

fn device(label: &str, remind_at: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-fire-sync-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    let db = open_data(&dir.join("data.db")).expect("open data.db");
    let payload = json!({
        "targetType": "journal",
        "targetId": "2026-03-20",
        "title": "Call Ada",
        "remindAt": remind_at,
        "status": "pending",
        "clock": {"device-c": 1},
    });
    db.call_blocking(move |conn| {
        sync_items::apply_remote(
            conn,
            &InboundRecord {
                item_type: "reminder".to_owned(),
                item_id: REMINDER.to_owned(),
                payload_json: payload.to_string(),
                server_cursor: Some(1),
                signer_device_id: Some("device-c".to_owned()),
                updated_at: 0,
                deleted_at: None,
            },
            0,
        )?;
        Ok(())
    })
    .expect("seed the reminder");
    db
}

/// One scheduler tick; the inbox ids it filed.
fn tick(db: &Db, now_ms: i64) -> Vec<String> {
    db.call_blocking(move |conn| {
        let mut fired = Vec::new();
        for due in fire::due(conn, now_ms)? {
            if let Some(done) = fire::fire(conn, &due, now_ms)? {
                fired.push(done.inbox_id);
            }
        }
        Ok(fired)
    })
    .expect("tick")
}

/// The device restarts with its fire records lost, so the same instant fires
/// again on it.
fn forget_fires(db: &Db) {
    db.call_blocking(|conn| {
        conn.execute("DELETE FROM reminder_fires", [])
            .expect("clear fires");
        Ok(())
    })
    .expect("forget fires");
}

fn row(conn: &Connection, id: &str) -> Option<(Value, Option<i64>)> {
    sync_items::load(conn, "inbox", id)
        .expect("load")
        .map(|row| {
            let payload = row.payload.expect("a payload");
            (
                serde_json::from_str(&payload).expect("JSON"),
                row.deleted_at,
            )
        })
}

fn stored(db: &Db, id: &str) -> Option<(Value, Option<i64>)> {
    let id = id.to_owned();
    db.call_blocking(move |conn| Ok(row(conn, &id)))
        .expect("read")
}

fn inbox_rows(db: &Db) -> i64 {
    db.call_blocking(|conn| {
        Ok(conn
            .query_row(
                "SELECT count(*) FROM sync_items WHERE item_type = 'inbox'",
                [],
                |row| row.get(0),
            )
            .expect("count"))
    })
    .expect("count")
}

/// `from`'s row arrives at `to` as a pulled record.
fn sync(from: &Db, to: &Db, id: &str, now_ms: i64) {
    let (payload, deleted_at) = stored(from, id).expect("the sender holds the item");
    let record = InboundRecord {
        item_type: "inbox".to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: Some(now_ms),
        signer_device_id: Some("peer".to_owned()),
        updated_at: now_ms,
        deleted_at,
    };
    to.call_blocking(move |conn| {
        apply_inbound(conn, &record, now_ms)?;
        Ok(())
    })
    .expect("apply");
}

#[test]
fn two_devices_firing_the_same_reminder_converge_on_one_item() {
    let at = ms("2026-03-20T09:00:00Z");
    let a = device("one-a", "2026-03-20T09:00:00.000Z");
    let b = device("one-b", "2026-03-20T09:00:00.000Z");
    let id = fire::inbox_id(REMINDER, at);

    // Each device fires on its own minute tick, at a different wall clock.
    assert_eq!(tick(&a, at + 5_000), [id.as_str()]);
    assert_eq!(tick(&b, at + 47_000), [id.as_str()]);

    // Both creates cross, then the re-queued union rows cross back.
    for round in 0..2 {
        sync(&a, &b, &id, at + 60_000 * (round + 1));
        sync(&b, &a, &id, at + 60_000 * (round + 1));
    }

    assert_eq!(inbox_rows(&a), 1);
    assert_eq!(inbox_rows(&b), 1);
    let (on_a, _) = stored(&a, &id).expect("on a");
    let (on_b, _) = stored(&b, &id).expect("on b");
    assert_eq!(on_a, on_b);
    assert_eq!(on_a["clock"], json!({fire::FIRE_ACTOR: 1}));
    assert_eq!(on_a["createdAt"], "2026-03-20T09:00:00.000Z");
}

#[test]
fn a_late_or_repeated_create_never_undoes_an_edit() {
    let at = ms("2026-03-20T09:00:00Z");
    let a = device("edit-a", "2026-03-20T09:00:00.000Z");
    let b = device("edit-b", "2026-03-20T09:00:00.000Z");
    let id = fire::inbox_id(REMINDER, at);

    tick(&a, at);
    let edit_id = id.clone();
    a.call_blocking(move |conn| {
        inbox::write::update(
            conn,
            &edit_id,
            Some("Call Ada today"),
            None,
            "device-a",
            at + 1,
        )?
        .acknowledge();
        Ok(())
    })
    .expect("edit");
    // B fired offline; its first create reaches A after A's edit.
    tick(&b, at + 30_000);
    sync(&b, &a, &id, at + 60_000);
    let (on_a, deleted) = stored(&a, &id).expect("on a");
    assert_eq!(on_a["title"], "Call Ada today");
    assert_eq!(deleted, None);

    sync(&a, &b, &id, at + 120_000);
    assert_eq!(stored(&b, &id).expect("on b").0["title"], "Call Ada today");

    // Firing the same instant again on either device keeps the edit.
    forget_fires(&a);
    forget_fires(&b);
    assert_eq!(tick(&a, at + 180_000), [id.as_str()]);
    assert_eq!(tick(&b, at + 180_000), [id.as_str()]);
    for db in [&a, &b] {
        assert_eq!(stored(db, &id).expect("item").0["title"], "Call Ada today");
        assert_eq!(inbox_rows(db), 1);
    }
}

fn edit_title(db: &Db, id: &str, title: &'static str, device_id: &'static str, now_ms: i64) {
    let id = id.to_owned();
    db.call_blocking(move |conn| {
        inbox::write::update(conn, &id, Some(title), None, device_id, now_ms)?.acknowledge();
        Ok(())
    })
    .expect("edit");
}

/// VERIFY-5144C's probe: a late create relayed through a third device that
/// never saw the edit reaches the offline editor and must not undo the edit.
#[test]
fn a_late_create_relayed_through_a_third_device_never_undoes_an_edit() {
    let at = ms("2026-03-20T09:00:00Z");
    let a = device("relay-a", "2026-03-20T09:00:00.000Z");
    let b = device("relay-b", "2026-03-20T09:00:00.000Z");
    let e = device("relay-e", "2026-03-20T09:00:00.000Z");
    let id = fire::inbox_id(REMINDER, at);

    tick(&a, at);
    sync(&a, &e, &id, at + 10_000);
    edit_title(&e, &id, "Call Ada today", "device-e", at + 20_000);
    // B was closed through the reminder and fires before its first pull.
    tick(&b, at + 30_000);
    sync(&b, &a, &id, at + 60_000);
    sync(&a, &e, &id, at + 120_000);
    assert_eq!(stored(&e, &id).expect("on e").0["title"], "Call Ada today");

    // The edit then reaches everyone.
    for peer in [&a, &b] {
        sync(&e, peer, &id, at + 180_000);
    }
    for db in [&a, &b, &e] {
        let (item, deleted) = stored(db, &id).expect("item");
        assert_eq!(item["title"], "Call Ada today");
        assert_eq!(deleted, None);
        assert_eq!(inbox_rows(db), 1);
    }
}

/// C holds A's edit when B's late create reaches it.
#[test]
fn a_late_create_arriving_after_the_edit_keeps_the_edit() {
    let at = ms("2026-03-20T09:00:00Z");
    let a = device("after-a", "2026-03-20T09:00:00.000Z");
    let b = device("after-b", "2026-03-20T09:00:00.000Z");
    let c = device("after-c", "2026-03-20T09:00:00.000Z");
    let id = fire::inbox_id(REMINDER, at);

    tick(&a, at);
    edit_title(&a, &id, "Call Ada today", "device-a", at + 1);
    sync(&a, &c, &id, at + 60_000);
    tick(&b, at + 30_000);
    sync(&b, &c, &id, at + 120_000);
    assert_eq!(stored(&c, &id).expect("on c").0["title"], "Call Ada today");
    sync(&c, &b, &id, at + 180_000);
    assert_eq!(stored(&b, &id).expect("on b").0["title"], "Call Ada today");
}

#[test]
fn a_late_or_repeated_create_never_brings_back_a_delete() {
    let at = ms("2026-03-20T09:00:00Z");
    let a = device("del-a", "2026-03-20T09:00:00.000Z");
    let b = device("del-b", "2026-03-20T09:00:00.000Z");
    let id = fire::inbox_id(REMINDER, at);

    tick(&a, at);
    let gone = id.clone();
    a.call_blocking(move |conn| {
        inbox::write::delete_permanent(conn, &gone, "device-a", at + 1)?.acknowledge();
        // The delete has been pushed: nothing queued keeps the tombstone.
        conn.execute("DELETE FROM outbox", [])
            .expect("ack the push");
        Ok(())
    })
    .expect("delete");
    tick(&b, at + 30_000);
    sync(&b, &a, &id, at + 60_000);
    assert!(stored(&a, &id).expect("the tombstone").1.is_some());

    sync(&a, &b, &id, at + 120_000);
    assert!(stored(&b, &id).expect("the tombstone").1.is_some());

    forget_fires(&a);
    forget_fires(&b);
    tick(&a, at + 180_000);
    tick(&b, at + 180_000);
    for db in [&a, &b] {
        assert!(stored(db, &id).expect("the tombstone").1.is_some());
        let live: i64 = db
            .call_blocking(|conn| {
                Ok(conn
                    .query_row(
                        "SELECT count(*) FROM inbox_items WHERE deleted_at IS NULL",
                        [],
                        |row| row.get(0),
                    )
                    .expect("count"))
            })
            .expect("count");
        assert_eq!(live, 0);
    }
}

#[test]
fn the_item_id_is_the_same_on_devices_in_different_time_zones() {
    // 03:30 Berlin and 07:00 Kolkata are the same moment, 01:30Z.
    let at = ms("2026-03-29T01:30:00Z");
    let berlin = device("tz-berlin", "2026-03-29T03:30:00+02:00");
    let kolkata = device("tz-kolkata", "2026-03-29T07:00:00+05:30");

    let expected = format!("inbox_rem_{REMINDER}_{at}");
    assert_eq!(tick(&berlin, at), [expected.as_str()]);
    assert_eq!(tick(&kolkata, at + 20_000), [expected.as_str()]);
    assert_eq!(
        stored(&berlin, &expected).expect("berlin").0["createdAt"],
        stored(&kolkata, &expected).expect("kolkata").0["createdAt"]
    );
}
