//! Readers that ask whether a reminder fired (Step 21f3, #3538). Desktop's scheduler writes the
//! device-local `triggered` status and every reader below filters on it; the core never touches
//! the synced status and records the fire in `reminder_fires` instead, so each reader goes
//! through [`Reminder::is_fired`]:
//!
//! | Reader                                       | Desktop                                   |
//! | -------------------------------------------- | ----------------------------------------- |
//! | `note_date` calendar chip fades once fired   | `projection.ts` `loadNoteDateReminderItems` |
//! | a fired reminder leaves the calendar         | `projection.ts` `loadReminderItems`       |
//! | a fired reminder is not written to a provider, and the fire queues its push | `write-engine.ts` `shouldSourceBeOnCalendar`, `syncReminderCalendarState` |
//! | `active_only` drops a fired reminder         | `use-task-reminders.ts` `activeReminders` |

use std::collections::HashMap;

use memry_core::domain::calendar_items::projection::{self, ProjectionItem, RangeInput};
use memry_core::domain::calendar_items::providers::{self, Target};
use memry_core::domain::calendar_items::zone::FixedZone;
use memry_core::domain::reminders::{self, NewReminder, NewTarget, fire};
use memry_core::storage::repositories::instants;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::json;

const DEVICE: &str = "device-a";
const NOW: &str = "2026-03-20T08:00:00.000Z";
const AT: &str = "2026-03-20T09:00:00.000Z";

fn ms(iso: &str) -> i64 {
    instants::to_epoch_ms(iso).expect("an ISO instant")
}

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-reminder-readers-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn create(conn: &Connection, id: &'static str, target: NewTarget<'static>) {
    reminders::create_reminder(
        conn,
        &NewReminder {
            id: Some(id),
            target,
            remind_at: AT,
            title: Some("Call back"),
            note: None,
        },
        DEVICE,
        ms(NOW),
    )
    .expect("create")
    .acknowledge();
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

fn calendar_day(conn: &Connection) -> Vec<ProjectionItem> {
    let input = RangeInput {
        start_at: "2026-03-20T00:00:00.000Z".into(),
        end_at: "2026-03-21T00:00:00.000Z".into(),
        include_unselected_sources: false,
        include_completed_tasks: false,
        include_external: false,
        external_providers: None,
        enabled_property_names: vec![],
        show_notes_by_created: false,
        local_timezone: "UTC".into(),
    };
    projection::range(conn, &FixedZone(0), &input).expect("range")
}

fn chip<'a>(items: &'a [ProjectionItem], projection_id: &str) -> Option<&'a ProjectionItem> {
    items
        .iter()
        .find(|item| item.projection_id == projection_id)
}

#[test]
fn a_note_date_chip_fades_once_this_device_fired_it() {
    let db = open("note-date");
    db.call_blocking(|conn| {
        create(
            conn,
            "rem_pill",
            NewTarget::NoteDate {
                note_id: "note_1",
                anchor_id: "pill_1",
            },
        );
        let before = calendar_day(conn);
        assert_eq!(
            chip(&before, "note_date:rem_pill").and_then(|c| c.is_triggered),
            Some(false)
        );

        assert_eq!(tick(conn, ms(AT) + 1_000), ["rem_pill"]);
        let after = calendar_day(conn);
        let faded = chip(&after, "note_date:rem_pill").expect("the chip stays after its fire");
        assert_eq!(faded.is_triggered, Some(true));
        assert_eq!(faded.start_at, AT);
        Ok(())
    })
    .expect("note_date chip");
}

