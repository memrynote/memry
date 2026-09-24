//! Reminders on a task (spec 004 TP024), against real SQLite.
//!
//! Desktop is the reference: `apps/desktop/src/main/lib/reminders.ts` for the
//! writes, `use-task-reminders.ts` for the task list, `getDueReminders` /
//! `resolveReminderTarget` for the due window.
//!
//! | Test                                                   | Rule                               |
//! | ------------------------------------------------------ | ---------------------------------- |
//! | a create writes desktop's whole row and one outbox row | `createReminder` + outbound shape  |
//! | a create refuses a past time, a missing task, a long   | `reminderTimeMustBeFuture`, zod    |
//! | title, and queues nothing                              |                                    |
//! | a reschedule re-pends and keeps unknown keys           | `updateReminder`, §13.2 rule 3     |
//! | delete is a tombstone with a delete row                | `deleteReminder`                   |
//! | the task list orders by instant; active drops dismissed| `activeReminders`                  |
//! | the due window resolves targets and fire times         | `getDueReminders`, FR-061/062      |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::reminders::{self, NewTaskReminder, ReminderUpdate};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

/// 2025-10-09T08:53:20Z.
const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-domain-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn apply(conn: &Connection, item_type: &str, item_id: &str, payload: Value, deleted: bool) {
    let outcome = sync_items::apply_remote(
        conn,
        &InboundRecord {
            item_type: item_type.to_owned(),
            item_id: item_id.to_owned(),
            payload_json: serde_json::to_string(&payload).expect("serialise"),
            server_cursor: Some(7),
            signer_device_id: Some("device-b".to_owned()),
            updated_at: NOW,
            deleted_at: deleted.then_some(NOW),
        },
        NOW,
    )
    .expect("apply");
    assert_eq!(outcome, sync_items::ApplyOutcome::Applied, "{item_id}");
}

fn seed_task(conn: &Connection, id: &str, title: &str, extra: Value, deleted: bool) {
    let mut payload = json!({
        "title": title,
        "projectId": "inbox",
        "statusId": "inbox-todo",
        "position": 0,
        "clock": {"device-b": 1}
    });
    for (key, value) in extra.as_object().expect("an object") {
        payload[key] = value.clone();
    }
    apply(conn, "task", id, payload, deleted);
}

fn seed_reminder(conn: &Connection, id: &str, payload: Value) {
    let mut full = json!({"status": "pending", "clock": {"device-b": 1}});
    for (key, value) in payload.as_object().expect("an object") {
        full[key] = value.clone();
    }
    apply(conn, "reminder", id, full, false);
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
        .collect::<Result<Vec<String>, _>>()
        .expect("rows")
}

fn new_reminder<'a>(id: Option<&'a str>, remind_at: &'a str) -> NewTaskReminder<'a> {
    NewTaskReminder {
        id,
        task_id: "task-1",
        remind_at,
        title: None,
        note: None,
    }
}

#[test]
fn a_create_writes_desktops_whole_row_payload_and_one_upsert_outbox_row() {
    let db = open("reminders-create");
    db.call_blocking(|conn| {
        let reminder = NewTaskReminder {
            title: Some(""),
            note: Some("bring the charger"),
            ..new_reminder(None, "2025-10-10T11:00:00+02:00")
        };
        let id = reminders::create_for_task(conn, &reminder, DEVICE, NOW)?.acknowledge();

        let tail = id.strip_prefix("rem_").expect("desktop's rem_ prefix");
        assert_eq!(tail.len(), 21, "a nanoid");

        assert_eq!(
            payload_of(conn, &id),
            json!({
                "targetType": "task",
                "targetId": "task-1",
                // Normalised to `toISOString` so text order is instant order.
                "remindAt": "2025-10-10T09:00:00.000Z",
                "anchorId": null,
                "highlightText": null,
                "highlightStart": null,
                "highlightEnd": null,
                // `input.title || null`: an empty title is a null.
                "title": null,
                "note": "bring the charger",
                "status": "pending",
                "dismissedAt": null,
                "snoozedUntil": null,
                "clock": {"device-a": 1},
                "createdAt": "2025-10-09T08:53:20.000Z",
                "modifiedAt": "2025-10-09T08:53:20.000Z",
            })
        );
        assert!(payload_of(conn, &id).get("triggeredAt").is_none());
        assert_eq!(outbox_ops(conn, &id), vec!["upsert"]);

        let listed = reminders::for_task(conn, "task-1", false)?;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id);
        assert_eq!(listed[0].note.as_deref(), Some("bring the charger"));
        assert_eq!(reminders::get(conn, &id)?, Some(listed[0].clone()));

        // A caller-supplied id is used verbatim.
        let given = reminders::create_for_task(
            conn,
            &new_reminder(Some("rem_given"), "2025-10-11T09:00:00.000Z"),
            DEVICE,
            NOW,
        )?
        .acknowledge();
        assert_eq!(given, "rem_given");
        Ok(())
    })
    .expect("the create");
}

