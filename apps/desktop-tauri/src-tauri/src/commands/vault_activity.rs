//! The vault activity log (`vault-activity:*` of `ipc/vault-activity-handlers.ts`): list, clear,
//! retention and reveal. The log itself is `memry_desktop::vault::activity`, opened and closed
//! with the vault by the vault tier.

use std::sync::Arc;

use memry_desktop::vault::activity::{ActivityFilter, ActivityList, ActivityLog};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_opener::OpenerExt;

use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};

/// `ListVaultActivitySchema`: 1 to 1000 entries, 200 when not given.
const DEFAULT_LIMIT: u32 = 200;
const MAX_LIMIT: u32 = 1000;

fn activity(app: &AppHandle<Wry>) -> Arc<ActivityLog> {
    app.state::<Arc<ActivityLog>>().inner().clone()
}

/// The retained entries, newest first.
#[tauri::command]
#[specta::specta]
pub async fn vault_activity_list(
    app: AppHandle<Wry>,
    limit: Option<u32>,
    filter: Option<ActivityFilter>,
) -> Result<ActivityList, CommandError> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        let error = CommandError::new(
            ErrorKind::Invalid,
            "invalid_limit",
            format!("limit must be 1 to {MAX_LIMIT}"),
        );
        log_failure("vault_activity_list", &error);
        return Err(error);
    }
    let log = activity(&app);
    blocking("vault_activity_list", move || {
        Ok(log.list(limit as usize, filter.unwrap_or(ActivityFilter::All)))
    })
    .await
}

/// Drops every retained entry, on disk too.
#[tauri::command]
#[specta::specta]
pub async fn vault_activity_clear(app: AppHandle<Wry>) -> Result<(), CommandError> {
    let log = activity(&app);
    blocking("vault_activity_clear", move || {
        log.clear().map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// Keeps entries for `days` (7, 30 or 90).
#[tauri::command]
#[specta::specta]
pub async fn vault_activity_set_retention(
    app: AppHandle<Wry>,
    days: u32,
) -> Result<(), CommandError> {
    let log = activity(&app);
    blocking("vault_activity_set_retention", move || {
        log.set_retention(days)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// Shows the log file in Finder or Explorer, creating it first. `false` when no vault is open.
#[tauri::command]
#[specta::specta]
pub async fn vault_activity_reveal(app: AppHandle<Wry>) -> Result<bool, CommandError> {
    let log = activity(&app);
    let Some(path) = blocking("vault_activity_reveal", move || Ok(log.prepare_file())).await?
    else {
        return Ok(false);
    };
    let path = path.to_string_lossy().into_owned();
    #[cfg(feature = "e2e")]
    if crate::e2e::record_reveal(&app, &path) {
        return Ok(true);
    }
    app.opener().reveal_item_in_dir(&path).map_err(|error| {
        let error = CommandError::new(ErrorKind::Internal, "reveal_failed", error.to_string());
        log_failure("vault_activity_reveal", &error);
        error
    })?;
    Ok(true)
}
