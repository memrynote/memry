//! Windows and Linux notifications through the official plugin. It reports a click by id and
//! only for notifications shown after a handler exists, so [`init`] registers the handler at boot.

use tauri::{AppHandle, Wry};
use tauri_plugin_notification::{ActionPerformed, NotificationExt, PermissionState};

use super::NotificationPermission;
use crate::commands::error::{CommandError, ErrorKind};

pub fn init(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let handle = app.clone();
    app.notification()
        .on_action(move |performed| on_action(&handle, performed))
        .map_err(|error| {
            CommandError::new(ErrorKind::Internal, "notification_init", error.to_string())
        })
}

fn on_action(app: &AppHandle<Wry>, performed: &ActionPerformed) {
    // A click on the body is `tap`; Linux servers report `default`.
    if matches!(performed.action_id(), "tap" | "default") {
        super::route_click(
            app,
            performed
                .notification()
                .map(|notification| notification.id()),
        );
    }
}

/// The desktop plugin answers granted.
pub fn permission(app: &AppHandle<Wry>) -> Result<NotificationPermission, String> {
    match app.notification().permission_state() {
        Ok(PermissionState::Granted) => Ok(NotificationPermission::Granted),
        Ok(_) => Ok(NotificationPermission::Denied),
        Err(error) => Err(error.to_string()),
    }
}

pub fn post(
    app: &AppHandle<Wry>,
    id: i32,
    title: String,
    body: String,
    silent: bool,
) -> Result<(), String> {
    let mut builder = app.notification().builder().id(id).title(title).body(body);
    if silent {
        builder = builder.silent();
    }
    builder.show().map_err(|error| error.to_string())
}

/// Closes on Linux only: Windows cannot withdraw a delivered toast through `notify-rust`.
pub fn withdraw(app: &AppHandle<Wry>, ids: Vec<i32>) {
    if let Err(error) = app.notification().remove_active(ids) {
        tracing::debug!(
            scope = "Notifications",
            "could not close the earlier one: {error}"
        );
    }
}
