//! The daily inbox review nudge (`inbox/review-scheduler.ts`, `inbox/review-notification.ts`).
//! A tick at launch, every minute, at every vault open and at every wake asks the core whether
//! the nudge is due at the local wall clock. `Inbox::review_due` owns the decision and the
//! once-per-local-day guard, so ticks that land in the same minute cannot both fire. This module
//! never depends on `tauri`: the shell's [`ReviewOutlet`] shows the notification and tells the
//! renderer.

use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use chrono::{Datelike, Local, NaiveDateTime, Timelike};
use memry_core::api::inbox::Inbox;
use memry_core::seams::secure_store::SecureStore;
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;

use crate::i18n::{self, Args};
use crate::session::{Session, SessionEvent, lock};
use crate::shell::power::PowerEvent;

/// The notification's key: a new nudge replaces one still on screen.
pub const NOTIFICATION_KEY: &str = "inbox-review";
/// The click handler that opens the inbox (`openInboxOnClick`).
pub const OPEN_HANDLER: &str = "inbox-review-open";
/// The cadence of the scheduled tick (`MINUTE_TICK_INTERVAL_MS`).
pub const TICK: Duration = Duration::from_secs(60);

/// The local calendar day and the minute of it, the clock `Inbox::review_due` reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalMinute {
    /// `YYYY-MM-DD` in local time (`localDateString`), never UTC.
    pub date: String,
    /// Minutes since local midnight.
    pub minutes: u32,
}

impl LocalMinute {
    pub fn of(at: NaiveDateTime) -> Self {
        Self {
            date: format!("{:04}-{:02}-{:02}", at.year(), at.month(), at.day()),
            minutes: at.hour() * 60 + at.minute(),
        }
    }

    /// Read at every tick, so a time zone change counts from the next tick on.
    pub fn now() -> Self {
        Self::of(Local::now().naive_local())
    }
}

/// The text of a review notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewNotice {
    pub title: String,
    pub body: String,
}

/// The nudge, pluralised on the reviewable count (`showReviewNotification`).
pub fn due_notice(locale: &str, count: i64) -> ReviewNotice {
    let mut args = Args::new();
    args.insert("count".to_owned(), count.into());
    ReviewNotice {
        title: i18n::t(
            locale,
            "system:notification.inboxReview.title",
            &Args::new(),
        ),
        body: i18n::t(locale, "system:notification.inboxReview.body", &args),
    }
}

/// The on-demand test from Settings, under the real title (`sendTestReviewNotification`).
pub fn test_notice(locale: &str) -> ReviewNotice {
    ReviewNotice {
        title: i18n::t(
            locale,
            "system:notification.inboxReview.title",
            &Args::new(),
        ),
        body: i18n::t(
            locale,
            "system:notification.inboxReview.testBody",
            &Args::new(),
        ),
    }
}

/// Where a nudge goes. The shell shows the OS notification and tells the renderer.
pub trait ReviewOutlet: Send + Sync {
    /// The app's live locale.
    fn locale(&self) -> String;
    /// Whether the platform can show a notification (`Notification.isSupported()`). May block.
    fn supported(&self) -> bool;
    /// Shows the notification without waiting for it; a refusal is the outlet's to log.
    fn show(&self, notice: ReviewNotice);
    /// The nudge fired (`inbox:review-due`): the renderer shows its toast.
    fn due(&self, count: i64);
}

pub struct InboxReview {
    session: Session,
    store: Arc<dyn SecureStore>,
    outlet: Arc<dyn ReviewOutlet>,
    /// The open vault's inbox, built at its first tick and dropped by the close hook before the
    /// vault closes, so a tick does not read the device key every minute.
    inbox: Arc<Mutex<Option<Arc<Inbox>>>>,
    /// The last tick failure logged, so a lasting one is logged once and not every minute.
    last_failure: Mutex<Option<String>>,
}

impl InboxReview {
    pub fn new(
        session: Session,
        store: Arc<dyn SecureStore>,
        outlet: Arc<dyn ReviewOutlet>,
    ) -> Self {
        let inbox = Arc::new(Mutex::new(None));
        let held = inbox.clone();
        session.on_close("inbox review", Arc::new(move |_| *lock(&held) = None));
        Self {
            session,
            store,
            outlet,
            inbox,
            last_failure: Mutex::new(None),
        }
    }

