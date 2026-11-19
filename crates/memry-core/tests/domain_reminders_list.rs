//! The reminder writes and reads behind desktop's reminder commands (Step 21f2, #3538), against
//! real SQLite. Desktop is the reference: `createReminder`, `listReminders`, `dismissReminder`,
//! `snoozeReminder` and `deleteReminder` in `apps/desktop/src/main/lib/reminders.ts`, whose
//! scheduler writes the device-local `triggered` status and `triggeredAt` this core derives
//! from `reminder_fires`.

use memry_core::api::errors::StorageError;
use memry_core::domain::reminders::{
    self, ListFilter, NewReminder, NewTarget, Reminder, ReminderUpdate, fire,
};
use memry_core::storage::repositories::{instants, sync_items};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::Value;

const DEVICE: &str = "device-a";

fn ms(iso: &str) -> i64 {
    instants::to_epoch_ms(iso).expect("an ISO instant")
}

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-reminder-list-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn journal(id: &str, remind_at: &str) -> NewReminder<'static> {
    let (id, remind_at) = (leak(id), leak(remind_at));
    NewReminder {
        id: Some(id),
        target: NewTarget::Journal("2026-03-20"),
        remind_at,
        title: None,
        note: None,
    }
}

fn leak(text: &str) -> &'static str {
    Box::leak(text.to_owned().into_boxed_str())
}

fn create(conn: &Connection, reminder: &NewReminder<'_>, now_ms: i64) -> String {
    reminders::create_reminder(conn, reminder, DEVICE, now_ms)
        .expect("create")
        .acknowledge()
}

fn get(conn: &Connection, id: &str) -> Reminder {
    reminders::get(conn, id)
        .expect("get")
        .expect("a live reminder")
}

/// One scheduler tick at `now_ms`; the ids it fired.
fn tick(conn: &Connection, now_ms: i64) -> Vec<String> {
    fire::due(conn, now_ms)
        .expect("due")
        .iter()
        .filter_map(|due| fire::fire(conn, due, now_ms).expect("fire"))
        .map(|fired| fired.reminder_id)
        .collect()
}

fn payload(conn: &Connection, id: &str) -> Value {
    let row = sync_items::load(conn, "reminder", id)
        .expect("load")
        .expect("a row");
    serde_json::from_str(&row.payload.expect("a payload")).expect("JSON")
}

fn ids(page: &[Reminder]) -> Vec<&str> {
    page.iter().map(|reminder| reminder.id.as_str()).collect()
}

const NOW: &str = "2026-03-20T08:00:00.000Z";

#[test]
fn a_fired_reminder_reads_triggered_and_keeps_triggered_at_through_dismiss() {
    let db = open("dismiss");
    db.call_blocking(|conn| {
        create(conn, &journal("rem_a", "2026-03-20T09:00:00.000Z"), ms(NOW));
        let before = get(conn, "rem_a");
        assert_eq!(before.shown_status(), "pending");
        assert_eq!(before.triggered_at_ms, None);

        let at = ms("2026-03-20T09:00:30Z");
        assert_eq!(tick(conn, at), ["rem_a"]);
        let fired = get(conn, "rem_a");
        assert_eq!(fired.status, "pending", "the synced status is untouched");
        assert_eq!(fired.shown_status(), "triggered");
        assert_eq!(fired.triggered_at_ms, Some(at));
        assert_eq!(fire::pending_count(conn)?, 0);

        reminders::dismiss(conn, "rem_a", DEVICE, at + 1_000)?.acknowledge();
        let dismissed = get(conn, "rem_a");
        assert_eq!(dismissed.shown_status(), "dismissed");
        assert_eq!(
            dismissed.triggered_at_ms,
            Some(at),
            "desktop keeps triggeredAt"
        );
        assert!(tick(conn, at + 120_000).is_empty());
        Ok(())
    })
    .expect("scenario");
}

