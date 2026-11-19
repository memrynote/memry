//! The reminder commands' service (Step 21f2, #3538) over a real `data.db`, with an explicit
//! clock. Electron is the reference: `ipc/reminder-handlers.ts` over `lib/reminders.ts`. The
//! inputs are built from JSON, as the renderer sends them.

use memry_core::storage::repositories::instants;
use memry_core::storage::{Db, open_data};
use memry_desktop::tasks::reminder_contract::{
    ReminderCreateInput, ReminderListInput, ReminderSnoozeInput, ReminderTargetInput,
    ReminderUpdateInput, ReminderView,
};
use memry_desktop::tasks::reminder_service::{ReminderError, ReminderService};
use memry_desktop::tasks::reminders;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

const DEVICE: &str = "device-a";
const NOW: &str = "2026-03-20T08:00:00.000Z";

fn ms(iso: &str) -> i64 {
    instants::to_epoch_ms(iso).expect("an ISO instant")
}

fn open(label: &str) -> (Db, ReminderService) {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-reminder-commands-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    let db = open_data(&dir.join("data.db")).expect("open data.db");
    let service = ReminderService::new(db.clone(), DEVICE.to_owned());
    (db, service)
}

fn input<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).expect("a renderer input")
}

fn journal_at(service: &ReminderService, remind_at: &str) -> ReminderView {
    let created = service
        .create(
            &input::<ReminderCreateInput>(json!({
                "targetType": "journal", "targetId": "2026-03-20", "remindAt": remind_at,
            })),
            ms(NOW),
        )
        .expect("create");
    created.value
}

fn fire_at(db: &Db, at: &str) -> Vec<String> {
    reminders::tick(db, ms(at))
        .expect("tick")
        .fired
        .into_iter()
        .map(|due| due.reminder.id)
        .collect()
}

fn inbox_count(db: &Db) -> i64 {
    db.read_blocking(|conn| {
        Ok(conn
            .query_row(
                "SELECT count(*) FROM sync_items WHERE item_type = 'inbox'",
                [],
                |row| row.get(0),
            )
            .expect("count"))
    })
    .expect("count inbox items")
}

#[test]
fn create_answers_the_reminder_and_the_badge_and_refuses_what_electron_refuses() {
    let (_db, service) = open("create");
    let created = service
        .create(
            &input(json!({
                "targetType": "highlight", "targetId": "note-1",
                "remindAt": "2026-03-21T11:00:00+02:00", "title": "",
                "highlightText": "a passage", "highlightStart": 2, "highlightEnd": 11,
            })),
            ms(NOW),
        )
        .expect("create");
    let view = &created.value;
    assert!(view.id.starts_with("rem_"), "{}", view.id);
    assert_eq!(
        (view.target_type.as_str(), view.status.as_str()),
        ("highlight", "pending")
    );
    assert_eq!(view.remind_at, "2026-03-21T09:00:00.000Z");
    assert_eq!(view.highlight_text.as_deref(), Some("a passage"));
    assert_eq!(
        (view.title.clone(), view.triggered_at.clone()),
        (None, None)
    );
    assert_eq!(view.created_at, NOW);
    assert_eq!(created.pending, 1);

    let past = json!({"targetType": "journal", "targetId": "2026-03-20", "remindAt": NOW});
    assert!(matches!(
        service.create(&input(past), ms(NOW)),
        Err(ReminderError::RemindAtPast)
    ));
    let no_anchor = json!({
        "targetType": "note_date", "targetId": "note-1", "remindAt": "2026-03-21T09:00:00Z",
    });
    assert!(matches!(
        service.create(&input(no_anchor), ms(NOW)),
        Err(ReminderError::Invalid(_))
    ));
    assert_eq!(service.count_pending().expect("count"), 1);
}

#[test]
fn update_reschedules_a_fired_reminder_and_edits_title_and_note() {
    let (db, service) = open("update");
    let id = journal_at(&service, "2026-03-20T09:00:00.000Z").id;
    assert_eq!(fire_at(&db, "2026-03-20T09:00:01Z"), [id.as_str()]);

    let edited = service
        .update(
            &input::<ReminderUpdateInput>(
                json!({"id": id, "remindAt": "2026-03-21T09:00:00Z", "title": "Call"}),
            ),
            ms("2026-03-20T09:01:00Z"),
        )
        .expect("update");
    assert_eq!(edited.value.status, "pending");
    assert_eq!(edited.value.triggered_at, None);
    assert_eq!(edited.value.title.as_deref(), Some("Call"));
    assert_eq!(edited.pending, 1);

    let cleared = service
        .update(
            &input(json!({"id": id, "title": null})),
            ms("2026-03-20T09:02:00Z"),
        )
        .expect("clear the title");
    assert_eq!(cleared.value.title, None);
    assert_eq!(cleared.value.remind_at, "2026-03-21T09:00:00.000Z");

    let past = json!({"id": id, "remindAt": "2026-03-20T09:00:00Z"});
    assert!(matches!(
        service.update(&input(past), ms("2026-03-20T09:03:00Z")),
        Err(ReminderError::RemindAtPast)
    ));
    let missing = json!({"id": "rem_missing", "title": "x"});
    assert!(matches!(
        service.update(&input(missing), ms(NOW)),
        Err(ReminderError::NotFound)
    ));
}

