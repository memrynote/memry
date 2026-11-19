//! Sync test commands: the gate inputs Steps 19 and 20 will own, the network switch, so a spec or
//! a live-app check can drive the status badge without an account server, and the sign-in against
//! the harness's local test server.

use std::sync::Arc;

use memry_desktop::account::AccountService;
use memry_desktop::account::e2e_bootstrap::E2eDevice;
use memry_desktop::account::vault_sync::{OpenVaultBinding, SyncWiring};
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::seams::reachability::DesktopReachability;
use memry_desktop::session::{Session, StartupOutcome};
use memry_desktop::sync::gate::{Entitlement, VaultBinding};
use serde::Serialize;
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::{CommandError, ErrorKind};
use crate::shell::account_sync;

fn invalid(code: &'static str, message: impl std::fmt::Display) -> CommandError {
    CommandError::new(ErrorKind::Invalid, code, message.to_string())
}

/// Sets the running supervisor's binding (`bound`, `local-only`, `needs-decision`, `foreign`,
/// `unknown`) and entitlement (`entitled`, `unentitled`, `unknown`). Fails with no supervisor.
#[tauri::command]
pub fn e2e_set_gate_inputs(
    app: AppHandle<Wry>,
    binding: String,
    entitlement: String,
) -> Result<(), CommandError> {
    let binding = match binding.as_str() {
        "bound" => VaultBinding::Bound,
        "local-only" => VaultBinding::LocalOnly,
        "needs-decision" => VaultBinding::NeedsDecision,
        "foreign" => VaultBinding::Foreign,
        "unknown" => VaultBinding::Unknown,
        other => return Err(invalid("e2e_gate_binding", other)),
    };
    let entitlement = match entitlement.as_str() {
        "entitled" => Entitlement::Entitled,
        "unentitled" => Entitlement::Unentitled,
        "unknown" => Entitlement::Unknown,
        other => return Err(invalid("e2e_gate_entitlement", other)),
    };
    let set = app
        .try_state::<Arc<OpenVaultBinding>>()
        .is_some_and(|bindings| bindings.set_gate_inputs(binding, entitlement));
    if set {
        Ok(())
    } else {
        Err(invalid(
            "e2e_no_supervisor",
            "no sync supervisor is running",
        ))
    }
}

/// Takes the network offline, as sleep does, or reads it again, as wake does (`network.ts`'s
/// test switch). A later OS address event can change it again.
#[tauri::command]
pub fn e2e_set_network_online(app: AppHandle<Wry>, online: bool) -> Result<(), CommandError> {
    let reachability = app
        .try_state::<Arc<DesktopReachability>>()
        .ok_or_else(|| invalid("e2e_no_reachability", "sync is not wired yet"))?;
    if online {
        reachability.on_power_resume();
    } else {
        reachability.on_power_suspend();
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrapped {
    device_id: String,
}

/// Electron's `bootstrapSyncDevice`: signs this device into the harness's account on the local
/// test server and binds the open vault to the account's vault, then attaches sync. The server is
/// the control file's `syncServerUrl`.
#[tauri::command]
pub async fn e2e_bootstrap_sync_device(
    app: AppHandle<Wry>,
    input: E2eDevice,
) -> Result<Bootstrapped, CommandError> {
    let session = app.state::<Session>().inner().clone();
    let open = session
        .current()
        .ok_or_else(|| invalid("e2e_no_vault", "no vault is open"))?;
    let account = app.state::<Arc<AccountService>>().inner().clone();
    let device_id = account
        .bootstrap_e2e_device(&open, session.registry(), input)
        .await
        .map_err(|e| invalid("e2e_bootstrap_sync_device", e))?;
    account_sync::attach_if_signed_in(app);
    Ok(Bootstrapped { device_id })
}

/// Electron's `restartSyncRuntimeForTests`, done the way an app restart does it: closes the open
/// vault, which stops its supervisor without the shutdown's final rounds, then opens the launch
/// vault again through `Session::open_startup`. The reopen reads the database's identity and
/// binding from disk, stamps the registry entry, and starts a new supervisor. Answers once that
/// supervisor runs; its bind and first pass run after. Fails while sync is not wired or the
/// account is signed out.
#[tauri::command]
pub async fn e2e_restart_sync_runtime(app: AppHandle<Wry>) -> Result<(), CommandError> {
    let wiring = app
        .try_state::<Arc<SyncWiring>>()
        .ok_or_else(|| invalid("e2e_no_sync", "sync is not wired yet"))?;
    if !wiring.account.info().signed_in {
        return Err(invalid("e2e_signed_out", "the account is signed out"));
    }
    let restarted = tauri::async_runtime::spawn_blocking(move || {
        let session = app.state::<Session>();
        session.close();
        match session.open_startup(&app.state::<LaunchEnv>()) {
            StartupOutcome::Opened(_) => Ok(session.sync_supervisor().is_some()),
            StartupOutcome::Picker => Err("no launch vault to reopen".to_owned()),
            StartupOutcome::Failed { error, .. } => Err(error.to_string()),
        }
    })
    .await
    .map_err(|e| invalid("e2e_restart_sync_runtime", e))?
    .map_err(|e| invalid("e2e_restart_sync_runtime", e))?;
    if restarted {
        Ok(())
    } else {
        Err(invalid("e2e_no_supervisor", "the reopened vault runs no supervisor"))
    }
}
