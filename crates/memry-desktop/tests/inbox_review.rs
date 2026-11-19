//! The inbox review nudge against a real session and vault, with a recording outlet in place of
//! the OS notification: once per local day at the set minute, again the same day after the
//! schedule changes through the settings service, the test notification shown exactly once, and
//! the scheduler's cadence on a paused clock. The snooze pass on the same tick: every capture due
//! after a long sleep back once, and a snooze a peer changed honoured at the next tick.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Wake, Waker};
use std::time::Duration;

use chrono::NaiveDate;
use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::SecureStoreError;
use memry_core::domain::inbox::write;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::sync::apply::apply_inbound;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, OpenVault, Session};
use memry_desktop::settings::SettingsService;
use memry_desktop::shell::inbox_review::{
    self, InboxReview, LocalMinute, ReviewNotice, ReviewOutlet, SnoozeDueItem,
};
use memry_desktop::shell::power::PowerEvent;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::{broadcast, mpsc};

/// The secure store, counting the reads of the device key.
#[derive(Default)]
struct MemoryStore {
    values: Mutex<HashMap<SecureStoreKey, Vec<u8>>>,
    key_reads: AtomicUsize,
}

impl SecureStore for MemoryStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        if key == SecureStoreKey::DeviceSigningKey {
            self.key_reads.fetch_add(1, Ordering::SeqCst);
        }
        Ok(self.values.lock().unwrap().get(&key).cloned())
    }

    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.values.lock().unwrap().insert(key, value);
        Ok(())
    }

    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.values.lock().unwrap().remove(&key);
        Ok(())
    }

    fn clear(&self) -> Result<(), SecureStoreError> {
        self.values.lock().unwrap().clear();
        Ok(())
    }
}

/// The shell's notification and renderer event, recorded.
#[derive(Default)]
struct Recorder {
    shown: Mutex<Vec<ReviewNotice>>,
    due: Mutex<Vec<i64>>,
    snoozes_due: Mutex<Vec<Vec<SnoozeDueItem>>>,
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

    fn snooze_due(&self, items: Vec<SnoozeDueItem>) {
        self.snoozes_due.lock().unwrap().push(items);
    }
}

impl Recorder {
    fn shown(&self) -> Vec<ReviewNotice> {
        self.shown.lock().unwrap().clone()
    }

    fn due(&self) -> Vec<i64> {
        self.due.lock().unwrap().clone()
    }

    /// The resurfaced ids of each snooze-due event, sorted.
    fn snoozes_due(&self) -> Vec<Vec<String>> {
        let events = self.snoozes_due.lock().unwrap();
        events
            .iter()
            .map(|items| {
                let mut ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
                ids.sort();
                ids
            })
            .collect()
    }
}

