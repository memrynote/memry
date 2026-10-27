//! Desktop notifications, one path for everything the app shows. The official plugin reports a
//! click by id and only for notifications shown after a handler exists, so [`init`] registers the
//! handler at boot, before anything can be shown. Reminders are scheduled in process by Step 21
//! (#3538), which calls [`NotificationService::show`] at fire time; the core seam
//! `memry_core::seams::notifications::Notifications` has no desktop implementation on purpose.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use memry_desktop::shell::notifications::{LiveNotifications, Route};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_notification::{ActionPerformed, NotificationExt};

use crate::commands::error::{CommandError, ErrorKind};
use crate::startup::{self, Stage};

/// Runs when a notification routed to its name is clicked.
pub type ClickHandler = Arc<dyn Fn(&AppHandle<Wry>) + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum NotificationRoute {
    Focus,
    DeepLink(String),
    Handler(String),
}

impl From<NotificationRoute> for Route {
    fn from(route: NotificationRoute) -> Self {
        match route {
            NotificationRoute::Focus => Self::Focus,
            NotificationRoute::DeepLink(url) => Self::DeepLink(url),
            NotificationRoute::Handler(name) => Self::Handler(name),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRequest {
    /// A re-fire with the same key replaces the earlier notification where the platform allows.
    pub key: String,
    pub title: String,
    pub body: String,
    pub silent: bool,
    pub route: NotificationRoute,
}

#[derive(Default)]
pub struct NotificationService {
    live: Mutex<LiveNotifications>,
    handlers: Mutex<HashMap<String, ClickHandler>>,
}

pub fn register_stages() {
    startup::register(Stage::Plugins, "start notifications", init);
}

/// Registers the click handler. It runs in the `Plugins` stage, before any notification exists.
fn init(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    app.manage(NotificationService::default());
    let handle = app.clone();
    app.notification()
        .on_action(move |performed| on_action(&handle, performed))
        .map_err(|error| {
            CommandError::new(ErrorKind::Internal, "notification_init", error.to_string())
        })
}

fn on_action(app: &AppHandle<Wry>, performed: &ActionPerformed) {
    // A click on the body is `tap`; Linux servers report `default`.
    if !matches!(performed.action_id(), "tap" | "default") {
        return;
    }
    let service = app.state::<NotificationService>();
    let route = performed
        .notification()
        .and_then(|notification| service.live().route_of(notification.id()))
        // The platform could not say which notification: bringing the app forward is still right.
        .unwrap_or(Route::Focus);
    crate::tray::show_main_window(app);
    match route {
        Route::Focus => {}
        Route::DeepLink(url) => app
            .state::<crate::deep_link::DeepLinkRouter>()
            .handle(app, &url),
        Route::Handler(name) => {
            let handler = service
                .handlers
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(&name)
                .cloned();
            match handler {
                Some(handler) => handler(app),
                None => tracing::info!(
                    scope = "Notifications",
                    "no click handler named {name}; the window only came forward"
                ),
            }
        }
    }
}

impl NotificationService {
    fn live(&self) -> std::sync::MutexGuard<'_, LiveNotifications> {
        self.live.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Registers what a click routed to `name` does. Steps 21 (#3538) and 27 (#3544) register
    /// `reminder-clicked`, `inbox-review-open` and `inbox-open-item`.
    pub fn on_click(&self, name: &str, handler: ClickHandler) {
        self.handlers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(name.to_owned(), handler);
    }

    pub fn show(&self, app: &AppHandle<Wry>, request: NotificationRequest) -> Result<(), String> {
        let (id, replaced) = self.live().register(&request.key, request.route.into());
        if !replaced.is_empty() {
            // Closes on Linux only: macOS and Windows cannot withdraw a delivered banner.
            if let Err(error) = app.notification().remove_active(replaced) {
                tracing::debug!(
                    scope = "Notifications",
                    "could not close the earlier one: {error}"
                );
            }
        }
        let mut builder = app
            .notification()
            .builder()
            .id(id)
            .title(request.title)
            .body(request.body);
        if request.silent {
            builder = builder.silent();
        }
        builder.show().map_err(|error| error.to_string())
    }
}
