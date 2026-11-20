//! Firing due reminders on this device (Step 21f, #3538), against real SQLite.
//!
//! Desktop is the reference: `processDueReminders`, `createReminderInboxItem`
//! and `countPendingReminders` in `apps/desktop/src/main/lib/reminders.ts`,
//! and the no-refire rule of `reminder-handler.ts` (`a4e8920c55`).

use std::sync::atomic::{AtomicUsize, Ordering};

use memry_core::domain::reminders::{self, fire};
use memry_core::storage::repositories::instants;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use serde_json::{Value, json};

const DEVICE: &str = "device-a";

fn ms(iso: &str) -> i64 {
    instants::to_epoch_ms(iso).expect("an ISO instant")
}

fn open_at(path: &std::path::Path) -> Db {
    open_data(path).expect("open data.db")
}

fn scratch(label: &str) -> std::path::PathBuf {
    tempfile::Builder::new()
        .prefix(&format!("memry-fire-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep()
        .join("data.db")
}

fn apply(conn: &Connection, id: &str, payload: Value, now_ms: i64) {
    let outcome = sync_items::apply_remote(
        conn,
        &InboundRecord {
            item_type: "reminder".to_owned(),
            item_id: id.to_owned(),
            payload_json: serde_json::to_string(&payload).expect("serialise"),
            server_cursor: Some(7),
            signer_device_id: Some("device-b".to_owned()),
            updated_at: now_ms,
            deleted_at: None,
        },
        now_ms,
    )
    .expect("apply");
    assert_eq!(outcome, sync_items::ApplyOutcome::Applied, "{id}");
}

fn seed(conn: &Connection, id: &str, remind_at: &str, extra: Value) {
    let mut payload = json!({
        "targetType": "journal",
        "targetId": "2026-03-29",
        "remindAt": remind_at,
        "status": "pending",
        "clock": {"device-b": 1},
    });
    for (key, value) in extra.as_object().expect("an object") {
        payload[key] = value.clone();
    }
    apply(conn, id, payload, ms("2026-01-01T00:00:00Z"));
}

fn due_ids(conn: &Connection, now_ms: i64) -> Vec<String> {
    fire::due(conn, now_ms)
        .expect("due")
        .into_iter()
        .map(|due| due.reminder.id)
        .collect()
}

/// Fires everything due at `now_ms`, as one scheduler tick does.
fn tick(conn: &Connection, now_ms: i64) -> Vec<fire::Fired> {
    fire::due(conn, now_ms)
        .expect("due")
        .iter()
        .filter_map(|due| fire::fire(conn, due, DEVICE, now_ms).expect("fire"))
        .collect()
}

fn inbox_payload(conn: &Connection, id: &str) -> Value {
    let raw = sync_items::push_payload(conn, "inbox", id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).expect("count")
}

#[test]
fn a_reminder_fires_at_its_time_once_and_files_one_inbox_item() {
    let db = open_at(&scratch("at-time"));
    db.call_blocking(|conn| {
        seed(
            conn,
            "rem_a",
            "2026-03-20T09:00:00.000Z",
            json!({"title": "Call Ada", "note": "about the draft"}),
        );
        let at = ms("2026-03-20T09:00:00Z");

        assert!(
            due_ids(conn, at - 1).is_empty(),
            "not due a millisecond early"
        );
        assert_eq!(fire::pending_count(conn)?, 1);

        let fired = tick(conn, at);
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].fired_for_ms, at);
        assert_eq!(fired[0].inbox_id, format!("inbox_rem_rem_a_{at}"));

        let item = inbox_payload(conn, &fired[0].inbox_id);
        assert_eq!(item["type"], "reminder");
        assert_eq!(item["title"], "Call Ada");
        assert_eq!(item["content"], "about the draft");
        assert_eq!(item["processingStatus"], "complete");
        assert_eq!(
            item["metadata"],
            json!({
                "reminderId": "rem_a",
                "targetType": "journal",
                "targetId": "2026-03-29",
                "targetTitle": "2026-03-29",
                "remindAt": "2026-03-20T09:00:00.000Z",
                "reminderNote": "about the draft",
            })
        );
        // The inbox item is clocked and queued like any capture, and the
        // reminder's synced status stays `pending`: `triggered` is never written.
        assert_eq!(item["clock"], json!({DEVICE: 1}));
        assert_eq!(item["createdAt"], "2026-03-20T09:00:00.000Z");
        assert_eq!(
            count(
                conn,
                "SELECT count(*) FROM outbox WHERE item_type = 'inbox'"
            ),
            1
        );
        assert_eq!(
            reminders::get(conn, "rem_a")?.map(|r| r.status),
            Some("pending".to_owned())
        );

        assert!(
            tick(conn, at + 60_000).is_empty(),
            "the next tick files nothing"
        );
        assert_eq!(fire::pending_count(conn)?, 0);
        assert_eq!(
            count(
                conn,
                "SELECT count(*) FROM sync_items WHERE item_type = 'inbox'"
            ),
            1
        );
        Ok(())
    })
    .expect("fire at time");
}