#[test]
fn a_create_refuses_a_past_time_a_missing_task_and_a_long_title_and_queues_nothing() {
    let db = open("reminders-refuse");
    db.call_blocking(|conn| {
        let past = new_reminder(Some("rem_past"), "2025-10-09T08:53:20.000Z");
        assert!(reminders::create_for_task(conn, &past, DEVICE, NOW).is_err());

        let garbage = new_reminder(Some("rem_garbage"), "tomorrow at nine");
        assert!(reminders::create_for_task(conn, &garbage, DEVICE, NOW).is_err());

        let no_task = NewTaskReminder {
            task_id: "",
            ..new_reminder(Some("rem_no_task"), "2025-10-10T09:00:00.000Z")
        };
        assert!(reminders::create_for_task(conn, &no_task, DEVICE, NOW).is_err());

        let title = "x".repeat(201);
        let long = NewTaskReminder {
            title: Some(&title),
            ..new_reminder(Some("rem_long"), "2025-10-10T09:00:00.000Z")
        };
        assert!(reminders::create_for_task(conn, &long, DEVICE, NOW).is_err());

        let queued: i64 = conn
            .query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))
            .expect("count");
        assert_eq!(queued, 0);
        assert!(reminders::for_task(conn, "task-1", false)?.is_empty());
        Ok(())
    })
    .expect("the refusals");
}

#[test]
fn a_reschedule_re_pends_clears_the_snooze_ticks_the_clock_and_keeps_unknown_keys() {
    let db = open("reminders-update");
    db.call_blocking(|conn| {
        seed_reminder(
            conn,
            "rem_remote",
            json!({
                "targetType": "task",
                "targetId": "task-1",
                "remindAt": "2025-10-10T09:00:00.000Z",
                "title": "Old title",
                "note": "old note",
                "status": "snoozed",
                "snoozedUntil": "2025-10-10T10:00:00.000Z",
                "futureField": {"kept": true}
            }),
        );

        reminders::update(
            conn,
            "rem_remote",
            &ReminderUpdate {
                remind_at: Some("2025-10-12T09:30:00.000Z"),
                title: Some(None),
                note: Some(Some("new note")),
            },
            DEVICE,
            NOW,
        )?;

        let payload = payload_of(conn, "rem_remote");
        assert_eq!(payload["remindAt"], json!("2025-10-12T09:30:00.000Z"));
        assert_eq!(payload["status"], json!("pending"));
        // A clear is an explicit null (§13.4), never an absent key.
        assert_eq!(payload.get("snoozedUntil"), Some(&Value::Null));
        assert_eq!(payload.get("title"), Some(&Value::Null));
        assert_eq!(payload["note"], json!("new note"));
        assert_eq!(payload["futureField"], json!({"kept": true}));
        assert_eq!(payload["clock"], json!({"device-b": 1, "device-a": 1}));
        assert_eq!(payload["modifiedAt"], json!("2025-10-09T08:53:20.000Z"));
        assert_eq!(outbox_ops(conn, "rem_remote"), vec!["upsert"]);

        // A title-only edit leaves the time and status alone.
        reminders::update(
            conn,
            "rem_remote",
            &ReminderUpdate {
                title: Some(Some("Call back")),
                ..ReminderUpdate::default()
            },
            DEVICE,
            NOW + 1,
        )?;
        let payload = payload_of(conn, "rem_remote");
        assert_eq!(payload["title"], json!("Call back"));
        assert_eq!(payload["remindAt"], json!("2025-10-12T09:30:00.000Z"));
        assert_eq!(payload["clock"], json!({"device-b": 1, "device-a": 2}));

        // Rescheduling into the past is refused, as desktop refuses it.
        let past = ReminderUpdate {
            remind_at: Some("2025-10-01T09:00:00.000Z"),
            ..ReminderUpdate::default()
        };
        assert!(reminders::update(conn, "rem_remote", &past, DEVICE, NOW).is_err());
        assert!(reminders::update(conn, "rem_missing", &past, DEVICE, NOW).is_err());
        assert_eq!(outbox_ops(conn, "rem_remote"), vec!["upsert"]);
        assert!(outbox_ops(conn, "rem_missing").is_empty());
        Ok(())
    })
    .expect("the update");
}

