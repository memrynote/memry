//! The inbox review nudge against a real session and vault, with a recording outlet in place of
//! the OS notification: once per local day at the set minute, again the same day after the
//! schedule changes through the settings service, the test notification shown exactly once, and
//! the scheduler's cadence on a paused clock.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::NaiveDate;
use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, OpenVault, Session};
use memry_desktop::settings::SettingsService;
use memry_desktop::shell::inbox_review::{
    self, InboxReview, LocalMinute, ReviewNotice, ReviewOutlet,
};
use memry_desktop::shell::power::PowerEvent;
use serde_json::{Map, Value, json};
use tokio::sync::{broadcast, mpsc};

#[derive(Default)]
struct MemoryStore(Mutex<HashMap<SecureStoreKey, Vec<u8>>>);

impl SecureStore for MemoryStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        Ok(self.0.lock().unwrap().get(&key).cloned())
    }

    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().insert(key, value);
        Ok(())
    }

    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().remove(&key);
        Ok(())
    }

    fn clear(&self) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().clear();
        Ok(())
    }
}

/// The shell's notification and renderer event, recorded.
#[derive(Default)]
struct Recorder {
    shown: Mutex<Vec<ReviewNotice>>,
    due: Mutex<Vec<i64>>,
    unsupported: AtomicBool,
}

impl ReviewOutlet for Recorder {
    fn locale(&self) -> String {
        "en".to_owned()
    }

    fn supported(&self) -> bool {
        !self.unsupported.load(Ordering::SeqCst)
    }

    fn show(&self, notice: ReviewNotice) {
        self.shown.lock().unwrap().push(notice);
    }

    fn due(&self, count: i64) {
        self.due.lock().unwrap().push(count);
    }
}

impl Recorder {
    fn shown(&self) -> Vec<ReviewNotice> {
        self.shown.lock().unwrap().clone()
    }

    fn due(&self) -> Vec<i64> {
        self.due.lock().unwrap().clone()
    }
}

struct World {
    dir: tempfile::TempDir,
    session: Session,
    store: Arc<dyn SecureStore>,
    settings: SettingsService,
    outlet: Arc<Recorder>,
    review: InboxReview,
}

fn world() -> World {
    let dir = tempfile::tempdir().expect("tmp");
    let app = dir.path().join("app");
    std::fs::create_dir_all(&app).expect("app dir");
    let config = Arc::new(AppConfig::load(app.join("memry-config.json")));
    let session = Session::new(VaultRegistry::new(config.clone()));
    let store: Arc<dyn SecureStore> = Arc::new(MemoryStore::default());
    // A profile that captured or changed a setting has its device key.
    ensure_device_identity(store.clone()).expect("device key");
    let settings = SettingsService::new(store.clone(), config);
    let outlet = Arc::new(Recorder::default());
    let review = InboxReview::new(session.clone(), store.clone(), outlet.clone());
    World {
        dir,
        session,
        store,
        settings,
        outlet,
        review,
    }
}

impl World {
    fn open(&self) -> OpenVault {
        let path = self.dir.path().join("vault");
        std::fs::create_dir_all(&path).expect("vault dir");
        self.session
            .open(&path, OpenSource::Select)
            .expect("open")
            .vault
    }

    /// The renderer's write: `settings_set_group("inbox", ...)`.
    fn schedule(&self, vault: &OpenVault, patch: Value) {
        let patch: Map<String, Value> = patch.as_object().cloned().expect("object");
        self.settings
            .write_group(Some(vault), "inbox", patch)
            .expect("write the schedule");
    }

    fn capture(&self, vault: &OpenVault, content: &str) {
        vault
            .vault
            .inbox(self.store.clone())
            .expect("inbox")
            .capture_text(content.to_owned(), None, None, false)
            .expect("capture");
    }

    fn tick(&self, day: u32, hour: u32, minute: u32) -> Option<i64> {
        self.review.tick(&at(day, hour, minute))
    }
}

fn at(day: u32, hour: u32, minute: u32) -> LocalMinute {
    LocalMinute::of(
        NaiveDate::from_ymd_opt(2026, 11, day)
            .expect("date")
            .and_hms_opt(hour, minute, 0)
            .expect("time"),
    )
}

#[test]
fn the_local_minute_is_the_local_date_and_the_minute_of_the_day() {
    assert_eq!(
        at(3, 9, 5),
        LocalMinute {
            date: "2026-11-03".to_owned(),
            minutes: 9 * 60 + 5,
        }
    );
}

#[test]
fn the_nudge_fires_once_per_local_day_at_the_set_minute() {
    let w = world();
    assert_eq!(w.tick(18, 9, 30), None, "no vault is open");
    let vault = w.open();
    w.capture(&vault, "something to review");
    w.capture(&vault, "something else");
    assert_eq!(w.tick(18, 9, 30), None, "the reminder is off by default");
    w.schedule(
        &vault,
        json!({"reviewReminderEnabled": true, "reviewReminderTime": "09:30"}),
    );

    assert_eq!(w.tick(18, 9, 29), None);
    assert!(w.outlet.shown().is_empty());
    assert_eq!(w.tick(18, 9, 30), Some(2));
    assert_eq!(
        w.outlet.shown(),
        [ReviewNotice {
            title: "Time to review your inbox".to_owned(),
            body: "You have 2 items to review.".to_owned(),
        }]
    );
    assert_eq!(w.outlet.due(), [2]);
    // The launch, a wake and the minute tick all land later the same day.
    assert_eq!(w.tick(18, 9, 30), None);
    assert_eq!(w.tick(18, 9, 31), None);
    assert_eq!(w.tick(18, 23, 59), None);
    assert_eq!(w.outlet.shown().len(), 1);

    assert_eq!(w.tick(19, 9, 29), None);
    assert_eq!(w.tick(19, 9, 30), Some(2));
    assert_eq!(w.outlet.shown().len(), 2);
    assert_eq!(w.outlet.due(), [2, 2]);
}

