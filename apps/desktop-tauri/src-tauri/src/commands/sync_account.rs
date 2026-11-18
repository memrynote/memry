//! Sign-out and the open vault's account binding (`sync:auth-logout`, `account:sign-out`,
//! `sync:get-vault-binding`, `sync:resolve-vault-binding`).

use std::sync::Arc;

use memry_desktop::account::AccountService;
use memry_desktop::account::binding::BindingChoice;
use memry_desktop::account::vault_sync::{OpenVaultBinding, SyncWiring};
use memry_desktop::billing::BillingService;
use memry_desktop::session::Session;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::error::{CommandError, ErrorKind, log_failure};
use crate::events::{SyncVaultBindingChangedEvent, VaultBindingState, broadcast};

/// `{ success, keychainWarning? }` of both sign-out channels.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SignOutResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keychain_warning: Option<String>,
}

/// `VaultBindingChoice`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum VaultBindingChoice {
    Sync,
    Merge,
    Local,
}

/// `ResolveVaultBindingResult`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolveVaultBindingResult {
    pub success: bool,
    pub state: VaultBindingState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One teardown behind both channels (`teardownSession('logout')`): sync stops, the five
/// secrets go, `memry-config.json` `sync` empties; vaults and queued edits stay.
async fn sign_out<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
) -> Result<SignOutResult, CommandError> {
    let account = app.state::<Arc<AccountService>>().inner().clone();
    let session = app.state::<Session>().inner().clone();
    let signed_out = account.sign_out(&session).await;
    // A billing answer still in flight is the account's that left.
    if let Some(billing) = app.try_state::<Arc<BillingService>>() {
        billing.forget();
    }
    let signed_out = signed_out.map_err(|error| {
        let mapped = CommandError::from_core(&error);
        log_failure(command, &mapped);
        mapped
    })?;
    if let Some(bindings) = app.try_state::<Arc<OpenVaultBinding>>() {
        broadcast(
            app,
            SyncVaultBindingChangedEvent((&bindings.state()).into()),
        );
    }
    Ok(SignOutResult {
        success: true,
        keychain_warning: signed_out.keychain_warning(),
    })
}

/// `sync:auth-logout`.
#[tauri::command]
#[specta::specta]
pub async fn sync_logout<R: Runtime>(app: AppHandle<R>) -> Result<SignOutResult, CommandError> {
    sign_out(&app, "sync_logout").await
}

/// `account:sign-out`.
#[tauri::command]
#[specta::specta]
pub async fn account_sign_out<R: Runtime>(
    app: AppHandle<R>,
) -> Result<SignOutResult, CommandError> {
    sign_out(&app, "account_sign_out").await
}

/// `sync:get-vault-binding`: `bound` while no supervisor runs (signed out, no vault).
#[tauri::command]
#[specta::specta]
pub async fn sync_get_vault_binding(
    app: AppHandle<Wry>,
) -> Result<VaultBindingState, CommandError> {
    let state = app
        .try_state::<Arc<OpenVaultBinding>>()
        .map(|bindings| bindings.state())
        .unwrap_or(memry_desktop::account::binding::BindingState::Bound);
    Ok((&state).into())
}

/// `sync:resolve-vault-binding`: the user's answer to the binding prompt. A refused choice is
/// `success: false` with the state unchanged, as Electron answers.
#[tauri::command]
#[specta::specta]
pub async fn sync_resolve_vault_binding(
    app: AppHandle<Wry>,
    choice: VaultBindingChoice,
) -> Result<ResolveVaultBindingResult, CommandError> {
    let (Some(wiring), Some(open)) = (
        app.try_state::<Arc<SyncWiring>>()
            .map(|w| w.inner().clone()),
        app.state::<Session>().current(),
    ) else {
        let error = CommandError::new(ErrorKind::Invalid, "no_open_vault", "No vault is open");
        log_failure("sync_resolve_vault_binding", &error);
        return Err(error);
    };
    let choice = match choice {
        VaultBindingChoice::Sync => BindingChoice::Sync,
        VaultBindingChoice::Merge => BindingChoice::Merge,
        VaultBindingChoice::Local => BindingChoice::Local,
    };
    let resolved = tauri::async_runtime::spawn_blocking(move || {
        let outcome = wiring.resolve(&open, choice);
        (outcome, wiring.bindings.state())
    })
    .await
    .map_err(|e| CommandError::new(ErrorKind::Internal, "resolve_binding", e.to_string()))?;
    Ok(match resolved {
        (Ok(state), _) => ResolveVaultBindingResult {
            success: true,
            state: (&state).into(),
            error: None,
        },
        (Err(error), current) => {
            let mapped = CommandError::from_core(&error);
            log_failure("sync_resolve_vault_binding", &mapped);
            ResolveVaultBindingResult {
                success: false,
                state: (&current).into(),
                error: Some(mapped.message),
            }
        }
    })
}
