//! The reminder scheduler (Step 21f, #3538): desktop's `startReminderScheduler` and
//! `processDueReminders` (`apps/desktop/src/main/lib/reminders.ts`) on the shared minute tick.
//!
//! It ticks once when a vault opens, which fires the reminders that came due while the app was
//! closed, then every [`TICK`]. A tick that a sleeping machine missed runs once on wake
//! (`MissedTickBehavior::Delay`), never as a burst. Firing, and the rule that a reminder fires
//! once per fire instant on this device, belong to `memry_core::domain::reminders::fire`; this
//! module only drives it and hands what fired to the shell's [`ReminderSink`].

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use memry_core::api::errors::StorageError;
use memry_core::domain::reminders::{self, DueReminder, Reminder, fire};
use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::Db;
use tokio::runtime::Handle;
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;

use crate::i18n::{self, Args};
use crate::session::{OpenStage, Session};

/// Desktop's `MINUTE_TICK_INTERVAL_MS`.
pub const TICK: Duration = Duration::from_secs(60);
/// The notification group of every reminder (`groupId` in `showDesktopNotification`).
pub const NOTIFICATION_GROUP: &str = "memry-reminders";
/// The click handler a reminder notification routes to.
pub const CLICK_HANDLER: &str = "reminder-clicked";

/// Wall clock in epoch milliseconds; tests drive their own.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// What one tick did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TickReport {
    /// The reminders fired by this tick, each with its inbox item filed.
    pub fired: Vec<DueReminder>,
    /// Pending reminders after the tick, for the badge.
    pub pending: u32,
}

/// Where a tick's outcome goes: the notifications, the due event and the badge.
pub trait ReminderSink: Send + Sync {
    fn report(&self, report: &TickReport);
}

/// One tick over a vault's data database: the pending count first, so an idle tick is one
/// query, then every due reminder fired in order. A reminder whose fire fails is logged and
/// left for the next tick.
pub fn tick(db: &Db, device_id: &str, now_ms: i64) -> Result<TickReport, StorageError> {
    let device_id = device_id.to_owned();
    db.call_blocking(move |conn| {
        if fire::pending_count(conn)? == 0 {
            return Ok(TickReport {
                fired: Vec::new(),
                pending: 0,
            });
        }
        let mut fired = Vec::new();
        for due in fire::due(conn, now_ms)? {
            match fire::fire(conn, &due, &device_id, now_ms) {
                Ok(Some(_)) => fired.push(due),
                Ok(None) => {}
                Err(error) => tracing::error!(
                    scope = "Reminders",
                    reminder = %due.reminder.id,
                    "could not fire a due reminder: {error}"
                ),
            }
        }
        Ok(TickReport {
            fired,
            pending: fire::pending_count(conn)?,
        })
    })
}

/// One live reminder by id, read from the pool (a notification click names it).
pub fn get(db: &Db, id: &str) -> Result<Option<Reminder>, StorageError> {
    let id = id.to_owned();
    db.read_blocking(move |conn| reminders::get(conn, &id))
}

/// A reminder notification's title and body (`showDesktopNotification`): the reminder's title,
/// else its target's, else the localized default, after a bell; the body is a highlight's text
/// in quotes (100 UTF-16 units, then `...`), else the reminder's note, else its target type.
pub fn notice_text(locale: &str, due: &DueReminder) -> (String, String) {
    let text = |key: &str| {
        i18n::t(
            locale,
            &format!("system:notification.reminder.{key}"),
            &Args::new(),
        )
    };
    let truthy = |value: &Option<String>| value.clone().filter(|v| !v.is_empty());
    let reminder = &due.reminder;
    let title = truthy(&reminder.title)
        .or_else(|| truthy(&due.target_title))
        .unwrap_or_else(|| text("default"));
    let highlight =
        truthy(&reminder.highlight_text).filter(|_| reminder.target_type == "highlight");
    let body = if let Some(highlight) = highlight {
        let units: Vec<u16> = highlight.encode_utf16().collect();
        let cut = String::from_utf16_lossy(&units[..units.len().min(100)]);
        let more = if units.len() > 100 { "..." } else { "" };
        format!("\"{cut}{more}\"")
    } else if let Some(note) = truthy(&reminder.note) {
        note
    } else {
        match reminder.target_type.as_str() {
            kind @ ("note" | "journal" | "highlight" | "task") => text(kind),
            _ => text("fallback"),
        }
    };
    (format!("\u{1F514} {title}"), body)
}

