//! The reminder scheduler's shell (Step 21f, #3538): the notification, the due event and the
//! badge of every tick, the click on a reminder notification, and the `stop-schedulers` step.
//! The scheduler itself is `memry_desktop::tasks::reminders`.

use std::sync::Arc;

use memry_desktop::locale::LocaleService;
use memry_desktop::session::Session;
use memry_desktop::tasks::reminders::{
    self, CLICK_HANDLER, ReminderScheduler, ReminderSink, TickReport, notice_text,
};
use tauri::{AppHandle, Manager, Wry};

use crate::badge::BadgeService;
use crate::events::{ReminderClickedEvent, ReminderDueEvent, ReminderHint, broadcast};
use crate::notifications::{NotificationRequest, NotificationRoute, NotificationService};
use crate::shutdown::ShutdownService;

/// Registered before the first open, so the open that launches the app ticks.
pub fn register(app: &AppHandle<Wry>, session: &Session) {
    let scheduler = ReminderScheduler::new(
        tauri::async_runtime::handle().inner().clone(),
        Arc::new(Shell { app: app.clone() }),
        Arc::new(|| i64::try_from(memry_desktop::telemetry::time::now_ms()).unwrap_or(i64::MAX)),
    );
    scheduler.register(session);

    let stopping = scheduler.clone();
    let registered = app.state::<ShutdownService>().register(
        "stop-schedulers",
        Arc::new(move |_, _| {
            let scheduler = stopping.clone();
            Box::pin(async move {
                tauri::async_runtime::spawn_blocking(move || scheduler.stop())
                    .await
                    .map_err(|error| error.to_string())
            })
        }),
    );
    if let Err(error) = registered {
        tracing::error!(scope = "Reminders", "{error}");
    }

    let clicked = session.clone();
    app.state::<NotificationService>().on_click(
        CLICK_HANDLER,
        Arc::new(move |app, id| match hint_of(&clicked, id) {
            Some(reminder) => broadcast(app, ReminderClickedEvent { reminder }),
            None => tracing::info!(scope = "Reminders", "a clicked reminder is gone: {id}"),
        }),
    );
    app.manage(scheduler);
}

/// The clicked reminder in the open vault (`showDesktopNotification`'s click sends the
/// reminder; the renderer fetches it by id).
fn hint_of(session: &Session, id: &str) -> Option<ReminderHint> {
    let open = session.current()?;
    match reminders::get(&open.vault.db_handle(), id) {
        Ok(reminder) => reminder.map(|r| ReminderHint::new(&r.id, &r.target_type, &r.target_id)),
        Err(error) => {
            tracing::warn!(
                scope = "Reminders",
                "could not read a clicked reminder: {error}"
            );
            None
        }
    }
}

struct Shell {
    app: AppHandle<Wry>,
}

impl ReminderSink for Shell {
    fn report(&self, report: &TickReport) {
        let locale = self.app.state::<Arc<LocaleService>>().get();
        for due in &report.fired {
            let (title, body) = notice_text(locale, due);
            let request = NotificationRequest {
                key: due.reminder.id.clone(),
                title,
                body,
                silent: false,
                route: NotificationRoute::Handler(CLICK_HANDLER.to_owned()),
            };
            let app = self.app.clone();
            let id = due.reminder.id.clone();
            // Spawned: on macOS the first show waits for the user to answer the permission
            // prompt. Every fired reminder has its inbox item, so a refused banner is logged.
            tauri::async_runtime::spawn(async move {
                let service = app.state::<NotificationService>();
                if let Err(error) = service.show(&app, request).await {
                    tracing::warn!(scope = "Reminders", "notification for {id} failed: {error}");
                }
            });
        }
        if !report.fired.is_empty() {
            let reminders = report
                .fired
                .iter()
                .map(|due| {
                    let r = &due.reminder;
                    ReminderHint::new(&r.id, &r.target_type, &r.target_id)
                })
                .collect();
            broadcast(&self.app, ReminderDueEvent { reminders });
        }
        self.app
            .state::<BadgeService>()
            .set(&self.app, report.pending);
    }
}
