//! Sign-out, the device key repair and the open vault's account binding (`sync:auth-logout`,
//! `account:sign-out`, `sync:repair-device-keys`, `sync:get-vault-binding`,
//! `sync:resolve-vault-binding`).

use std::sync::Arc;

use memry_desktop::account::binding::BindingChoice;
use memry_desktop::account::vault_sync::{OpenVaultBinding, SyncWiring};
use memry_desktop::account::{AccountService, KeyRepair};
use memry_desktop::session::Session;
use memry_desktop::sync::gate::{GateDecision, SyncNotStartedReason};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::error::{CommandError, ErrorKind, log_failure};
use crate::events::{SyncVaultBindingChangedEvent, VaultBindingState, broadcast};
use crate::shell::account_sync::attach_if_signed_in;

/// `{ success, keychainWarning? }` of both sign-out channels.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SignOutResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keychain_warning: Option<String>,
}

/// `RepairDeviceKeysResult` (`ipc-sync-ops.ts`).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum RepairDeviceKeysResult {
    Repaired,
    SyncNotStarted { reason: SyncNotStartedReason },
    SignInRequired,
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
    let signed_out = account.sign_out(&session).await.map_err(|error| {
        let mapped = CommandError::from_core(&error);
        log_failure(command, &mapped);
        mapped
    })?;
    report_binding(app);
    Ok(SignOutResult {
        success: true,
        keychain_warning: signed_out.keychain_warning(),
    })
}

fn report_binding<R: Runtime>(app: &AppHandle<R>) {
    if let Some(bindings) = app.try_state::<Arc<OpenVaultBinding>>() {
        broadcast(
            app,
            SyncVaultBindingChangedEvent((&bindings.state()).into()),
        );
    }
}

/// `sync:repair-device-keys`: a listed device restarts sync and answers whether its gate lets it
/// run (`reasonSyncDidNotStart`, `device-registration.ts:400-413`); otherwise the device signed
/// out keeping its master key and queue.
#[tauri::command]
#[specta::specta]
pub async fn sync_repair_device_keys(
    app: AppHandle<Wry>,
) -> Result<RepairDeviceKeysResult, CommandError> {
    let account = app.state::<Arc<AccountService>>().inner().clone();
    let session = app.state::<Session>().inner().clone();
    let repaired = account.repair_device_keys(&session).await;
    // A teardown that failed after the keychain step still signed the account out: its binding
    // goes as for a finished one.
    if account.is_signed_out() {
        report_binding(&app);
    }
    let repaired = repaired.map_err(|error| {
        let mapped = CommandError::from_core(&error);
        log_failure("sync_repair_device_keys", &mapped);
        mapped
    })?;
    if repaired == KeyRepair::SignInRequired {
        return Ok(RepairDeviceKeysResult::SignInRequired);
    }
    let wiring = app
        .try_state::<Arc<SyncWiring>>()
        .map(|w| w.inner().clone());
    // Read off the running gate, whose binding is decided, before the restart replaces it. The
    // keychain read blocks: off the async workers. `attach_sync` rebuilds a running supervisor
    // and starts none while signed out.
    let decision = tauri::async_runtime::spawn_blocking(move || {
        wiring.map_or(
            GateDecision::NotStarted(SyncNotStartedReason::Unavailable),
            |wiring| wiring.start_decision(),
        )
    })
    .await
    .map_err(|e| CommandError::new(ErrorKind::Internal, "repair_device_keys", e.to_string()))?;
    attach_if_signed_in(app);
    Ok(match decision {
        GateDecision::Start => RepairDeviceKeysResult::Repaired,
        GateDecision::NotStarted(reason) => RepairDeviceKeysResult::SyncNotStarted { reason },
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