#[test]
fn a_snooze_after_a_fire_reads_snoozed_then_fires_again_and_a_new_time_rearms() {
    let db = open("snooze");
    db.call_blocking(|conn| {
        create(conn, &journal("rem_a", "2026-03-20T09:00:00.000Z"), ms(NOW));
        let first = ms("2026-03-20T09:00:10Z");
        assert_eq!(tick(conn, first), ["rem_a"]);

        reminders::snooze(conn, "rem_a", "2026-03-20T10:00:00Z", DEVICE, first + 1)?.acknowledge();
        let snoozed = get(conn, "rem_a");
        assert_eq!(snoozed.shown_status(), "snoozed");
        assert_eq!(
            snoozed.snoozed_until.as_deref(),
            Some("2026-03-20T10:00:00.000Z")
        );
        assert_eq!(
            snoozed.triggered_at_ms,
            Some(first),
            "kept through the snooze"
        );
        assert_eq!(fire::pending_count(conn)?, 1);

        let second = ms("2026-03-20T10:00:05Z");
        assert_eq!(tick(conn, second), ["rem_a"]);
        let refired = get(conn, "rem_a");
        assert_eq!(refired.shown_status(), "triggered");
        assert_eq!(refired.triggered_at_ms, Some(second));

        let edit = ReminderUpdate {
            remind_at: Some("2026-03-21T09:00:00Z"),
            ..ReminderUpdate::default()
        };
        reminders::update(conn, "rem_a", &edit, DEVICE, second + 1)?.acknowledge();
        let rearmed = get(conn, "rem_a");
        assert_eq!(rearmed.shown_status(), "pending");
        assert_eq!(rearmed.snoozed_until, None);
        assert_eq!(
            rearmed.triggered_at_ms, None,
            "a new time clears triggeredAt"
        );
        Ok(())
    })
    .expect("scenario");
}

#[test]
fn list_filters_on_the_shown_status_target_and_instant_bounds_then_pages() {
    let db = open("list");
    db.call_blocking(|conn| {
        let now = ms(NOW);
        create(conn, &journal("rem_c", "2026-03-20T09:00:00.000Z"), now);
        create(conn, &journal("rem_b", "2026-03-20T11:00:00+02:00"), now);
        create(conn, &journal("rem_a", "2026-03-22T09:00:00.000Z"), now);
        let task = NewReminder {
            target: NewTarget::Task("task-1"),
            ..journal("rem_t", "2026-03-23T09:00:00.000Z")
        };
        create(conn, &task, now);
        assert_eq!(tick(conn, ms("2026-03-20T09:00:01Z")), ["rem_b", "rem_c"]);

        let all = reminders::list(
            conn,
            &ListFilter {
                limit: 50,
                ..ListFilter::default()
            },
        )?;
        // Same instant (an offset is normalised on write): instant, then id.
        assert_eq!(ids(&all.reminders), ["rem_b", "rem_c", "rem_a", "rem_t"]);
        assert_eq!(all.total, 4);

        let statuses = ["triggered"];
        let fired = ListFilter {
            statuses: &statuses,
            limit: 50,
            ..ListFilter::default()
        };
        assert_eq!(
            ids(&reminders::list(conn, &fired)?.reminders),
            ["rem_b", "rem_c"]
        );
        let statuses = ["pending"];
        let pending = ListFilter {
            statuses: &statuses,
            limit: 50,
            ..ListFilter::default()
        };
        assert_eq!(
            ids(&reminders::list(conn, &pending)?.reminders),
            ["rem_a", "rem_t"]
        );

        let tasks = ListFilter {
            target_type: Some("task"),
            target_id: Some("task-1"),
            limit: 50,
            ..ListFilter::default()
        };
        assert_eq!(ids(&reminders::list(conn, &tasks)?.reminders), ["rem_t"]);

        let window = ListFilter {
            from_ms: Some(ms("2026-03-20T09:00:00Z")),
            to_ms: Some(ms("2026-03-22T09:00:00Z")),
            limit: 2,
            offset: 1,
            ..ListFilter::default()
        };
        let page = reminders::list(conn, &window)?;
        assert_eq!(
            ids(&page.reminders),
            ["rem_c", "rem_a"],
            "bounds are inclusive"
        );
        assert_eq!(page.total, 3);
        Ok(())
    })
    .expect("scenario");
}

#[test]
fn a_write_to_a_missing_or_deleted_reminder_is_not_found() {
    let db = open("not-found");
    db.call_blocking(|conn| {
        let now = ms(NOW);
        create(conn, &journal("rem_a", "2026-03-20T09:00:00.000Z"), now);
        reminders::delete(conn, "rem_a", DEVICE, now + 1)?.acknowledge();
        assert!(reminders::get(conn, "rem_a")?.is_none());

        for id in ["rem_a", "rem_missing"] {
            let not_found = |result: Result<(), StorageError>| {
                assert!(
                    matches!(result, Err(StorageError::NotFound { .. })),
                    "{id}: {result:?}"
                );
            };
            not_found(reminders::dismiss(conn, id, DEVICE, now + 2).map(|_| ()));
            not_found(
                reminders::snooze(conn, id, "2026-03-21T00:00:00Z", DEVICE, now + 2).map(|_| ()),
            );
            let edit = ReminderUpdate {
                title: Some(Some("x")),
                ..ReminderUpdate::default()
            };
            not_found(reminders::update(conn, id, &edit, DEVICE, now + 2).map(|_| ()));
            not_found(reminders::delete(conn, id, DEVICE, now + 2).map(|_| ()));
        }
        Ok(())
    })
    .expect("scenario");
}