#[test]
fn reminders_missed_while_closed_fire_once_at_the_next_open() {
    let path = scratch("missed");
    open_at(&path)
        .call_blocking(|conn| {
            seed(conn, "rem_1", "2026-03-20T09:00:00.000Z", json!({}));
            seed(conn, "rem_2", "2026-03-20T10:00:00.000Z", json!({}));
            seed(conn, "rem_later", "2026-03-22T10:00:00.000Z", json!({}));
            Ok(())
        })
        .expect("seed");

    // The app was closed through both fire times; it opens a day later.
    let open = ms("2026-03-21T08:00:00Z");
    let fired = open_at(&path)
        .call_blocking(move |conn| Ok(tick(conn, open)))
        .expect("first open");
    let ids: Vec<_> = fired.iter().map(|f| f.reminder_id.as_str()).collect();
    assert_eq!(ids, ["rem_1", "rem_2"], "both overdue, earliest first");

    // Restart: nothing fires twice, and the future one is still pending.
    open_at(&path)
        .call_blocking(move |conn| {
            assert!(tick(conn, open + 60_000).is_empty());
            assert_eq!(fire::pending_count(conn)?, 1);
            assert_eq!(
                count(
                    conn,
                    "SELECT count(*) FROM sync_items WHERE item_type = 'inbox'"
                ),
                2
            );
            Ok(())
        })
        .expect("restart");
}

#[test]
fn a_snoozed_reminder_fires_again_at_its_snooze_time() {
    let db = open_at(&scratch("snooze"));
    db.call_blocking(|conn| {
        seed(conn, "rem_s", "2026-03-20T09:00:00.000Z", json!({}));
        let at = ms("2026-03-20T09:00:00Z");
        assert_eq!(tick(conn, at).len(), 1);

        let until = ms("2026-03-20T09:15:00Z");
        reminders::snooze(
            conn,
            "rem_s",
            "2026-03-20T09:15:00.000Z",
            DEVICE,
            at + 1_000,
        )?
        .acknowledge();
        assert_eq!(fire::pending_count(conn)?, 1, "snoozed counts as pending");
        assert!(tick(conn, until - 1).is_empty());

        let fired = tick(conn, until);
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].fired_for_ms, until);
        assert!(tick(conn, until + 60_000).is_empty());
        assert_eq!(fire::pending_count(conn)?, 0);
        Ok(())
    })
    .expect("snooze");
}

#[test]
fn a_dismissed_reminder_never_fires_and_leaves_the_count() {
    let db = open_at(&scratch("dismiss"));
    db.call_blocking(|conn| {
        seed(conn, "rem_d", "2026-03-20T09:00:00.000Z", json!({}));
        assert_eq!(fire::pending_count(conn)?, 1);
        reminders::dismiss(conn, "rem_d", DEVICE, ms("2026-03-20T08:00:00Z"))?.acknowledge();

        assert!(tick(conn, ms("2026-03-20T09:00:00Z")).is_empty());
        assert_eq!(fire::pending_count(conn)?, 0);
        Ok(())
    })
    .expect("dismiss");
}

#[test]
fn fire_instants_are_absolute_across_dst_and_timezone_changes() {
    let db = open_at(&scratch("dst"));
    db.call_blocking(|conn| {
        // 03:30 Berlin summer time on the day the clocks jump (02:00 -> 03:00):
        // 01:30Z, whatever the device's zone is now.
        seed(conn, "rem_dst", "2026-03-29T03:30:00+02:00", json!({}));
        let at = ms("2026-03-29T01:30:00Z");
        assert!(due_ids(conn, at - 1).is_empty());
        assert_eq!(tick(conn, at).len(), 1);

        // A peer in India rewrites the same moment in its own offset: same
        // instant, no second fire.
        apply(
            conn,
            "rem_dst",
            json!({
                "targetType": "journal",
                "targetId": "2026-03-29",
                "remindAt": "2026-03-29T07:00:00+05:30",
                "status": "pending",
                "clock": {"device-b": 2},
            }),
            at + 1_000,
        );
        assert!(tick(conn, at + 60_000).is_empty());
        assert_eq!(fire::pending_count(conn)?, 0);
        Ok(())
    })
    .expect("dst");
}

