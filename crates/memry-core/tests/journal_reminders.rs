//! Reminders on a journal day (spec 005 JP024, decision D8), against real
//! SQLite.
//!
//! Desktop is the reference: `hooks/use-journal-reminders.ts` for the payload
//! and the list, `use-set-or-replace-reminder.ts` for the one-per-day rule,
//! `main/lib/reminders.ts` for the writes and `resolveReminderTarget`.
//!
//! | Test                                                   | Rule                              |
//! | ------------------------------------------------------ | --------------------------------- |
//! | a create writes the date as target and no journal day  | D8, D2                            |
//! | a create refuses a bad date or a past time             | `CreateReminderSchema`, future    |
//! | set-or-replace creates, then moves the next active one | `useSetOrReplaceReminder`         |
//! | the day list orders by instant and marks active ones   | `useJournalReminders`             |
//! | id-based edits work on a journal reminder              | update / snooze / dismiss / delete|
//! | the due window carries the date as target and title    | `getDueReminders`, FR-061/062     |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::reminders::journal::{
    NewJournalReminder, create_for_journal, for_journal, set_or_replace_for_journal,
};
use memry_core::domain::reminders::{self, ReminderUpdate};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

/// 2025-10-09T08:53:20Z.
const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";
const DAY: &str = "2025-10-09";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-journal-reminders-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn seed_reminder(conn: &Connection, id: &str, payload: Value) {
    let mut full = json!({"targetType": "journal", "targetId": DAY, "clock": {"device-b": 1}});
    for (key, value) in payload.as_object().expect("an object") {
        full[key] = value.clone();
    }
    let outcome = sync_items::apply_remote(
        conn,
        &InboundRecord {
            item_type: "reminder".to_owned(),
            item_id: id.to_owned(),
            payload_json: serde_json::to_string(&full).expect("serialise"),
            server_cursor: Some(7),
            signer_device_id: Some("device-b".to_owned()),
            updated_at: NOW,
            deleted_at: None,
        },
        NOW,
    )
    .expect("apply");
    assert_eq!(outcome, sync_items::ApplyOutcome::Applied, "{id}");
}

