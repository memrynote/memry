//! Desktop notifications, one path for everything the app shows. macOS posts through
//! `UNUserNotificationCenter` (`mac.rs`), Windows and Linux through the official plugin
//! (`plugin.rs`). Both report a click by id, and [`init`] runs at boot, before anything can be
//! shown, so every click is reported. Reminders are scheduled in process by Step 21 (#3538), which
//! calls [`NotificationService::show`] at fire time; the core seam
//! `memry_core::seams::notifications::Notifications` has no desktop implementation on purpose.

#[cfg(target_os = "macos")]
mod mac;
#[cfg(not(target_os = "macos"))]
mod plugin;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use memry_desktop::shell::notifications::{LiveNotifications, Route};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::CommandError;
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

/// Whether the app may show notifications. `prompt`: macOS has not asked the user yet, and the
/// first notification asks. Windows and Linux answer granted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum NotificationPermission {
    Granted,
    Denied,
    Prompt,
}

#[derive(Default)]
pub struct NotificationService {
    live: Mutex<LiveNotifications>,
    handlers: Mutex<HashMap<String, ClickHandler>>,
    /// Shows on macOS run one at a time: a notification shown again under the same key withdraws
    /// the earlier one before it is added, also when two are shown at once.
    #[cfg(target_os = "macos")]
    posting: tokio::sync::Mutex<()>,
}

pub fn register_stages() {
    startup::register(Stage::Plugins, "start notifications", init);
}

/// Registers the click handler. It runs in the `Plugins` stage, before any notification exists.
fn init(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    app.manage(NotificationService::default());
    #[cfg(target_os = "macos")]
    {
        mac::init(app);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        plugin::init(app)
    }
}

/// A click on notification `id`, `None` when the platform could not say which one.
fn route_click(app: &AppHandle<Wry>, id: Option<i32>) {
    let service = app.state::<NotificationService>();
    let route = id
        .and_then(|id| service.live().route_of(id))
        // Bringing the app forward is still right for a notification it no longer remembers.
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

/// Whether a notification can be shown: on macOS from the app bundle, on Windows always, on
/// Linux when a daemon owns `org.freedesktop.Notifications`. Blocking on Linux.
pub fn supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        mac::is_bundled()
    }
    #[cfg(not(target_os = "macos"))]
    {
        memry_desktop::shell::notifications::daemon_available()
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

    pub async fn permission(&self, app: &AppHandle<Wry>) -> Result<NotificationPermission, String> {
        #[cfg(target_os = "macos")]
        {
            let _ = app;
            mac::permission().await
        }
        #[cfg(not(target_os = "macos"))]
        {
            plugin::permission(app)
        }
    }

    /// Shows the notification. Fails when the platform refuses it, for example when the user
    /// turned notifications off. On macOS, while the user was never asked, the first call shows
    /// the permission prompt and resolves only once the user answers, which has no time limit,
    /// and later calls wait behind it: a caller that must not wait for the user (a reminder
    /// firing) spawns the call.
    pub async fn show(
        &self,
        app: &AppHandle<Wry>,
        request: NotificationRequest,
    ) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            let _ = app;
            let _turn = self.posting.lock().await;
            let (id, replaced) = self.live().register(&request.key, request.route.into());
            mac::post(id, &replaced, &request.title, &request.body, request.silent).await
        }
        #[cfg(not(target_os = "macos"))]
        {
            let (id, replaced) = self.live().register(&request.key, request.route.into());
            if !replaced.is_empty() {
                plugin::withdraw(app, replaced);
            }
            plugin::post(app, id, request.title, request.body, request.silent)
        }
    }
}