#[test]
fn dismissing_a_fired_reminder_takes_it_out_of_due_and_the_badge() {
    let (db, service) = open("dismiss");
    let id = journal_at(&service, "2026-03-20T09:00:00.000Z").id;
    let at = "2026-03-20T09:00:01Z";
    assert_eq!(service.due(ms(at)).expect("due").len(), 1);
    assert_eq!(fire_at(&db, at), [id.as_str()]);
    assert!(service.due(ms(at)).expect("due").is_empty());
    let fired = service.get(&id).expect("get").expect("the reminder");
    assert_eq!(fired.reminder.status, "triggered");
    assert_eq!(fired.target_title.as_deref(), Some("2026-03-20"));

    let dismissed = service
        .dismiss(&id, ms("2026-03-20T09:00:02Z"))
        .expect("dismiss");
    assert_eq!(dismissed.value.status, "dismissed");
    assert_eq!(
        dismissed.value.triggered_at.as_deref(),
        Some("2026-03-20T09:00:01.000Z")
    );
    assert_eq!(dismissed.pending, 0);
    assert!(fire_at(&db, "2026-03-20T10:00:00Z").is_empty());
}

#[test]
fn snoozing_a_fired_reminder_fires_it_again_at_the_snooze_time() {
    let (db, service) = open("snooze");
    let id = journal_at(&service, "2026-03-20T09:00:00.000Z").id;
    assert_eq!(fire_at(&db, "2026-03-20T09:00:01Z"), [id.as_str()]);
    assert_eq!(service.count_pending().expect("count"), 0);

    let past: ReminderSnoozeInput = input(json!({"id": id, "snoozeUntil": "2026-03-20T09:00:00Z"}));
    assert!(matches!(
        service.snooze(&past, ms("2026-03-20T09:00:02Z")),
        Err(ReminderError::SnoozePast)
    ));
    let snoozed = service
        .snooze(
            &input(json!({"id": id, "snoozeUntil": "2026-03-20T09:15:00Z"})),
            ms("2026-03-20T09:00:02Z"),
        )
        .expect("snooze");
    assert_eq!(snoozed.value.status, "snoozed");
    assert_eq!(
        snoozed.value.snoozed_until.as_deref(),
        Some("2026-03-20T09:15:00.000Z")
    );
    assert_eq!(snoozed.pending, 1);
    assert!(fire_at(&db, "2026-03-20T09:14:59Z").is_empty());
    assert_eq!(fire_at(&db, "2026-03-20T09:15:00Z"), [id.as_str()]);
    assert_eq!(inbox_count(&db), 2);
}

#[test]
fn a_deleted_reminder_answers_not_found_to_every_write_and_none_to_get() {
    let (_db, service) = open("delete");
    let id = journal_at(&service, "2026-03-20T09:00:00.000Z").id;
    let deleted = service.delete(&id, ms(NOW)).expect("delete");
    assert_eq!(
        (
            deleted.value.id.as_str(),
            deleted.value.target_type.as_str()
        ),
        (id.as_str(), "journal")
    );
    assert_eq!(deleted.pending, 0);

    assert!(service.get(&id).expect("get").is_none());
    let later = ms("2026-03-20T08:30:00Z");
    assert!(matches!(
        service.delete(&id, later),
        Err(ReminderError::NotFound)
    ));
    assert!(matches!(
        service.dismiss(&id, later),
        Err(ReminderError::NotFound)
    ));
    let snooze = json!({"id": id, "snoozeUntil": "2026-03-21T00:00:00Z"});
    assert!(matches!(
        service.snooze(&input(snooze), later),
        Err(ReminderError::NotFound)
    ));
}