struct World {
    dir: tempfile::TempDir,
    session: Session,
    store: Arc<dyn SecureStore>,
    keys: Arc<MemoryStore>,
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
    let keys = Arc::new(MemoryStore::default());
    let store: Arc<dyn SecureStore> = keys.clone();
    // A profile that captured or changed a setting has its device key.
    ensure_device_identity(store.clone()).expect("device key");
    let settings = SettingsService::new(store.clone(), config);
    let outlet = Arc::new(Recorder::default());
    let review = InboxReview::new(session.clone(), store.clone(), outlet.clone());
    World {
        dir,
        session,
        store,
        keys,
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

    fn capture_id(&self, vault: &OpenVault, content: &str) -> String {
        let inbox = vault.vault.inbox(self.store.clone()).expect("inbox");
        let captured = inbox.capture_text(content.to_owned(), None, None, false);
        captured.expect("capture").item.id
    }

    /// A snooze until `until`, set an hour before it.
    fn snooze(&self, vault: &OpenVault, id: &str, until: i64) {
        let id = id.to_owned();
        vault
            .vault
            .db_handle()
            .call_blocking(move |conn| {
                write::snooze(conn, &id, until, None, "this-device", until - HOUR)?;
                Ok(())
            })
            .expect("snooze");
    }

    /// A peer's edit of the capture, its clock ahead of this device's, through the sync apply.
    fn from_peer(&self, vault: &OpenVault, id: &str, edit: impl FnOnce(&mut Value)) {
        let id = id.to_owned();
        let db = vault.vault.db_handle();
        let raw = db
            .call_blocking({
                let id = id.clone();
                move |conn| Ok(sync_items::push_payload(conn, "inbox", &id)?.expect("payload"))
            })
            .expect("the local record");
        let mut payload: Value = serde_json::from_str(&raw).expect("json");
        edit(&mut payload);
        payload["clock"]["peer"] = json!(1);
        let record = InboundRecord {
            item_type: "inbox".into(),
            item_id: id,
            payload_json: payload.to_string(),
            server_cursor: Some(1),
            signer_device_id: Some("peer".into()),
            updated_at: now_ms(),
            deleted_at: None,
        };
        db.call_blocking(move |conn| apply_inbound(conn, &record, now_ms()))
            .expect("apply");
    }

    fn tick(&self, day: u32, hour: u32, minute: u32) -> Option<i64> {
        self.review.tick(&at(day, hour, minute))
    }

    fn key_reads(&self) -> usize {
        self.keys.key_reads.load(Ordering::SeqCst)
    }
}

const HOUR: i64 = 3_600_000;

fn now_ms() -> i64 {
    let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH);
    i64::try_from(since.expect("after 1970").as_millis()).expect("ms")
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

/// Counts the wakes of a future polled by hand.
#[derive(Default)]
struct Wakes(AtomicUsize);

impl Wake for Wakes {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test(start_paused = true)]
async fn closed_channels_leave_the_scheduler_asleep_until_the_minute() {
    let (power, power_rx) = broadcast::channel::<PowerEvent>(4);
    let (opened, opens_rx) = mpsc::unbounded_channel();
    drop(power);
    drop(opened);
    let ticks = Arc::new(AtomicUsize::new(0));
    let counted = ticks.clone();
    let mut run = std::pin::pin!(inbox_review::run(power_rx, opens_rx, move || {
        counted.fetch_add(1, Ordering::SeqCst);
        std::future::ready(())
    }));
    let wakes = Arc::new(Wakes::default());
    let waker = Waker::from(wakes.clone());

    assert!(
        run.as_mut()
            .poll(&mut Context::from_waker(&waker))
            .is_pending()
    );
    assert_eq!(ticks.load(Ordering::SeqCst), 1, "the launch's catch-up");
    // A loop that went on reading a closed channel would be cut off by tokio's budget, which
    // defers its wake to the scheduler: the wake lands once this task yields.
    settle().await;
    assert_eq!(wakes.0.load(Ordering::SeqCst), 0, "asleep until the minute");
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
    assert_eq!(opens.try_recv(), Err(TryRecvError::Empty), "one signal");
    assert_eq!(w.tick(18, 0, 0), Some(1), "the open vault answers the tick");

    // The forwarder ends with the session, so every event it read is in the channel by then.
    drop(vault);
    w.session.close();
    drop(w);
    assert_eq!(
        opens.blocking_recv(),
        None,
        "the close and the open's other events send nothing"
    );
}

#[test]
fn a_tick_reads_the_device_key_once_per_open() {
    let w = world();
    let vault = w.open();
    w.capture(&vault, "something to review");
    w.schedule(
        &vault,
        json!({"reviewReminderEnabled": true, "reviewReminderTime": "09:30"}),
    );
    let before = w.key_reads();
    for minute in 28..33 {
        w.tick(18, 9, minute);
    }
    assert_eq!(w.outlet.due(), [1]);
    assert_eq!(
        w.key_reads() - before,
        1,
        "read at the open's first tick only"
    );

    drop(vault);
    w.session.close();
    assert_eq!(w.tick(18, 9, 33), None, "no vault is open");
    let vault = w.open();
    let before = w.key_reads();
    for minute in 34..37 {
        w.tick(18, 9, minute);
    }
    assert_eq!(w.key_reads() - before, 1, "the next open builds its own");
    drop(vault);
}

/// `processDueItems` after a long sleep: every capture whose snooze passed while the machine slept
/// comes back in one event, the rest stay snoozed, and the next tick finds nothing to repeat.
#[test]
fn every_snooze_due_after_a_long_sleep_comes_back_once() {
    let w = world();
    assert_eq!(w.review.resurface(), 0, "no vault is open");
    let vault = w.open();
    let now = now_ms();
    let ids: Vec<String> = ["three days", "yesterday", "a minute ago", "tomorrow"]
        .iter()
        .map(|title| w.capture_id(&vault, title))
        .collect();
    for (id, until) in ids.iter().zip([-72 * HOUR, -24 * HOUR, -60_000, 24 * HOUR]) {
        w.snooze(&vault, id, now + until);
    }

    assert_eq!(w.review.resurface(), 3);
    let mut due = ids[..3].to_vec();
    due.sort();
    assert_eq!(w.outlet.snoozes_due(), [due]);
    let first = w.outlet.snoozes_due.lock().unwrap()[0].clone();
    let item = first
        .iter()
        .find(|item| item.id == ids[1])
        .expect("yesterday");
    assert_eq!(
        (item.title.as_str(), item.item_type.as_str()),
        ("yesterday", "note")
    );
    assert_eq!(
        (item.processing_status.as_str(), item.is_stale),
        ("complete", false)
    );
    assert!(item.created_at.ends_with('Z'), "{}", item.created_at);

    assert_eq!(w.review.resurface(), 0, "nothing is due twice");
    assert_eq!(w.outlet.snoozes_due().len(), 1);
    let inbox = vault.vault.inbox(w.store.clone()).expect("inbox");
    let snoozed: Vec<String> = inbox
        .snoozed()
        .expect("snoozed")
        .into_iter()
        .map(|i| i.id)
        .collect();
    assert_eq!(snoozed, [ids[3].clone()], "tomorrow stays snoozed");
}

/// The pass reads the store at every tick: a peer that moved a snooze into the past brings the
/// capture back, and one that cleared a past-due snooze leaves nothing to resurface.
#[test]
fn a_snooze_a_peer_changed_is_honoured_at_the_next_tick() {
    let w = world();
    let vault = w.open();
    let now = now_ms();
    let moved = w.capture_id(&vault, "moved by the peer");
    let cleared = w.capture_id(&vault, "unsnoozed by the peer");
    w.snooze(&vault, &moved, now + 24 * HOUR);
    w.snooze(&vault, &cleared, now - 60_000);
    w.from_peer(&vault, &moved, |p| {
        p["snoozedUntil"] = json!("2020-01-01T00:00:00.000Z");
    });
    w.from_peer(&vault, &cleared, |p| {
        p["snoozedUntil"] = Value::Null;
        p["snoozeReason"] = Value::Null;
    });

    assert_eq!(w.review.resurface(), 1);
    assert_eq!(w.outlet.snoozes_due(), [vec![moved]]);
}

/// `resolveAttachmentUrl`: a thumbnail in the vault is a `memry-file` URL, a missing one is
/// none, and a path a peer pointed outside the vault is none.
#[test]
fn a_resurfaced_thumbnail_is_a_url_only_inside_the_vault() {
    let w = world();
    let vault = w.open();
    let thumb = "attachments/inbox/t/thumb.png";
    let file = vault.path.join(thumb);
    std::fs::create_dir_all(file.parent().expect("dir")).expect("dir");
    std::fs::write(&file, b"png").expect("thumb");
    std::fs::write(w.dir.path().join("outside.png"), b"png").expect("outside");
    let paths = [thumb, "attachments/inbox/t/missing.png", "../outside.png"];
    let mut ids = Vec::new();
    for path in paths {
        let id = w.capture_id(&vault, path);
        w.from_peer(&vault, &id, |p| {
            p["thumbnailPath"] = json!(path);
            p["snoozedUntil"] = json!("2020-01-01T00:00:00.000Z");
        });
        ids.push(id);
    }

    assert_eq!(w.review.resurface(), 3);
    let items = w.outlet.snoozes_due.lock().unwrap()[0].clone();
    let url = |id: &str| {
        let item = items.iter().find(|item| item.id == id).expect("item");
        item.thumbnail_url.clone()
    };
    let shown = url(&ids[0]).expect("a url");
    assert!(
        shown.starts_with("memry-file://") && shown.ends_with(thumb),
        "{shown}"
    );
    assert_eq!(url(&ids[1]), None);
    assert_eq!(url(&ids[2]), None);
}
