//! The reminder commands (`reminder:*` of `ipc/reminder-handlers.ts`), each one call of
//! `memry_desktop::tasks::reminder_service`. After a write commits: its event, the badge
//! (`updateAppBadge`), and for a dismiss, snooze or delete the reminder's banner withdrawn
//! (`removeDeliveredNotification`).

use std::sync::Arc;

use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::session::Session;
use memry_desktop::tasks::reminder_contract::{
    ReminderCreateInput, ReminderListInput, ReminderListView, ReminderSnoozeInput,
    ReminderTargetInput, ReminderUpdateInput, ReminderView, ReminderWithTargetView,
};
use memry_desktop::tasks::reminder_service::{ReminderError, ReminderService};
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};
use crate::badge::BadgeService;
use crate::events::{
    ReminderCreatedEvent, ReminderDeletedEvent, ReminderDismissedEvent, ReminderHint,
    ReminderSnoozedEvent, ReminderUpdatedEvent, broadcast,
};
use crate::notifications::NotificationService;

fn now_ms() -> i64 {
    i64::try_from(memry_desktop::telemetry::time::now_ms()).unwrap_or(i64::MAX)
}

fn text(app: &AppHandle<Wry>, key: &str) -> String {
    i18n::t(app.state::<Arc<LocaleService>>().get(), key, &Args::new())
}

/// The open vault's reminders; the localized "no vault is open" when there is none.
fn service(app: &AppHandle<Wry>) -> Result<ReminderService, CommandError> {
    let open = app.state::<Session>().current().ok_or_else(|| {
        CommandError::new(
            ErrorKind::Invalid,
            "no_vault_open",
            text(app, "errors:ipc.noVaultOpen"),
        )
    })?;
    let store = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
    ReminderService::open(&open, store).map_err(|error| CommandError::from_core(&error))
}

/// Electron's messages: `errors:reminder.notFound`, `system:error.reminderTimeMustBeFuture`.
fn failed(app: &AppHandle<Wry>, error: ReminderError) -> CommandError {
    match error {
        ReminderError::NotFound => CommandError::new(
            ErrorKind::NotFound,
            "reminder_not_found",
            text(app, "errors:reminder.notFound"),
        ),
        ReminderError::RemindAtPast => CommandError::new(
            ErrorKind::Invalid,
            "reminder_time_past",
            text(app, "system:error.reminderTimeMustBeFuture"),
        ),
        ReminderError::SnoozePast => {
            CommandError::new(ErrorKind::Invalid, "snooze_time_past", error.to_string())
        }
        ReminderError::Invalid(what) => CommandError::new(ErrorKind::Invalid, "invalid", what),
        ReminderError::Storage(error) => CommandError::from_core(&error),
    }
}

fn hint(view: &ReminderView) -> ReminderHint {
    ReminderHint::new(&view.id, &view.target_type, &view.target_id)
}

/// The badge after a write, and the banners of `withdrawn` taken down.
fn settle(app: &AppHandle<Wry>, pending: u32, withdrawn: Vec<String>) {
    app.state::<BadgeService>().set(app, pending);
    if withdrawn.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let service = app.state::<NotificationService>();
        for key in withdrawn {
            service.withdraw(&app, &key).await;
        }
    });
}

#[tauri::command]
#[specta::specta]
pub async fn reminder_create(
    app: AppHandle<Wry>,
    input: ReminderCreateInput,
) -> Result<ReminderView, CommandError> {
    let written = blocking("reminder_create", {
        let app = app.clone();
        move || {
            service(&app)?
                .create(&input, now_ms())
                .map_err(|error| failed(&app, error))
        }
    })
    .await?;
    broadcast(
        &app,
        ReminderCreatedEvent {
            reminder: hint(&written.value),
        },
    );
    settle(&app, written.pending, Vec::new());
    Ok(written.value)
}

#[tauri::command]
#[specta::specta]
pub async fn reminder_update(
    app: AppHandle<Wry>,
    input: ReminderUpdateInput,
) -> Result<ReminderView, CommandError> {
    let written = blocking("reminder_update", {
        let app = app.clone();
        move || {
            service(&app)?
                .update(&input, now_ms())
                .map_err(|error| failed(&app, error))
        }
    })
    .await?;
    broadcast(
        &app,
        ReminderUpdatedEvent {
            reminder: hint(&written.value),
        },
    );
    settle(&app, written.pending, Vec::new());
    Ok(written.value)
}