#[test]
fn a_reminder_time_that_is_not_in_the_future_is_refused() {
    let db = open("past");
    db.call_blocking(|conn| {
        let now = ms(NOW);
        create(conn, &journal("rem_a", "2026-03-20T09:00:00.000Z"), now);
        let edit = ReminderUpdate {
            remind_at: Some("2026-03-20T07:59:59Z"),
            ..ReminderUpdate::default()
        };
        let refused = reminders::update(conn, "rem_a", &edit, DEVICE, now);
        assert!(matches!(refused, Err(StorageError::Invalid { .. })));
        let past = reminders::create_reminder(conn, &journal("rem_b", NOW), DEVICE, now);
        assert!(matches!(past, Err(StorageError::Invalid { .. })));
        assert_eq!(get(conn, "rem_a").shown_status(), "pending");
        Ok(())
    })
    .expect("scenario");
}

#[test]
fn a_delete_takes_the_reminders_fire_records_with_it() {
    let db = open("delete-fires");
    db.call_blocking(|conn| {
        let now = ms(NOW);
        create(conn, &journal("rem_a", "2026-03-20T09:00:00.000Z"), now);
        let at = ms("2026-03-20T09:00:01Z");
        assert_eq!(tick(conn, at), ["rem_a"]);
        let fires = |conn: &Connection| -> i64 {
            conn.query_row(
                "SELECT count(*) FROM reminder_fires WHERE reminder_id = 'rem_a'",
                [],
                |row| row.get(0),
            )
            .expect("count")
        };
        assert_eq!(fires(conn), 1);
        reminders::delete(conn, "rem_a", DEVICE, at + 1)?.acknowledge();
        assert_eq!(fires(conn), 0);
        Ok(())
    })
    .expect("scenario");
}

#[test]
fn highlight_and_note_date_reminders_carry_their_fields_and_are_checked() {
    let db = open("targets");
    db.call_blocking(|conn| {
        let now = ms(NOW);
        let highlight = NewReminder {
            target: NewTarget::Highlight {
                note_id: "n1",
                text: "a passage",
                start: 4,
                end: 13,
            },
            title: Some(""),
            ..journal("rem_h", "2026-03-21T09:00:00Z")
        };
        create(conn, &highlight, now);
        let pill = NewReminder {
            target: NewTarget::NoteDate {
                note_id: "n1",
                anchor_id: "anchor-1",
            },
            ..journal("rem_d", "2026-03-21T09:00:00Z")
        };
        create(conn, &pill, now);

        let h = payload(conn, "rem_h");
        assert_eq!(
            (&h["targetType"], &h["targetId"], &h["highlightText"]),
            (&"highlight".into(), &"n1".into(), &"a passage".into())
        );
        assert_eq!(
            (&h["highlightStart"], &h["highlightEnd"]),
            (&4.into(), &13.into())
        );
        assert_eq!((&h["title"], &h["anchorId"]), (&Value::Null, &Value::Null));
        assert_eq!(h["remindAt"], "2026-03-21T09:00:00.000Z");
        let d = payload(conn, "rem_d");
        assert_eq!(
            (&d["targetType"], &d["anchorId"]),
            (&"note_date".into(), &"anchor-1".into())
        );
        assert_eq!(d["highlightText"], Value::Null);
        assert_eq!(get(conn, "rem_d").anchor_id.as_deref(), Some("anchor-1"));

        let refused = [
            NewTarget::Highlight {
                note_id: "n1",
                text: "",
                start: 0,
                end: 0,
            },
            NewTarget::Highlight {
                note_id: "n1",
                text: "x",
                start: -1,
                end: 1,
            },
            NewTarget::Highlight {
                note_id: "n1",
                text: leak(&"a".repeat(5_001)),
                start: 0,
                end: 1,
            },
            NewTarget::NoteDate {
                note_id: "n1",
                anchor_id: "",
            },
            NewTarget::Note(""),
        ];
        for target in refused {
            let reminder = NewReminder {
                target,
                ..journal("rem_x", "2026-03-21T09:00:00Z")
            };
            let result = reminders::create_reminder(conn, &reminder, DEVICE, now);
            assert!(
                matches!(result, Err(StorageError::Invalid { .. })),
                "{target:?}"
            );
        }
        assert!(reminders::get(conn, "rem_x")?.is_none());
        Ok(())
    })
    .expect("scenario");
}