#[test]
fn a_note_date_chip_fired_at_its_snooze_fades_at_its_remind_at() {
    let db = open("note-date-snooze");
    db.call_blocking(|conn| {
        create(
            conn,
            "rem_pill",
            NewTarget::NoteDate {
                note_id: "note_1",
                anchor_id: "pill_1",
            },
        );
        assert_eq!(tick(conn, ms(AT) + 1_000), ["rem_pill"]);
        let until = "2026-03-20T10:00:00.000Z";
        reminders::snooze(conn, "rem_pill", until, DEVICE, ms(AT) + 2_000)?.acknowledge();
        let snoozed = calendar_day(conn);
        let pending = chip(&snoozed, "note_date:rem_pill").expect("the snoozed chip");
        assert_eq!(
            (pending.start_at.as_str(), pending.is_triggered),
            (until, Some(false))
        );

        // Desktop's fire sets `triggered`, which positions the chip by `remindAt` again.
        assert_eq!(tick(conn, ms(until) + 1_000), ["rem_pill"]);
        let fired = calendar_day(conn);
        let faded = chip(&fired, "note_date:rem_pill").expect("the fired chip");
        assert_eq!(
            (
                faded.start_at.as_str(),
                faded.is_triggered,
                faded.snooze_offset_minutes
            ),
            (AT, Some(true), None)
        );
        Ok(())
    })
    .expect("snoozed note_date chip");
}

#[test]
fn a_fired_reminder_leaves_the_calendar() {
    let db = open("calendar");
    db.call_blocking(|conn| {
        create(conn, "rem_note", NewTarget::Note("note_1"));
        assert!(chip(&calendar_day(conn), "reminder:rem_note").is_some());

        assert_eq!(tick(conn, ms(AT) + 1_000), ["rem_note"]);
        assert!(chip(&calendar_day(conn), "reminder:rem_note").is_none());
        Ok(())
    })
    .expect("reminder chip");
}

#[test]
fn a_fired_reminder_is_not_written_to_a_provider_and_its_fire_queues_the_push() {
    let db = open("provider");
    db.call_blocking(|conn| {
        create(conn, "rem_note", NewTarget::Note("note_1"));
        let target = Target {
            source_type: "reminder".into(),
            source_id: "rem_note".into(),
        };
        let input = |conn: &Connection| {
            providers::upsert_input(conn, &target, &FixedZone(0), "UTC", &HashMap::new())
        };
        assert!(input(conn)?.is_some());
        // The create queued it; the shell wrote it out.
        providers::dequeue(conn, &target)?;

        assert_eq!(tick(conn, ms(AT) + 1_000), ["rem_note"]);
        assert_eq!(input(conn)?, None, "a fired reminder is off the calendar");
        let queued: Vec<Target> = providers::queue(conn)?
            .into_iter()
            .map(|q| q.target)
            .collect();
        // The fire's inbox item queues its own `inbox_snooze` push beside it.
        assert!(
            queued.contains(&target),
            "the fire queues the push that takes it down: {queued:?}"
        );
        Ok(())
    })
    .expect("provider push");
}

fn seed_task(conn: &Connection, id: &str) {
    let payload = json!({
        "title": "Ship",
        "projectId": "inbox",
        "statusId": "inbox-todo",
        "position": 0,
        "clock": {"device-b": 1}
    });
    let outcome = sync_items::apply_remote(
        conn,
        &InboundRecord {
            item_type: "task".to_owned(),
            item_id: id.to_owned(),
            payload_json: payload.to_string(),
            server_cursor: Some(7),
            signer_device_id: Some("device-b".to_owned()),
            updated_at: ms(NOW),
            deleted_at: None,
        },
        ms(NOW),
    )
    .expect("apply");
    assert_eq!(outcome, sync_items::ApplyOutcome::Applied);
}

#[test]
fn active_task_reminders_drop_a_fired_one_and_list_it_again_once_rearmed() {
    let db = open("task");
    db.call_blocking(|conn| {
        seed_task(conn, "task_1");
        create(conn, "rem_task", NewTarget::Task("task_1"));
        let active = |conn: &Connection| -> Vec<String> {
            reminders::for_task(conn, "task_1", true)
                .expect("for_task")
                .into_iter()
                .map(|r| r.id)
                .collect()
        };
        assert_eq!(active(conn), ["rem_task"]);

        assert_eq!(tick(conn, ms(AT) + 1_000), ["rem_task"]);
        assert!(active(conn).is_empty(), "a fired reminder is not active");
        assert_eq!(reminders::for_task(conn, "task_1", false)?.len(), 1);

        let until = "2026-03-20T11:00:00.000Z";
        reminders::snooze(conn, "rem_task", until, DEVICE, ms(AT) + 2_000)?.acknowledge();
        assert_eq!(active(conn), ["rem_task"], "a snooze re-arms it");
        Ok(())
    })
    .expect("task reminders");
}