#[tauri::command]
#[specta::specta]
pub async fn reminder_delete(app: AppHandle<Wry>, id: String) -> Result<(), CommandError> {
    let written = blocking("reminder_delete", {
        let app = app.clone();
        move || {
            service(&app)?
                .delete(&id, now_ms())
                .map_err(|error| failed(&app, error))
        }
    })
    .await?;
    broadcast(
        &app,
        ReminderDeletedEvent {
            reminder: hint(&written.value),
        },
    );
    settle(&app, written.pending, vec![written.value.id]);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn reminder_dismiss(
    app: AppHandle<Wry>,
    id: String,
) -> Result<ReminderView, CommandError> {
    let written = blocking("reminder_dismiss", {
        let app = app.clone();
        move || {
            service(&app)?
                .dismiss(&id, now_ms())
                .map_err(|error| failed(&app, error))
        }
    })
    .await?;
    broadcast(
        &app,
        ReminderDismissedEvent {
            reminder: hint(&written.value),
        },
    );
    settle(&app, written.pending, vec![written.value.id.clone()]);
    Ok(written.value)
}

#[tauri::command]
#[specta::specta]
pub async fn reminder_snooze(
    app: AppHandle<Wry>,
    input: ReminderSnoozeInput,
) -> Result<ReminderView, CommandError> {
    let written = blocking("reminder_snooze", {
        let app = app.clone();
        move || {
            service(&app)?
                .snooze(&input, now_ms())
                .map_err(|error| failed(&app, error))
        }
    })
    .await?;
    broadcast(
        &app,
        ReminderSnoozedEvent {
            reminder: hint(&written.value),
        },
    );
    settle(&app, written.pending, vec![written.value.id.clone()]);
    Ok(written.value)
}

/// Dismisses each id that names a live reminder and returns how many. A failure stops the
/// batch; the reminders dismissed before it keep their events and lose their banners.
#[tauri::command]
#[specta::specta]
pub async fn reminder_bulk_dismiss(
    app: AppHandle<Wry>,
    reminder_ids: Vec<String>,
) -> Result<u32, CommandError> {
    let done = blocking("reminder_bulk_dismiss", {
        let app = app.clone();
        move || Ok(service(&app)?.bulk_dismiss(&reminder_ids, now_ms()))
    })
    .await?;
    for view in &done.dismissed {
        broadcast(
            &app,
            ReminderDismissedEvent {
                reminder: hint(view),
            },
        );
    }
    let ids = done.dismissed.iter().map(|view| view.id.clone()).collect();
    settle(&app, done.pending, ids);
    if let Some(error) = done.failure {
        let error = failed(&app, error);
        log_failure("reminder_bulk_dismiss", &error);
        return Err(error);
    }
    Ok(u32::try_from(done.dismissed.len()).unwrap_or(u32::MAX))
}

#[tauri::command]
#[specta::specta]
pub async fn reminder_get(
    app: AppHandle<Wry>,
    id: String,
) -> Result<Option<ReminderWithTargetView>, CommandError> {
    blocking("reminder_get", move || {
        service(&app)?.get(&id).map_err(|error| failed(&app, error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn reminder_list(
    app: AppHandle<Wry>,
    input: Option<ReminderListInput>,
) -> Result<ReminderListView, CommandError> {
    blocking("reminder_list", move || {
        service(&app)?
            .list(&input.unwrap_or_default())
            .map_err(|error| failed(&app, error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn reminder_get_upcoming(
    app: AppHandle<Wry>,
    days: Option<u32>,
) -> Result<ReminderListView, CommandError> {
    blocking("reminder_get_upcoming", move || {
        service(&app)?
            .upcoming(days, now_ms())
            .map_err(|error| failed(&app, error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn reminder_get_due(
    app: AppHandle<Wry>,
) -> Result<Vec<ReminderWithTargetView>, CommandError> {
    blocking("reminder_get_due", move || {
        service(&app)?
            .due(now_ms())
            .map_err(|error| failed(&app, error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn reminder_get_for_target(
    app: AppHandle<Wry>,
    input: ReminderTargetInput,
) -> Result<Vec<ReminderView>, CommandError> {
    blocking("reminder_get_for_target", move || {
        service(&app)?
            .for_target(&input)
            .map_err(|error| failed(&app, error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn reminder_count_pending(app: AppHandle<Wry>) -> Result<u32, CommandError> {
    blocking("reminder_count_pending", move || {
        service(&app)?
            .count_pending()
            .map_err(|error| failed(&app, error))
    })
    .await
}