/// The open vault's database and this device's id, held while a tick runs so a close waits
/// for it.
type Target = Option<(Db, String)>;

/// Runs the tick loop for the open vault: started by every open, stopped by every close and
/// by the `stop-schedulers` shutdown step.
pub struct ReminderScheduler {
    runtime: Handle,
    sink: Arc<dyn ReminderSink>,
    clock: Clock,
    period: Duration,
    target: Arc<Mutex<Target>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl ReminderScheduler {
    pub fn new(runtime: Handle, sink: Arc<dyn ReminderSink>, clock: Clock) -> Arc<Self> {
        Self::with_period(runtime, sink, clock, TICK)
    }

    /// [`Self::new`] with another tick period, for tests.
    pub fn with_period(
        runtime: Handle,
        sink: Arc<dyn ReminderSink>,
        clock: Clock,
        period: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            runtime,
            sink,
            clock,
            period,
            target: Arc::new(Mutex::new(None)),
            task: Mutex::new(None),
        })
    }

    /// Starts with every open, once the vault is open (desktop's tick returns early while
    /// `getStatus().isOpen` is false), and stops with every close. `store` holds the device
    /// identity a fire's inbox item is clocked with.
    pub fn register(self: &Arc<Self>, session: &Session, store: Arc<dyn SecureStore>) {
        let scheduler = self.clone();
        session.on_open(
            "reminder-scheduler",
            OpenStage::SyncStart,
            Arc::new(move |open| {
                let device_id = open
                    .vault
                    .notes_writer(store.clone())
                    .map_err(|error| error.to_string())?
                    .device_id();
                scheduler.start(open.vault.db_handle(), device_id);
                Ok(())
            }),
        );
        let scheduler = self.clone();
        session.on_close("reminder-scheduler", Arc::new(move |_| scheduler.stop()));
    }

    /// Ticks now over `db`, then every period. Replaces a loop already running.
    pub fn start(&self, db: Db, device_id: String) {
        self.stop();
        *lock(&self.target) = Some((db, device_id));
        let (target, sink, clock) = (self.target.clone(), self.sink.clone(), self.clock.clone());
        let period = self.period;
        let task = self.runtime.spawn(async move {
            let mut interval = tokio::time::interval(period);
            interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                let (target, sink, clock) = (target.clone(), sink.clone(), clock.clone());
                let ran = tokio::task::spawn_blocking(move || run_tick(&target, &*sink, &clock));
                if ran.await.is_err() {
                    tracing::error!(scope = "Reminders", "a reminder tick panicked");
                }
            }
        });
        *lock(&self.task) = Some(task);
    }

    /// Stops the loop. Waits for a tick in flight, so no tick touches a closing vault.
    pub fn stop(&self) {
        if let Some(task) = lock(&self.task).take() {
            task.abort();
        }
        *lock(&self.target) = None;
    }
}

fn run_tick(target: &Mutex<Target>, sink: &dyn ReminderSink, clock: &Clock) {
    let held = lock(target);
    let Some((db, device_id)) = held.as_ref() else {
        return;
    };
    let outcome = tick(db, device_id, clock());
    drop(held);
    match outcome {
        Ok(report) => sink.report(&report),
        Err(error) => tracing::error!(scope = "Reminders", "reminder tick failed: {error}"),
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