#[test]
fn bulk_dismiss_skips_unknown_ids_and_refuses_an_empty_batch() {
    let (_db, service) = open("bulk");
    let a = journal_at(&service, "2026-03-20T09:00:00.000Z").id;
    let b = journal_at(&service, "2026-03-20T10:00:00.000Z").id;
    journal_at(&service, "2026-03-20T11:00:00.000Z");

    let done = service.bulk_dismiss(&[a.clone(), "rem_missing".to_owned(), b.clone()], ms(NOW));
    assert!(done.failure.is_none(), "{:?}", done.failure);
    let ids: Vec<&str> = done.dismissed.iter().map(|view| view.id.as_str()).collect();
    assert_eq!(ids, [a.as_str(), b.as_str()]);
    assert_eq!(done.pending, 1);

    for ids in [Vec::new(), vec![String::new()]] {
        let refused = service.bulk_dismiss(&ids, ms(NOW));
        assert!(matches!(refused.failure, Some(ReminderError::Invalid(_))));
        assert!(refused.dismissed.is_empty());
    }
}

#[test]
fn list_upcoming_and_for_target_answer_electrons_queries() {
    let (db, service) = open("queries");
    let early = journal_at(&service, "2026-03-20T09:00:00.000Z").id;
    let late = journal_at(&service, "2026-03-25T09:00:00.000Z").id;
    let far = journal_at(&service, "2026-06-01T09:00:00.000Z").id;
    assert_eq!(fire_at(&db, "2026-03-20T09:00:01Z"), [early.as_str()]);

    let triggered = service
        .list(&input::<ReminderListInput>(json!({"status": "triggered"})))
        .expect("list");
    let ids: Vec<&str> = triggered
        .reminders
        .iter()
        .map(|item| item.reminder.id.as_str())
        .collect();
    assert_eq!(ids, [early.as_str()]);

    let page = service
        .list(&input(
            json!({"status": ["pending", "triggered"], "limit": 2, "offset": 0}),
        ))
        .expect("page");
    assert_eq!(
        (page.total, page.has_more, page.reminders.len()),
        (3, true, 2)
    );
    for limit in [0, 201] {
        assert!(matches!(
            service.list(&input(json!({"limit": limit}))),
            Err(ReminderError::Invalid(_))
        ));
    }

    let week = service
        .upcoming(None, ms("2026-03-20T09:00:01Z"))
        .expect("upcoming");
    let ids: Vec<&str> = week
        .reminders
        .iter()
        .map(|item| item.reminder.id.as_str())
        .collect();
    assert_eq!(ids, [late.as_str()], "a fired reminder is not upcoming");
    let year = service
        .upcoming(Some(365), ms("2026-03-20T09:00:01Z"))
        .expect("upcoming");
    assert_eq!(year.total, 2);
    assert!(year.reminders.iter().any(|item| item.reminder.id == far));
    for days in [0, 366] {
        assert!(matches!(
            service.upcoming(Some(days), ms(NOW)),
            Err(ReminderError::Invalid(_))
        ));
    }

    let target: ReminderTargetInput =
        input(json!({"targetType": "journal", "targetId": "2026-03-20"}));
    let all = service.for_target(&target).expect("for target");
    let ids: Vec<&str> = all.iter().map(|view| view.id.as_str()).collect();
    assert_eq!(ids, [early.as_str(), late.as_str(), far.as_str()]);
    assert_eq!(all[0].status, "triggered");
    let empty: ReminderTargetInput = input(json!({"targetType": "journal", "targetId": ""}));
    assert!(matches!(
        service.for_target(&empty),
        Err(ReminderError::Invalid(_))
    ));
}

/// A dismiss and a scheduler tick on two threads over one vault: the writer connection orders
/// them, so the reminder fires at most once and stays dismissed whichever lands first.
#[test]
fn a_dismiss_racing_a_tick_fires_at_most_once_and_stays_dismissed() {
    let (db, service) = open("race");
    let service = std::sync::Arc::new(service);
    for round in 0..20 {
        let id = journal_at(&service, "2026-03-20T09:00:00.000Z").id;
        let before = inbox_count(&db);
        let at = ms("2026-03-20T09:00:01Z") + round;
        let ticker = {
            let db = db.clone();
            std::thread::spawn(move || reminders::tick(&db, at).expect("tick"))
        };
        let dismisser = {
            let (service, id) = (service.clone(), id.clone());
            std::thread::spawn(move || service.dismiss(&id, at).expect("dismiss"))
        };
        ticker.join().expect("the tick thread");
        dismisser.join().expect("the dismiss thread");

        assert!(inbox_count(&db) - before <= 1, "round {round}");
        let after = service.get(&id).expect("get").expect("the reminder");
        assert_eq!(after.reminder.status, "dismissed", "round {round}");
        assert!(
            fire_at(&db, "2026-03-20T12:00:00Z").is_empty(),
            "round {round}"
        );
    }
}
