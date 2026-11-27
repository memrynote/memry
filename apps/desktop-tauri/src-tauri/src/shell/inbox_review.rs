//! The inbox's minute tick in the app (`startSnoozeScheduler`, `startInboxReviewScheduler`): the
//! scheduler of `memry_desktop::shell::inbox_review` starts with the other schedulers, tells the
//! renderer of resurfaced snoozes, shows the review notification through [`NotificationService`]
//! and tells the renderer. A click on the review notification opens the inbox.

use std::sync::Arc;

use memry_desktop::locale::LocaleService;
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::session::Session;
use memry_desktop::shell::inbox_review::{
    self, InboxReview, LocalMinute, NOTIFICATION_KEY, OPEN_HANDLER, ReviewNotice, ReviewOutlet,
    SnoozeDueItem,
};
use memry_desktop::telemetry::Service;
use memry_desktop::telemetry::events::Metrics;
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::CommandError;
use crate::events::{InboxReviewDueEvent, InboxReviewOpenEvent, InboxSnoozeDueEvent, broadcast};
use crate::notifications::{NotificationRequest, NotificationRoute, NotificationService};
use crate::power::PowerMonitor;
use crate::startup::{self, Stage};

pub fn register_stages() {
    startup::register(Stage::Schedulers, "start inbox review", start);
}

struct ShellOutlet(AppHandle<Wry>);

impl ReviewOutlet for ShellOutlet {
    fn locale(&self) -> String {
        self.0.state::<Arc<LocaleService>>().get().to_owned()
    }

    fn supported(&self) -> bool {
        crate::notifications::supported()
    }

    /// Spawned: on macOS the first notification waits for the user to answer the permission
    /// prompt, and a tick must not.
    fn show(&self, notice: ReviewNotice) {
        let app = self.0.clone();
        tauri::async_runtime::spawn(async move {
            let request = NotificationRequest {
                key: NOTIFICATION_KEY.to_owned(),
                title: notice.title,
                body: notice.body,
                silent: false,
                route: NotificationRoute::Handler(OPEN_HANDLER.to_owned()),
            };
            if let Err(error) = app.state::<NotificationService>().show(&app, request).await {
                tracing::warn!(
                    scope = "InboxReview",
                    "the review notification was not shown: {error}"
                );
            }
        });
    }

    fn due(&self, count: i64) {
        broadcast(&self.0, InboxReviewDueEvent { count });
    }

    /// Closes the snooze funnel (`inbox_snoozed`: snoozed by hand, resurfaced here).
    fn snooze_due(&self, items: Vec<SnoozeDueItem>) {
        let count = items.len();
        if let Some(telemetry) = self.0.try_state::<Arc<Service>>() {
            let mut event = Service::event("inbox_snoozed", "inbox", "resurfaced");
            event.result = Some("success".to_owned());
            event.metrics = Some(Metrics {
                item_count: Some(count as f64),
                ..Metrics::default()
            });
            telemetry.track_main_event(event);
        }
        let count = i64::try_from(count).unwrap_or(i64::MAX);
        broadcast(&self.0, InboxSnoozeDueEvent { count, items });
    }
}

/// Runs in `Schedulers`, after the session (`VaultOpen`), the power monitor (`Handlers`) and
/// the notification service (`Plugins`) exist. The launch's vault is already open, so the first
/// tick checks it.
fn start(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let session = app.state::<Session>().inner().clone();
    let store = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
    let opens = inbox_review::opens(&session);
    let review = Arc::new(InboxReview::new(
        session,
        store,
        Arc::new(ShellOutlet(app.clone())),
    ));
    app.manage(review.clone());
    app.state::<NotificationService>().on_click(
        OPEN_HANDLER,
        Arc::new(|app, _key| broadcast(app, InboxReviewOpenEvent {})),
    );
    let power = app.state::<PowerMonitor>().subscribe();
    tauri::async_runtime::spawn(inbox_review::run(power, opens, move || {
        let review = review.clone();
        async move {
            // A tick during the shutdown sequence would write to a vault that is closing.
            if startup::shutdown_started() {
                return;
            }
            // Snoozes first, as Electron registers its minute-tick listeners: a resurfaced
            // capture counts toward the review nudge of the same tick.
            let pass = move || {
                review.resurface();
                review.tick(&LocalMinute::now());
            };
            if let Err(error) = tauri::async_runtime::spawn_blocking(pass).await {
                tracing::warn!(scope = "InboxReview", "inbox tick failed: {error}");
            }
        }
    }));
    Ok(())
}