#[test]
fn a_peers_pending_copy_never_refires_but_a_new_time_does() {
    let path = scratch("no-refire");
    let at = ms("2026-03-20T09:00:00Z");
    open_at(&path)
        .call_blocking(move |conn| {
            seed(conn, "rem_p", "2026-03-20T09:00:00.000Z", json!({}));
            assert_eq!(tick(conn, at).len(), 1);
            Ok(())
        })
        .expect("first fire");

    open_at(&path)
        .call_blocking(move |conn| {
            // `triggered` never goes out, so the peer's copy reads `pending`.
            apply(
                conn,
                "rem_p",
                json!({
                    "targetType": "journal",
                    "targetId": "2026-03-29",
                    "remindAt": "2026-03-20T09:00:00.000Z",
                    "title": "renamed on the peer",
                    "status": "pending",
                    "clock": {"device-b": 2},
                }),
                at + 1_000,
            );
            assert!(tick(conn, at + 60_000).is_empty(), "no second inbox item");
            let due = reminders::due_window(conn, Some(at))?;
            assert_eq!(fire::fire(conn, &due[0], DEVICE, at + 60_000)?, None);

            // A reschedule on the peer is new user intent: it fires again.
            apply(
                conn,
                "rem_p",
                json!({
                    "targetType": "journal",
                    "targetId": "2026-03-29",
                    "remindAt": "2026-03-20T12:00:00.000Z",
                    "status": "pending",
                    "clock": {"device-b": 3},
                }),
                at + 2_000,
            );
            assert_eq!(fire::pending_count(conn)?, 1);
            assert_eq!(tick(conn, ms("2026-03-20T12:00:00Z")).len(), 1);
            assert_eq!(
                count(
                    conn,
                    "SELECT count(*) FROM sync_items WHERE item_type = 'inbox'"
                ),
                2
            );
            Ok(())
        })
        .expect("peer copy");
}

/// Review probe (REVIEW-5144 #2): fired at T, snoozed to S and fired again,
/// then an Electron peer that held `triggered` edits the title, and its
/// outbound copy turns `triggered` into `pending` with T and S. T was shown:
/// no third fire.
#[test]
fn a_peer_pending_copy_after_a_fired_snooze_never_refires_the_first_instant() {
    let db = open_at(&scratch("snooze-peer"));
    db.call_blocking(|conn| {
        seed(conn, "rem_ps", "2026-03-20T09:00:00.000Z", json!({}));
        let at = ms("2026-03-20T09:00:00Z");
        assert_eq!(tick(conn, at).len(), 1);
        reminders::snooze(
            conn,
            "rem_ps",
            "2026-03-20T09:15:00.000Z",
            DEVICE,
            at + 1_000,
        )?
        .acknowledge();
        let until = ms("2026-03-20T09:15:00Z");
        assert_eq!(tick(conn, until).len(), 1);

        apply(
            conn,
            "rem_ps",
            json!({
                "targetType": "journal",
                "targetId": "2026-03-29",
                "remindAt": "2026-03-20T09:00:00.000Z",
                "snoozedUntil": "2026-03-20T09:15:00.000Z",
                "title": "renamed on the peer",
                "status": "pending",
                "clock": {"device-a": 9, "device-b": 9},
            }),
            until + 1_000,
        );
        assert_eq!(
            reminders::get(conn, "rem_ps")?.map(|r| r.status),
            Some("pending".to_owned()),
            "the peer copy applied"
        );
        assert!(tick(conn, until + 60_000).is_empty(), "no refire");
        assert_eq!(fire::pending_count(conn)?, 0);
        assert_eq!(
            count(
                conn,
                "SELECT count(*) FROM sync_items WHERE item_type = 'inbox'"
            ),
            2
        );
        Ok(())
    })
    .expect("snooze then peer copy");
}

static TARGET_LOOKUPS: AtomicUsize = AtomicUsize::new(0);

fn count_target_lookups(event: TraceEvent<'_>) {
    if let TraceEvent::Stmt(_, sql) = event
        && sql.contains("FROM notes WHERE id = ?1")
    {
        TARGET_LOOKUPS.fetch_add(1, Ordering::SeqCst);
    }
}

/// A tick's cost does not grow with reminders already fired: they are dropped
/// before their target is looked up.
#[test]
fn a_tick_looks_up_no_target_of_an_already_fired_reminder() {
    let db = open_at(&scratch("fired-many"));
    db.call_blocking(|conn| {
        for n in 0..50 {
            seed(
                conn,
                &format!("rem_{n:02}"),
                "2026-03-20T09:00:00.000Z",
                json!({"targetType": "note", "targetId": format!("note_{n}")}),
            );
        }
        seed(conn, "rem_future", "2026-03-21T09:00:00.000Z", json!({}));
        let at = ms("2026-03-20T09:00:00Z");
        assert_eq!(tick(conn, at).len(), 50);

        conn.trace_v2(
            TraceEventCodes::SQLITE_TRACE_STMT,
            Some(count_target_lookups),
        );
        let fired = tick(conn, at + 60_000);
        conn.trace_v2(TraceEventCodes::empty(), None);
        assert!(fired.is_empty());
        assert_eq!(TARGET_LOOKUPS.load(Ordering::SeqCst), 0);
        Ok(())
    })
    .expect("many fired");
}
