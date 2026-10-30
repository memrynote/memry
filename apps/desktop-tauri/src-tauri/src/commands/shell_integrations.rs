use memry_desktop::shell::notifications::{Route, renderer_route_allowed};
use tauri::{AppHandle, State, WebviewWindow, Wry};

use super::error::{CommandError, ErrorKind, log_failure};
use crate::badge::BadgeService;
use crate::flush::FlushService;
use crate::notifications::{NotificationPermission, NotificationRequest, NotificationService};

/// The window finished the flush `request_id` asked for. Counts only from the window that was
/// asked, with the id that was issued.
#[tauri::command]
#[specta::specta]
pub fn flush_done(
    flush: State<'_, FlushService>,
    window: WebviewWindow<Wry>,
    request_id: String,
) -> Result<(), CommandError> {
    if !flush.done(window.label(), &request_id) {
        tracing::warn!(
            scope = "Shutdown",
            "ignored a flush reply from {} for an unknown request",
            window.label()
        );
    }
    Ok(())
}

/// Whether notifications may show. macOS answers `prompt` until the user was asked; the first
/// notification asks.
#[tauri::command]
#[specta::specta]
pub async fn notification_permission(
    app: AppHandle<Wry>,
    service: State<'_, NotificationService>,
) -> Result<NotificationPermission, CommandError> {
    service
        .permission(&app)
        .await
        .map_err(|error| CommandError::new(ErrorKind::Internal, "notification_permission", error))
        .inspect_err(|error| log_failure("notification_permission", error))
}

/// Whether a notification can be shown: on macOS from the app bundle, on Windows always, on
/// Linux when a daemon owns `org.freedesktop.Notifications`.
#[tauri::command]
#[specta::specta]
pub async fn notification_supported() -> bool {
    tauri::async_runtime::spawn_blocking(crate::notifications::supported)
        .await
        .unwrap_or(false)
}

/// Shows a notification from the renderer. A click may only focus the window or run one of the
/// handlers the inbox and reminders register. Rejects when the platform refuses the notification,
/// for example when the user turned notifications off.
#[tauri::command]
#[specta::specta]
pub async fn notification_show(
    app: AppHandle<Wry>,
    service: State<'_, NotificationService>,
    request: NotificationRequest,
) -> Result<(), CommandError> {
    let route: Route = request.route.clone().into();
    if !renderer_route_allowed(&route) {
        return Err(CommandError::new(
            ErrorKind::Invalid,
            "notification_route",
            "this click route is not available to the page",
        ));
    }
    service
        .show(&app, request)
        .await
        .map_err(|error| CommandError::new(ErrorKind::Internal, "notification_show", error))
        .inspect_err(|error| log_failure("notification_show", error))
}

/// The unread count on the app icon; 0 clears it.
#[tauri::command]
#[specta::specta]
pub fn badge_set(app: AppHandle<Wry>, badge: State<'_, BadgeService>, count: u32) {
    badge.set(&app, count);
}
