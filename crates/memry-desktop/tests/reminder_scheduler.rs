//! The reminder scheduler (Step 21f, #3538) over a real `data.db`, with a fake clock and a
//! paused tokio clock. Desktop is the reference: `startReminderScheduler`,
//! `processDueReminders` and `showDesktopNotification` (`apps/desktop/src/main/lib/reminders.ts`).

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use memry_core::domain::reminders::{DueReminder, Reminder};
use memry_core::storage::repositories::instants;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_desktop::tasks::reminders::{
    self, ReminderScheduler, ReminderSink, TICK, TickReport, notice_text,
};
use serde_json::json;
use tokio::sync::mpsc;

const DEVICE: &str = "device-a";

fn ms(iso: &str) -> i64 {
    instants::to_epoch_ms(iso).expect("an ISO instant")
}

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-reminders-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn seed(db: &Db, id: &str, remind_at: &str) {
    let (id, remind_at) = (id.to_owned(), remind_at.to_owned());
    db.call_blocking(move |conn| {
        let payload = json!({
            "targetType": "journal",
            "targetId": "2026-03-20",
            "remindAt": remind_at,
            "status": "pending",
            "clock": {"device-b": 1},
        });
        sync_items::apply_remote(
            conn,
            &InboundRecord {
                item_type: "reminder".to_owned(),
                item_id: id,
                payload_json: payload.to_string(),
                server_cursor: Some(1),
                signer_device_id: Some("device-b".to_owned()),
                updated_at: 0,
                deleted_at: None,
            },
            0,
        )?;
        Ok(())
    })
    .expect("seed a reminder");
}

fn inbox_count(db: &Db) -> i64 {
    db.call_blocking(|conn| {
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

struct Channel(mpsc::UnboundedSender<TickReport>);

impl ReminderSink for Channel {
    fn report(&self, report: &TickReport) {
        let _ = self.0.send(report.clone());
    }
}

fn fired_ids(report: &TickReport) -> Vec<&str> {
    report
        .fired
        .iter()
        .map(|due| due.reminder.id.as_str())
        .collect()
}

#[tokio::test(start_paused = true)]
async fn the_scheduler_fires_missed_reminders_at_open_then_each_minute_and_never_twice() {
    let db = open("loop");
    seed(&db, "rem_missed", "2026-03-20T08:00:00.000Z");
    seed(&db, "rem_next", "2026-03-20T09:00:30.000Z");
    let now = Arc::new(AtomicI64::new(ms("2026-03-20T09:00:00Z")));
    let clock = now.clone();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let scheduler = ReminderScheduler::new(
        tokio::runtime::Handle::current(),
        Arc::new(Channel(tx)),
        Arc::new(move || clock.load(Ordering::SeqCst)),
    );

    // Open: the reminder missed while the app was closed fires at once, the badge counts one.
    scheduler.start(db.clone(), DEVICE.to_owned());
    let first = rx.recv().await.expect("the open tick");
    assert_eq!(fired_ids(&first), ["rem_missed"]);
    assert_eq!(first.pending, 1);

    // A minute later the next one is due.
    now.store(ms("2026-03-20T09:01:00Z"), Ordering::SeqCst);
    tokio::time::advance(TICK).await;
    let second = rx.recv().await.expect("the minute tick");
    assert_eq!(fired_ids(&second), ["rem_next"]);
    assert_eq!(second.pending, 0);

    // Closed: no tick runs.
    scheduler.stop();
    tokio::time::advance(TICK * 5).await;
    assert!(
        rx.try_recv().is_err(),
        "a stopped scheduler reports nothing"
    );

    // Restart: the open tick fires nothing again and sets the badge to zero.
    scheduler.start(db.clone(), DEVICE.to_owned());
    let reopened = rx.recv().await.expect("the open tick after a restart");
    assert!(reopened.fired.is_empty());
    assert_eq!(reopened.pending, 0);
    scheduler.stop();
    assert_eq!(inbox_count(&db), 2, "one inbox item per reminder");
}

#[test]
fn an_idle_tick_reports_zero_and_files_nothing() {
    let db = open("idle");
    let report = reminders::tick(&db, DEVICE, ms("2026-03-20T09:00:00Z")).expect("tick");
    assert_eq!(
        report,
        TickReport {
            fired: Vec::new(),
            pending: 0
        }
    );
    // A future reminder is pending but not due.
    seed(&db, "rem_future", "2026-03-21T09:00:00.000Z");
    let report = reminders::tick(&db, DEVICE, ms("2026-03-20T09:00:00Z")).expect("tick");
    assert!(report.fired.is_empty());
    assert_eq!(report.pending, 1);
    assert_eq!(inbox_count(&db), 0);
}

fn due(
    target_type: &str,
    title: Option<&str>,
    note: Option<&str>,
    highlight: Option<&str>,
) -> DueReminder {
    DueReminder {
        reminder: Reminder {
            id: "rem_x".to_owned(),
            target_type: target_type.to_owned(),
            target_id: "target".to_owned(),
            remind_at: "2026-03-20T09:00:00.000Z".to_owned(),
            title: title.map(str::to_owned),
            note: note.map(str::to_owned),
            highlight_text: highlight.map(str::to_owned),
            status: "pending".to_owned(),
            dismissed_at: None,
            snoozed_until: None,
        },
        fire_at: "2026-03-20T09:00:00.000Z".to_owned(),
        fire_at_ms: 0,
        target_title: None,
        target_exists: false,
        target_completed: false,
    }
}

#[test]
fn notification_text_follows_show_desktop_notification() {
    assert_eq!(
        notice_text(
            "en",
            &due("task", Some("Pay rent"), Some("before noon"), None)
        ),
        ("\u{1F514} Pay rent".to_owned(), "before noon".to_owned())
    );
    assert_eq!(
        notice_text("en", &due("task", None, None, None)),
        ("\u{1F514} Reminder".to_owned(), "Task reminder".to_owned())
    );
    assert_eq!(
        notice_text("en", &due("canvas", Some(""), Some(""), None)).1,
        "Reminder due"
    );
    let long = "x".repeat(120);
    assert_eq!(
        notice_text("en", &due("highlight", None, Some("ignored"), Some(&long))).1,
        format!("\"{}...\"", "x".repeat(100))
    );
    assert_eq!(
        notice_text("en", &due("highlight", None, None, Some("short"))).1,
        "\"short\""
    );
}

/// Two ticks racing on one database (a loop restarted while the old one still ran) file one
/// inbox item per reminder.
#[test]
fn two_ticks_at_the_same_instant_fire_once() {
    let db = open("race");
    seed(&db, "rem_once", "2026-03-20T08:00:00.000Z");
    let at = ms("2026-03-20T09:00:00Z");
    let results: Arc<Mutex<Vec<usize>>> = Arc::default();
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let (db, results) = (db.clone(), results.clone());
            std::thread::spawn(move || {
                let report = reminders::tick(&db, DEVICE, at).expect("tick");
                results.lock().expect("lock").push(report.fired.len());
            })
        })
        .collect();
    for thread in threads {
        thread.join().expect("join");
    }
    let total: usize = results.lock().expect("lock").iter().sum();
    assert_eq!(total, 1);
    assert_eq!(inbox_count(&db), 1);
}
