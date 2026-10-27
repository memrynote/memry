use memry_desktop::shell::notifications::{Route, renderer_route_allowed};
use tauri::{AppHandle, State, WebviewWindow, Wry};

use super::error::{CommandError, ErrorKind};
use crate::badge::BadgeService;
use crate::flush::FlushService;
use crate::notifications::{NotificationRequest, NotificationService};

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

/// Desktop needs no permission prompt: the plugin answers granted.
#[derive(Debug, Clone, Copy, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum NotificationPermission {
    Granted,
    Denied,
}

#[tauri::command]
#[specta::specta]
pub fn notification_permission(
    app: AppHandle<Wry>,
) -> Result<NotificationPermission, CommandError> {
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    let state = app.notification().permission_state().map_err(|error| {
        CommandError::new(
            ErrorKind::Internal,
            "notification_permission",
            error.to_string(),
        )
    })?;
    Ok(match state {
        PermissionState::Granted => NotificationPermission::Granted,
        _ => NotificationPermission::Denied,
    })
}

/// Whether a notification can be shown: always on macOS and Windows, on Linux when a daemon owns
/// `org.freedesktop.Notifications`.
#[tauri::command]
#[specta::specta]
pub async fn notification_supported() -> bool {
    tauri::async_runtime::spawn_blocking(memry_desktop::shell::notifications::daemon_available)
        .await
        .unwrap_or(false)
}

/// Shows a notification from the renderer. A click may only focus the window or run one of the
/// handlers the inbox and reminders register.
#[tauri::command]
#[specta::specta]
pub fn notification_show(
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
        .map_err(|error| CommandError::new(ErrorKind::Internal, "notification_show", error))
}

/// The unread count on the app icon; 0 clears it.
#[tauri::command]
#[specta::specta]
pub fn badge_set(app: AppHandle<Wry>, badge: State<'_, BadgeService>, count: u32) {
    badge.set(&app, count);
}