#[test]
fn a_schedule_change_re_arms_the_nudge_the_same_day() {
    let w = world();
    let vault = w.open();
    w.capture(&vault, "something to review");
    w.schedule(
        &vault,
        json!({"reviewReminderEnabled": true, "reviewReminderTime": "09:30"}),
    );
    assert_eq!(w.tick(18, 9, 30), Some(1));

    w.schedule(&vault, json!({"reviewReminderTime": "10:00"}));
    assert_eq!(w.tick(18, 9, 59), None);
    assert_eq!(w.tick(18, 10, 0), Some(1));
    assert_eq!(w.tick(18, 10, 1), None);

    w.schedule(&vault, json!({"reviewReminderEnabled": false}));
    assert_eq!(w.tick(18, 10, 2), None);
    w.schedule(&vault, json!({"reviewReminderEnabled": true}));
    assert_eq!(w.tick(18, 10, 3), Some(1));
    assert_eq!(w.outlet.shown().len(), 3);
}

#[test]
fn a_nudge_the_platform_cannot_show_still_reaches_the_renderer_once() {
    let w = world();
    let vault = w.open();
    w.capture(&vault, "something to review");
    w.schedule(
        &vault,
        json!({"reviewReminderEnabled": true, "reviewReminderTime": "09:30"}),
    );
    w.outlet.unsupported.store(true, Ordering::SeqCst);
    assert_eq!(w.tick(18, 9, 30), Some(1));
    assert!(w.outlet.shown().is_empty());
    assert_eq!(w.outlet.due(), [1]);
    assert_eq!(w.tick(18, 9, 31), None);
}

#[test]
fn the_test_notification_shows_exactly_one() {
    let w = world();
    assert!(w.review.send_test(), "no vault is needed");
    assert_eq!(
        w.outlet.shown(),
        [ReviewNotice {
            title: "Time to review your inbox".to_owned(),
            body: "This is a test — your daily review reminders will look like this.".to_owned(),
        }]
    );
    assert!(w.outlet.due().is_empty(), "a test is not a nudge");

    w.outlet.unsupported.store(true, Ordering::SeqCst);
    assert!(!w.review.send_test());
    assert_eq!(w.outlet.shown().len(), 1);
}

/// Lets the scheduler task run what is ready on the paused clock.
async fn settle() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test(start_paused = true)]
async fn the_scheduler_ticks_at_start_every_minute_on_wake_and_on_open() {
    let (power, power_rx) = broadcast::channel(4);
    let (opened, opens_rx) = mpsc::unbounded_channel();
    let (ticked, mut ticks) = mpsc::unbounded_channel();
    tokio::spawn(inbox_review::run(power_rx, opens_rx, move || {
        let _ = ticked.send(());
        std::future::ready(())
    }));
    let mut count = 0;
    let mut drain = |ticks: &mut mpsc::UnboundedReceiver<()>| {
        while ticks.try_recv().is_ok() {
            count += 1;
        }
        count
    };

    settle().await;
    assert_eq!(drain(&mut ticks), 1, "the launch's catch-up");
    tokio::time::advance(Duration::from_secs(59)).await;
    settle().await;
    assert_eq!(drain(&mut ticks), 1, "no tick before the minute");
    tokio::time::advance(Duration::from_secs(1)).await;
    settle().await;
    assert_eq!(drain(&mut ticks), 2, "the minute tick");

    power.send(PowerEvent::Suspend).expect("send");
    settle().await;
    assert_eq!(drain(&mut ticks), 2, "sleeping is not a tick");
    power.send(PowerEvent::Resume).expect("send");
    settle().await;
    assert_eq!(drain(&mut ticks), 3, "the wake");
    opened.send(()).expect("send");
    settle().await;
    assert_eq!(drain(&mut ticks), 4, "the vault open");

    // Closed channels are not read again: no busy loop, and the minute tick goes on.
    drop(power);
    drop(opened);
    settle().await;
    assert_eq!(drain(&mut ticks), 4);
    tokio::time::advance(Duration::from_secs(60)).await;
    settle().await;
    assert_eq!(drain(&mut ticks), 5);
}

#[test]
fn an_open_is_signalled_once_the_vault_is_the_open_one() {
    let w = world();
    let mut opens = inbox_review::opens(&w.session);
    let vault = w.open();
    w.capture(&vault, "something to review");
    w.schedule(
        &vault,
        json!({"reviewReminderEnabled": true, "reviewReminderTime": "00:00"}),
    );
    opens.blocking_recv().expect("the open");
    assert_eq!(w.tick(18, 0, 0), Some(1), "the open vault answers the tick");
}