fn payload_of(conn: &Connection, id: &str) -> Value {
    let raw = sync_items::push_payload(conn, "reminder", id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

fn outbox_ops(conn: &Connection, id: &str) -> Vec<String> {
    let mut statement = conn
        .prepare("SELECT op FROM outbox WHERE item_type = 'reminder' AND item_id = ?1 ORDER BY id")
        .expect("prepare");
    statement
        .query_map(params![id], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).expect("count")
}

fn ids(list: &[reminders::Reminder]) -> Vec<&str> {
    list.iter().map(|reminder| reminder.id.as_str()).collect()
}

#[test]
fn a_create_writes_the_date_as_target_and_never_creates_the_journal_day() {
    let db = open("create");
    db.call_blocking(|conn| {
        let id = create_for_journal(
            conn,
            &NewJournalReminder {
                id: None,
                date: DAY,
                remind_at: "2025-10-16T11:00:00+02:00",
                note: Some("look back"),
            },
            DEVICE,
            NOW,
        )?
        .acknowledge();
        assert!(id.starts_with("rem_"));

        assert_eq!(
            payload_of(conn, &id),
            json!({
                "targetType": "journal",
                "targetId": DAY,
                "remindAt": "2025-10-16T09:00:00.000Z",
                "anchorId": null,
                "highlightText": null,
                "highlightStart": null,
                "highlightEnd": null,
                "title": null,
                "note": "look back",
                "status": "pending",
                "dismissedAt": null,
                "snoozedUntil": null,
                "clock": {"device-a": 1},
                "createdAt": "2025-10-09T08:53:20.000Z",
                "modifiedAt": "2025-10-09T08:53:20.000Z",
            })
        );
        assert_eq!(outbox_ops(conn, &id), vec!["upsert"]);
        assert_eq!(count(conn, "SELECT count(*) FROM journal_entries"), 0);
        assert_eq!(count(conn, "SELECT count(*) FROM outbox"), 1);

        let empty_note = create_for_journal(
            conn,
            &NewJournalReminder {
                id: Some("rem_given"),
                date: DAY,
                remind_at: "2025-10-17T09:00:00.000Z",
                note: Some(""),
            },
            DEVICE,
            NOW,
        )?
        .acknowledge();
        assert_eq!(empty_note, "rem_given");
        assert_eq!(payload_of(conn, "rem_given")["note"], Value::Null);
        Ok(())
    })
    .expect("the create");
}

#[test]
fn a_create_refuses_a_bad_date_or_a_past_time_and_queues_nothing() {
    let db = open("refuse");
    db.call_blocking(|conn| {
        let base = NewJournalReminder {
            id: None,
            date: DAY,
            remind_at: "2025-10-16T09:00:00.000Z",
            note: None,
        };
        for bad in [
            NewJournalReminder {
                date: "2025-02-30",
                ..base
            },
            NewJournalReminder {
                date: "j2025-10-09",
                ..base
            },
            NewJournalReminder {
                remind_at: "2025-10-09T08:53:20.000Z",
                ..base
            },
            NewJournalReminder {
                remind_at: "next week",
                ..base
            },
            NewJournalReminder {
                id: Some(""),
                ..base
            },
        ] {
            assert!(
                create_for_journal(conn, &bad, DEVICE, NOW).is_err(),
                "{bad:?}"
            );
        }
        assert!(
            set_or_replace_for_journal(
                conn,
                "2025-13-01",
                "2025-10-16T09:00:00Z",
                None,
                DEVICE,
                NOW
            )
            .is_err()
        );
        assert_eq!(count(conn, "SELECT count(*) FROM outbox"), 0);
        assert_eq!(count(conn, "SELECT count(*) FROM reminders"), 0);
        Ok(())
    })
    .expect("the refusals");
}

#[test]
fn set_or_replace_creates_once_then_moves_the_next_active_reminder() {
    let db = open("replace");
    db.call_blocking(|conn| {
        let first = set_or_replace_for_journal(
            conn,
            DAY,
            "2025-10-16T09:00:00.000Z",
            Some("first"),
            DEVICE,
            NOW,
        )?;
        assert_eq!(payload_of(conn, &first)["note"], json!("first"));

        // A second time moves the same reminder; an absent note clears it.
        let moved = set_or_replace_for_journal(
            conn,
            DAY,
            "2025-11-09T09:00:00.000Z",
            None,
            DEVICE,
            NOW + 1,
        )?;
        assert_eq!(moved, first);
        let payload = payload_of(conn, &first);
        assert_eq!(payload["remindAt"], json!("2025-11-09T09:00:00.000Z"));
        assert_eq!(payload["note"], Value::Null);
        assert_eq!(payload["status"], json!("pending"));
        assert_eq!(for_journal(conn, DAY)?.len(), 1);
        assert_eq!(count(conn, "SELECT count(*) FROM journal_entries"), 0);

        // Several active ones written elsewhere: the earliest active is moved,
        // a dismissed one is never picked.
        reminders::dismiss(conn, &first, DEVICE, NOW + 2)?.acknowledge();
        seed_reminder(
            conn,
            "rem_late",
            json!({"remindAt": "2025-12-01T09:00:00.000Z", "status": "pending"}),
        );
        seed_reminder(
            conn,
            "rem_snoozed",
            json!({"remindAt": "2025-10-20T09:00:00.000Z", "status": "snoozed",
                   "snoozedUntil": "2025-10-21T09:00:00.000Z", "extra": 1}),
        );
        let moved = set_or_replace_for_journal(
            conn,
            DAY,
            "2026-01-09T09:00:00.000Z",
            Some("again"),
            DEVICE,
            NOW + 3,
        )?;
        assert_eq!(moved, "rem_snoozed");
        let payload = payload_of(conn, "rem_snoozed");
        assert_eq!(payload["status"], json!("pending"));
        assert_eq!(payload["snoozedUntil"], Value::Null);
        assert_eq!(payload["note"], json!("again"));
        assert_eq!(payload["extra"], json!(1));
        assert_eq!(payload_of(conn, &first)["status"], json!("dismissed"));
        assert_eq!(for_journal(conn, DAY)?.len(), 3);

        // A past time is refused on the move path too.
        assert!(
            set_or_replace_for_journal(conn, DAY, "2025-01-01T00:00:00Z", None, DEVICE, NOW)
                .is_err()
        );
        Ok(())
    })
    .expect("the set-or-replace");
}

#[test]
fn the_day_list_orders_by_instant_and_marks_active_reminders() {
    let db = open("list");
    db.call_blocking(|conn| {
        // Text order and instant order disagree: 10:00+05:00 is 05:00Z.
        seed_reminder(
            conn,
            "rem_offset",
            json!({"remindAt": "2025-10-20T10:00:00+05:00", "status": "pending"}),
        );
        seed_reminder(
            conn,
            "rem_utc",
            json!({"remindAt": "2025-10-20T06:00:00.000Z", "status": "dismissed"}),
        );
        seed_reminder(
            conn,
            "rem_other_day",
            json!({"targetId": "2025-10-10", "remindAt": "2025-10-19T06:00:00.000Z",
                   "status": "pending"}),
        );
        seed_reminder(
            conn,
            "rem_task",
            json!({"targetType": "task", "remindAt": "2025-10-19T06:00:00.000Z",
                   "status": "pending"}),
        );

        let list = for_journal(conn, DAY)?;
        assert_eq!(ids(&list), vec!["rem_offset", "rem_utc"]);
        assert_eq!(
            list.iter().map(|r| r.is_active()).collect::<Vec<_>>(),
            vec![true, false]
        );
        assert_eq!(list[0].target_type, "journal");
        assert_eq!(list[0].target_id, DAY);
        assert!(for_journal(conn, "2025/10/09").is_err());
        Ok(())
    })
    .expect("the list");
}

#[test]
fn id_based_edits_snooze_dismiss_and_delete_work_on_a_journal_reminder() {
    let db = open("edits");
    db.call_blocking(|conn| {
        let id =
            set_or_replace_for_journal(conn, DAY, "2025-10-16T09:00:00.000Z", None, DEVICE, NOW)?;
        let edit = ReminderUpdate {
            remind_at: Some("2025-10-18T09:00:00.000Z"),
            title: None,
            note: Some(Some("edited")),
        };
        reminders::update(conn, &id, &edit, DEVICE, NOW + 1)?.acknowledge();
        reminders::snooze(conn, &id, "2025-10-19T09:00:00.000Z", DEVICE, NOW + 2)?.acknowledge();
        let snoozed = &for_journal(conn, DAY)?[0];
        assert_eq!(snoozed.note.as_deref(), Some("edited"));
        assert_eq!(snoozed.status, "snoozed");
        assert_eq!(
            snoozed.snoozed_until.as_deref(),
            Some("2025-10-19T09:00:00.000Z")
        );
        assert!(snoozed.is_active());

        reminders::dismiss(conn, &id, DEVICE, NOW + 3)?.acknowledge();
        assert!(!for_journal(conn, DAY)?[0].is_active());
        reminders::delete(conn, &id, DEVICE, NOW + 4)?.acknowledge();
        assert!(for_journal(conn, DAY)?.is_empty());
        assert_eq!(count(conn, "SELECT count(*) FROM journal_entries"), 0);
        Ok(())
    })
    .expect("the edits");
}

#[test]
fn the_due_window_carries_the_date_as_target_and_title() {
    let db = open("due");
    db.call_blocking(|conn| {
        let id = create_for_journal(
            conn,
            &NewJournalReminder {
                id: None,
                date: DAY,
                remind_at: "2025-10-16T09:00:00.000Z",
                note: Some("look back"),
            },
            DEVICE,
            NOW,
        )?
        .acknowledge();

        let due = reminders::due_window(conn, None)?;
        assert_eq!(due.len(), 1);
        let entry = &due[0];
        assert_eq!(entry.reminder.id, id);
        assert_eq!(entry.reminder.target_type, "journal");
        assert_eq!(entry.reminder.target_id, DAY);
        assert_eq!(entry.reminder.note.as_deref(), Some("look back"));
        assert_eq!(entry.fire_at, "2025-10-16T09:00:00.000Z");
        assert_eq!(entry.target_title.as_deref(), Some(DAY));
        assert!(entry.target_exists);
        assert!(!entry.target_completed);

        // Outside the window it is not due yet.
        assert!(reminders::due_window(conn, Some(NOW))?.is_empty());
        Ok(())
    })
    .expect("the due window");
}