#[test]
fn delete_is_a_tombstone_with_a_delete_row_and_a_deleted_reminder_takes_no_edit() {
    let db = open("reminders-delete");
    db.call_blocking(|conn| {
        let id = reminders::create_for_task(
            conn,
            &new_reminder(None, "2025-10-10T09:00:00.000Z"),
            DEVICE,
            NOW,
        )?
        .acknowledge();

        reminders::delete(conn, &id, DEVICE, NOW + 1)?;

        let (row_deleted, projected_deleted): (Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT s.deleted_at, r.deleted_at FROM sync_items s \
                 JOIN reminders r ON r.id = s.item_id \
                 WHERE s.item_type = 'reminder' AND s.item_id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the tombstone");
        assert_eq!(row_deleted, Some(NOW + 1));
        assert_eq!(projected_deleted, Some(NOW + 1));
        assert_eq!(payload_of(conn, &id)["clock"], json!({"device-a": 2}));
        // A record enqueue supersedes the row's earlier one: the delete is
        // what a push sends.
        assert_eq!(outbox_ops(conn, &id), vec!["delete"]);

        assert!(reminders::for_task(conn, "task-1", false)?.is_empty());
        assert_eq!(reminders::get(conn, &id)?, None);
        assert!(reminders::due_window(conn, None)?.is_empty());

        assert!(reminders::delete(conn, &id, DEVICE, NOW + 2).is_err());
        assert!(reminders::dismiss(conn, &id, DEVICE, NOW + 2).is_err());
        assert!(reminders::delete(conn, "rem_missing", DEVICE, NOW + 2).is_err());
        assert_eq!(outbox_ops(conn, &id), vec!["delete"]);
        Ok(())
    })
    .expect("the delete");
}

#[test]
fn the_task_list_orders_by_instant_and_active_only_drops_dismissed_reminders() {
    let db = open("reminders-list");
    db.call_blocking(|conn| {
        // Text order and instant order disagree: 10:00+05:00 is 05:00Z.
        seed_reminder(
            conn,
            "rem_offset",
            json!({"targetType": "task", "targetId": "task-1",
                   "remindAt": "2025-10-10T10:00:00+05:00"}),
        );
        seed_reminder(
            conn,
            "rem_utc",
            json!({"targetType": "task", "targetId": "task-1",
                   "remindAt": "2025-10-10T07:00:00.000Z"}),
        );
        seed_reminder(
            conn,
            "rem_other_task",
            json!({"targetType": "task", "targetId": "task-2",
                   "remindAt": "2025-10-10T06:00:00.000Z"}),
        );
        // Same target id, different target type: not this task's.
        seed_reminder(
            conn,
            "rem_note",
            json!({"targetType": "note", "targetId": "task-1",
                   "remindAt": "2025-10-10T06:00:00.000Z"}),
        );
        let late = reminders::create_for_task(
            conn,
            &new_reminder(None, "2025-10-11T09:00:00.000Z"),
            DEVICE,
            NOW,
        )?
        .acknowledge();

        reminders::dismiss(conn, "rem_utc", DEVICE, NOW)?;
        reminders::snooze(conn, &late, "2025-10-12T09:00:00.000Z", DEVICE, NOW)?;

        let all: Vec<String> = reminders::for_task(conn, "task-1", false)?
            .into_iter()
            .map(|reminder| reminder.id)
            .collect();
        assert_eq!(
            all,
            vec!["rem_offset".to_owned(), "rem_utc".to_owned(), late.clone()]
        );

        let active = reminders::for_task(conn, "task-1", true)?;
        let ids: Vec<&str> = active.iter().map(|reminder| reminder.id.as_str()).collect();
        assert_eq!(ids, vec!["rem_offset", late.as_str()]);
        assert_eq!(active[1].status, "snoozed");
        assert_eq!(
            active[1].snoozed_until.as_deref(),
            Some("2025-10-12T09:00:00.000Z")
        );

        let dismissed = payload_of(conn, "rem_utc");
        assert_eq!(dismissed["status"], json!("dismissed"));
        assert_eq!(dismissed["dismissedAt"], json!("2025-10-09T08:53:20.000Z"));
        Ok(())
    })
    .expect("the list");
}

#[test]
fn the_due_window_resolves_targets_and_orders_by_fire_time_including_overdue() {
    let db = open("reminders-due");
    db.call_blocking(|conn| {
        seed_task(conn, "task-open", "[agent] Open", json!({}), false);
        seed_task(
            conn,
            "task-done",
            "[agent] Done",
            json!({"completedAt": "2025-10-08T10:00:00.000Z"}),
            false,
        );
        seed_task(conn, "task-gone", "[agent] Gone", json!({}), true);
        apply(
            conn,
            "note",
            "note-1",
            json!({"title": "Groceries", "content": "", "fileType": "markdown",
                   "folderPath": null, "clock": {"device-b": 1}}),
            false,
        );

        let seeds = [
            (
                "rem_overdue",
                "task",
                "task-open",
                "2025-10-01T09:00:00.000Z",
                "pending",
                None,
            ),
            (
                "rem_done",
                "task",
                "task-done",
                "2025-10-10T09:00:00.000Z",
                "pending",
                None,
            ),
            (
                "rem_gone",
                "task",
                "task-gone",
                "2025-10-10T08:00:00.000Z",
                "pending",
                None,
            ),
            (
                "rem_note",
                "note",
                "note-1",
                "2025-10-10T07:00:00.000Z",
                "pending",
                None,
            ),
            (
                "rem_journal",
                "journal",
                "2025-10-10",
                "2025-10-10T06:00:00.000Z",
                "pending",
                None,
            ),
            // Snoozed: fires at `snoozedUntil`, not at its earlier `remindAt`.
            (
                "rem_snoozed",
                "task",
                "task-open",
                "2025-10-09T09:00:00.000Z",
                "snoozed",
                Some("2025-10-10T10:00:00.000Z"),
            ),
            (
                "rem_dismissed",
                "task",
                "task-open",
                "2025-10-10T05:00:00.000Z",
                "dismissed",
                None,
            ),
            (
                "rem_far",
                "task",
                "task-open",
                "2025-11-01T09:00:00.000Z",
                "pending",
                None,
            ),
            (
                "rem_unknown",
                "widget",
                "w-1",
                "2025-10-10T09:30:00.000Z",
                "pending",
                None,
            ),
        ];
        for (id, target_type, target_id, remind_at, status, snoozed_until) in seeds {
            seed_reminder(
                conn,
                id,
                json!({"targetType": target_type, "targetId": target_id,
                       "remindAt": remind_at, "status": status,
                       "snoozedUntil": snoozed_until}),
            );
        }

        // Through the end of 2025-10-10: `rem_far` is outside the window.
        let until = NOW + 2 * 86_400_000;
        let due = reminders::due_window(conn, Some(until))?;
        let order: Vec<&str> = due.iter().map(|due| due.reminder.id.as_str()).collect();
        assert_eq!(
            order,
            vec![
                "rem_overdue",
                "rem_journal",
                "rem_note",
                "rem_gone",
                "rem_done",
                "rem_unknown",
                "rem_snoozed",
            ]
        );

        let by_id = |id: &str| {
            due.iter()
                .find(|due| due.reminder.id == id)
                .expect("in the window")
                .clone()
        };
        let overdue = by_id("rem_overdue");
        assert_eq!(overdue.target_title.as_deref(), Some("[agent] Open"));
        assert!(overdue.target_exists && !overdue.target_completed);
        assert_eq!(overdue.fire_at, "2025-10-01T09:00:00.000Z");

        let done = by_id("rem_done");
        assert!(done.target_exists && done.target_completed);

        let gone = by_id("rem_gone");
        assert_eq!(gone.target_title, None);
        assert!(!gone.target_exists);

        let note = by_id("rem_note");
        assert_eq!(note.target_title.as_deref(), Some("Groceries"));
        assert!(note.target_exists);

        let journal = by_id("rem_journal");
        assert_eq!(journal.target_title.as_deref(), Some("2025-10-10"));
        assert!(journal.target_exists);

        let snoozed = by_id("rem_snoozed");
        assert_eq!(snoozed.fire_at, "2025-10-10T10:00:00.000Z");

        let unknown = by_id("rem_unknown");
        assert!(!unknown.target_exists);

        // No bound: every pending or snoozed reminder, dismissed still out.
        let everything = reminders::due_window(conn, None)?;
        assert_eq!(everything.len(), 8);
        assert_eq!(
            everything.last().map(|due| due.reminder.id.as_str()),
            Some("rem_far")
        );
        Ok(())
    })
    .expect("the due window");
}
