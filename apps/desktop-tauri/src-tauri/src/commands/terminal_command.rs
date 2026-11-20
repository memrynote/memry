//! The `memrynote` terminal command: install, inspect and remove the shim, and pick the vault the
//! CLI uses by default. The four `settings:*TerminalCommand*` channels of
//! `apps/desktop/src/main/ipc/settings-handlers.ts`; the shim itself is `memrynote_cli::shim`.

use std::sync::Arc;

use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::registry::RegistryError;
use memry_desktop::session::Session;
use memry_desktop::telemetry::diagnostics::Failure;
use memrynote_cli::shim::{self, Platform, ShimError, ShimOptions, ShimStatus};
use serde::Serialize;
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use crate::shell::services::telemetry;

#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum TerminalCommandPlatform {
    Darwin,
    Linux,
    Win32,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommandVault {
    pub path: String,
    pub name: String,
    pub is_default: bool,
}

/// `TerminalCommandStatus` (`packages/rpc/src/settings.ts`).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommandStatus {
    pub supported: bool,
    pub installed: bool,
    pub command: String,
    pub platform: TerminalCommandPlatform,
    pub shim_path: String,
    pub bin_dir: String,
    pub target_path: String,
    pub in_path: bool,
    pub path_hint: Option<String>,
    pub default_vault_path: Option<String>,
    pub vaults: Vec<TerminalCommandVault>,
}

/// `TerminalCommandMutationResult`: `{ success: true, status }` or
/// `{ success: false, error, status? }`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommandMutationResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<TerminalCommandStatus>,
}

#[tauri::command]
#[specta::specta]
pub async fn settings_get_terminal_command_status(
    app: AppHandle<Wry>,
) -> Result<TerminalCommandStatus, CommandError> {
    let session = app.state::<Session>().inner().clone();
    blocking("settings_get_terminal_command_status", move || {
        terminal_status(&session).map_err(|error| {
            CommandError::new(
                ErrorKind::Storage,
                "terminal_command_status",
                error.to_string(),
            )
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn settings_install_terminal_command(
    app: AppHandle<Wry>,
) -> Result<TerminalCommandMutationResult, CommandError> {
    mutate(app, "terminal_command_install", shim::install).await
}

#[tauri::command]
#[specta::specta]
pub async fn settings_uninstall_terminal_command(
    app: AppHandle<Wry>,
) -> Result<TerminalCommandMutationResult, CommandError> {
    mutate(app, "terminal_command_uninstall", shim::uninstall).await
}

#[tauri::command]
#[specta::specta]
pub async fn settings_set_terminal_command_default_vault(
    app: AppHandle<Wry>,
    vault_path: String,
) -> Result<TerminalCommandMutationResult, CommandError> {
    let session = app.state::<Session>().inner().clone();
    let unknown_vault = i18n::t(
        app.state::<Arc<LocaleService>>().get(),
        "errors:settings.unknownVault",
        &Args::new(),
    );
    blocking(
        "settings_set_terminal_command_default_vault",
        move || match session.registry().set_default(&vault_path) {
            Ok(()) => Ok(succeeded(&session).unwrap_or_else(|error| failed(&session, error))),
            Err(RegistryError::NotRegistered(_)) => Ok(failed(&session, unknown_vault)),
            Err(error) => Err(CommandError::new(
                ErrorKind::Storage,
                "terminal_command_default_vault",
                error.to_string(),
            )),
        },
    )
    .await
}

async fn mutate(
    app: AppHandle<Wry>,
    action: &'static str,
    operation: fn(&ShimOptions) -> Result<ShimStatus, ShimError>,
) -> Result<TerminalCommandMutationResult, CommandError> {
    let session = app.state::<Session>().inner().clone();
    let outcome = blocking(action, move || {
        let attempt = ShimOptions::current()
            .map_err(ShimError::Io)
            .and_then(|options| operation(&options));
        Ok(match attempt {
            Ok(_) => succeeded(&session),
            Err(error) => Err(error.to_string()),
        }
        .unwrap_or_else(|error| failed(&session, error)))
    })
    .await?;
    if let (Some(error), Some(telemetry)) = (&outcome.error, telemetry(&app)) {
        telemetry.track_main_error("settings", action, &Failure::new(None, error.clone()));
    }
    Ok(outcome)
}

fn succeeded(session: &Session) -> Result<TerminalCommandMutationResult, String> {
    let status = terminal_status(session).map_err(|error| error.to_string())?;
    Ok(TerminalCommandMutationResult {
        success: true,
        error: None,
        status: Some(status),
    })
}

/// A failure carries the status when it can still be read (`getTerminalStatusSafely`).
fn failed(session: &Session, error: String) -> TerminalCommandMutationResult {
    let status = terminal_status(session)
        .inspect_err(|probe| tracing::warn!("terminal status probe failed: {probe}"))
        .ok();
    TerminalCommandMutationResult {
        success: false,
        error: Some(error),
        status,
    }
}

/// `getTerminalStatus`: the shim's state plus the registered vaults and the default one (the
/// only vault when none is marked).
fn terminal_status(session: &Session) -> Result<TerminalCommandStatus, ShimError> {
    let shim = shim::status(&ShimOptions::current()?)?;
    let vaults: Vec<TerminalCommandVault> = session
        .registry()
        .stored()
        .into_iter()
        .map(|vault| TerminalCommandVault {
            path: vault.path,
            name: vault.name,
            is_default: vault.is_default,
        })
        .collect();
    let default_vault_path = match vaults.iter().find(|vault| vault.is_default) {
        Some(vault) => Some(vault.path.clone()),
        None if vaults.len() == 1 => Some(vaults[0].path.clone()),
        None => None,
    };
    Ok(TerminalCommandStatus {
        supported: true,
        installed: shim.installed,
        command: shim::COMMAND_NAME.to_owned(),
        platform: match shim.platform {
            Platform::Darwin => TerminalCommandPlatform::Darwin,
            Platform::Linux => TerminalCommandPlatform::Linux,
            Platform::Win32 => TerminalCommandPlatform::Win32,
        },
        shim_path: shim.shim_path.to_string_lossy().into_owned(),
        bin_dir: shim.bin_dir.to_string_lossy().into_owned(),
        target_path: shim.target_path.to_string_lossy().into_owned(),
        in_path: shim.in_path,
        path_hint: shim.path_hint,
        default_vault_path,
        vaults,
    })
}
