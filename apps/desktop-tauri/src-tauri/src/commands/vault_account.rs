//! The account's vaults (`vault:list-account`, `vault:delete-from-account`,
//! `vault:download-remote`), over `memry_desktop::account::vault_directory`.

use std::path::PathBuf;
use std::sync::Arc;

use memry_desktop::account::AccountService;
use memry_desktop::account::vault_directory::{AccountVaultInfo as Listed, DownloadTarget};
use memry_desktop::session::Session;
use memry_desktop::session::response::SelectVaultResponse;
use memry_desktop::sync::telemetry::BootstrapSource;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::{CommandError, log_failure};
use super::vault::{default_parent, documents_dir, open_offering_repair};
use crate::events::{VaultListChangedEvent, broadcast};

/// `AccountVaultInfo` of `packages/contracts/src/vault-api.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountVaultInfo {
    pub vault_uuid: String,
    pub name: Option<String>,
    pub item_count: i64,
    pub created_at: Option<i64>,
    pub local_path: Option<String>,
    pub suggested_path: String,
}

impl From<Listed> for AccountVaultInfo {
    fn from(v: Listed) -> Self {
        Self {
            vault_uuid: v.vault_uuid,
            name: v.name,
            item_count: v.item_count,
            created_at: v.created_at,
            local_path: v.local_path,
            suggested_path: v.suggested_path,
        }
    }
}

fn parts(app: &AppHandle<Wry>) -> (Arc<AccountService>, Session) {
    (
        app.state::<Arc<AccountService>>().inner().clone(),
        app.state::<Session>().inner().clone(),
    )
}

async fn refresh(app: &AppHandle<Wry>, force: bool) {
    let (account, session) = parts(app);
    if account
        .refresh_vault_directory(session.registry(), force)
        .await
    {
        broadcast(app, VaultListChangedEvent);
    }
}

/// A forced refresh that the caller does not wait for (`vault:set-icon`).
pub(crate) fn refresh_in_background(app: AppHandle<Wry>) {
    tauri::async_runtime::spawn(async move { refresh(&app, true).await });
}

/// `vault:list-account`: refreshes the directory (throttled), then the cached list, which is
/// the last one read when offline.
#[tauri::command]
#[specta::specta]
pub async fn vault_list_account(
    app: AppHandle<Wry>,
) -> Result<Vec<AccountVaultInfo>, CommandError> {
    refresh(&app, false).await;
    let (account, session) = parts(&app);
    let parent = default_parent(&session, &documents_dir(&app)?);
    let listed = tauri::async_runtime::spawn_blocking(move || {
        account.list_account_vaults(session.registry(), &parent)
    })
    .await
    .map_err(|error| {
        let error = CommandError::new(
            super::error::ErrorKind::Internal,
            "list_account_vaults",
            error.to_string(),
        );
        log_failure("vault_list_account", &error);
        error
    })?;
    Ok(listed.into_iter().map(Into::into).collect())
}

/// `vault:delete-from-account`: removes the vault from the account and forgets its local entry;
/// files stay. The open vault is refused.
#[tauri::command]
#[specta::specta]
pub async fn vault_delete_from_account(
    app: AppHandle<Wry>,
    vault_uuid: String,
) -> Result<(), CommandError> {
    let (account, session) = parts(&app);
    account
        .delete_account_vault(&session, &vault_uuid)
        .await
        .map_err(|error| {
            let mapped = CommandError::from_core(&error);
            log_failure("vault_delete_from_account", &mapped);
            mapped
        })?;
    refresh(&app, true).await;
    Ok(())
}

/// `vault:download-remote` (`vault-directory.ts:266-318`): opens the registered copy of the
/// account vault, else makes its folder under `parent_path` (default: next to the current vault)
/// and opens that. A download that opens arms the new vault's bootstrap window from the moment
/// this call started, as `beginBootstrap` does before provisioning, and marks it interactive.
#[tauri::command]
#[specta::specta]
pub async fn vault_download_remote(
    app: AppHandle<Wry>,
    vault_uuid: String,
    parent_path: Option<String>,
) -> Result<SelectVaultResponse, CommandError> {
    let started = tokio::time::Instant::now();
    let (account, session) = parts(&app);
    let parent = match parent_path {
        Some(parent) => PathBuf::from(parent),
        None => default_parent(&session, &documents_dir(&app)?),
    };
    blocking("vault_download_remote", move || {
        let target = account
            .prepare_vault_download(&session, &vault_uuid, &parent)
            .map_err(|error| CommandError::from_core(&error))?;
        let (folder, downloaded) = match target {
            DownloadTarget::Existing(folder) => (folder, false),
            DownloadTarget::Provisioned(folder) => (folder, true),
        };
        let response = open_offering_repair(&app, &folder, |session| session.switch(&folder));
        if downloaded
            && response.success
            && let Some(supervisor) = session.sync_supervisor()
        {
            let bootstrap = supervisor.bootstrap();
            bootstrap.begin_since(BootstrapSource::VaultDownload, started);
            bootstrap.mark_interactive();
        }
        Ok(response)
    })
    .await
}