    /// One tick (`runReviewTick`) at `at`: nothing without an open vault, else the core decides
    /// and records the day before it answers. Returns the reviewable count when the nudge fired.
    /// Blocking.
    pub fn tick(&self, at: &LocalMinute) -> Option<i64> {
        let due = self.inbox()?.and_then(|inbox| {
            inbox
                .review_due(at.date.clone(), at.minutes)
                .map_err(|error| error.to_string())
        });
        let count = match due {
            Ok(count) => {
                *self.failure() = None;
                count?
            }
            Err(error) => {
                let mut last = self.failure();
                if last.as_deref() != Some(error.as_str()) {
                    tracing::warn!(scope = "InboxReview", "review tick failed: {error}");
                    *last = Some(error);
                }
                return None;
            }
        };
        self.notify(due_notice(&self.outlet.locale(), count));
        self.outlet.due(count);
        tracing::info!(
            scope = "InboxReview",
            "Review nudge fired for {count} item(s)"
        );
        Some(count)
    }

    /// Shows the test notification now. `false` when the platform cannot show one. Blocking.
    pub fn send_test(&self) -> bool {
        self.notify(test_notice(&self.outlet.locale()))
    }

    fn notify(&self, notice: ReviewNotice) -> bool {
        if !self.outlet.supported() {
            tracing::warn!(scope = "InboxReview", "Desktop notifications not supported");
            return false;
        }
        self.outlet.show(notice);
        true
    }

    /// The open vault's inbox, `None` without an open vault. The lock is held from `current` to
    /// the store, so a close that has taken the vault finds nothing left to drop after it.
    fn inbox(&self) -> Option<Result<Arc<Inbox>, String>> {
        let mut held = lock(&self.inbox);
        let open = self.session.current()?;
        if let Some(inbox) = held.as_ref() {
            return Some(Ok(inbox.clone()));
        }
        let built = open.vault.inbox(self.store.clone());
        Some(
            built
                .inspect(|inbox| *held = Some(inbox.clone()))
                .map_err(|error| error.to_string()),
        )
    }

    fn failure(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        self.last_failure
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

/// A signal per vault open of `session`, sent once the vault is the open one. Forwarded by a
/// thread that ends with the session.
pub fn opens(session: &Session) -> mpsc::UnboundedReceiver<()> {
    let (tx, rx) = mpsc::unbounded_channel();
    let events = session.subscribe();
    let forward = move || {
        for event in events {
            if matches!(event, SessionEvent::Opened { .. }) && tx.send(()).is_err() {
                return;
            }
        }
    };
    if let Err(error) = std::thread::Builder::new()
        .name("inbox-review-opens".to_owned())
        .spawn(forward)
    {
        tracing::warn!(
            scope = "InboxReview",
            "no tick at vault open, only every minute: {error}"
        );
    }
    rx
}

/// Runs `tick` at once (the launch's catch-up), every [`TICK`], at every wake and at every
/// vault open, one tick at a time, for as long as the runtime runs. A missed minute is not
/// made up: the next tick decides from the clock it reads. A closed channel is no longer read.
pub async fn run<F, Fut>(
    mut power: broadcast::Receiver<PowerEvent>,
    mut opens: mpsc::UnboundedReceiver<()>,
    mut tick: F,
) where
    F: FnMut() -> Fut,
    Fut: Future<Output = ()>,
{
    let mut minute = tokio::time::interval(TICK);
    minute.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let (mut power_open, mut opens_open) = (true, true);
    loop {
        tokio::select! {
            _ = minute.tick() => {}
            event = power.recv(), if power_open => match event {
                // A lagged receiver may have missed a wake.
                Ok(PowerEvent::Resume) | Err(RecvError::Lagged(_)) => {}
                Ok(_) => continue,
                Err(RecvError::Closed) => {
                    power_open = false;
                    continue;
                }
            },
            opened = opens.recv(), if opens_open => {
                if opened.is_none() {
                    opens_open = false;
                    continue;
                }
            }
        }
        tick().await;
    }
}
